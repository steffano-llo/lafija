import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reminder, user, userSettings } from "@/db/schema";
import type { OutgoingEmail, ReminderMailer } from "@/lib/email/types";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { createApplication, setApplicationArchived } = await import("./applications");
const { snoozeReminder, setReminderDone, listApplicationReminders } = await import("./reminders");
const { setEmailReminders } = await import("./settings");
const { sendDueReminderEmails, claimDueRemindersSql } = await import("./reminder-emails");
const { reminderEmailProblems } = await import("@/lib/email/eligibility");

const mailerConfig = {
  currentSigningKey: "cur",
  nextSigningKey: "next",
  resendApiKey: "re_test",
  from: "laFija <onboarding@resend.dev>",
  appUrl: "https://lafija.example",
  cronUrl: "https://lafija.example/api/cron/reminders",
};

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

let db: TestDb;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

// Every test starts from no due reminders, so each run only sees the rows that test created.
beforeEach(async () => {
  await db.execute(sql`delete from "reminder"`);
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const APP_URL = "https://lafija.example";

/** A user whose address is verified unless `verified: false` (S17: only verified addresses get email). */
async function newUser(email?: string, { verified = true }: { verified?: boolean } = {}) {
  counter += 1;
  const id = `mail-user-${counter}`;
  const address = email ?? `mail${counter}@example.com`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: address, emailVerified: verified });
  return { id, email: address };
}

async function newApplication(userId: string, companyName = "Acme", role = "Engineer") {
  const result = await createApplication(db, userId, { companyName, role });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

/** A manual reminder due `ago` milliseconds before now (negative = in the future). */
async function dueReminder(userId: string, applicationId: string, message: string, ago = HOUR) {
  const [row] = await db
    .insert(reminder)
    .values({ userId, applicationId, kind: "manual", message, dueAt: new Date(Date.now() - ago) })
    .returning();
  return row;
}

type FakeMailer = ReminderMailer & { sent: OutgoingEmail[]; failFor: Set<string> };

function fakeMailer(addresses: string[] | "*"): FakeMailer {
  const sent: OutgoingEmail[] = [];
  const failFor = new Set<string>();
  return {
    appUrl: APP_URL,
    recipients: addresses === "*" ? { everyone: true, addresses: [] } : { everyone: false, addresses },
    sent,
    failFor,
    async send(email) {
      if (failFor.has(email.to)) return { ok: false, error: "provider refused" };
      sent.push(email);
      return { ok: true };
    },
  };
}

async function sentAtOf(id: string) {
  const [row] = await db.select({ sentAt: reminder.sentAt }).from(reminder).where(eq(reminder.id, id));
  return row?.sentAt ?? null;
}

describe("sendDueReminderEmails: what is claimed", () => {
  it("claims only due, open, unsent reminders of non-archived applications, and emails them in one digest", async () => {
    const alice = await newUser();
    const app = await newApplication(alice.id, "Globex", "Data Engineer");
    const archivedApp = await newApplication(alice.id, "Initech", "Analyst");
    const due = await dueReminder(alice.id, app.id, "Send portfolio");
    const due2 = await dueReminder(alice.id, app.id, "Call Ana", 2 * HOUR);
    const future = await dueReminder(alice.id, app.id, "Later", -HOUR);
    const done = await dueReminder(alice.id, app.id, "Done already");
    await setReminderDone(db, alice.id, done.id, true);
    const alreadySent = await dueReminder(alice.id, app.id, "Sent already");
    await db.update(reminder).set({ sentAt: new Date(Date.now() - HOUR) }).where(eq(reminder.id, alreadySent.id));
    const onArchived = await dueReminder(alice.id, archivedApp.id, "On archived");
    await setApplicationArchived(db, alice.id, archivedApp.id, true);
    const mailer = fakeMailer([alice.email]);

    const summary = await sendDueReminderEmails(db, mailer);

    expect(summary).toEqual({ claimed: 2, sent: 2, failed: 0, skipped: 0 });
    expect(mailer.sent).toHaveLength(1);
    const [email] = mailer.sent;
    expect(email.to).toBe(alice.email);
    expect(email.subject).toBe("2 reminders due on laFija");
    // Oldest due first.
    expect(email.text.indexOf("Call Ana")).toBeLessThan(email.text.indexOf("Send portfolio"));
    expect(email.text).toContain("Globex");
    expect(email.text).toContain("Data Engineer");
    expect(email.text).toContain(`${APP_URL}/dashboard/applications/${app.id}`);
    expect(email.text).toContain(`${APP_URL}/dashboard/reminders`);
    expect(email.html).toContain(`href="${APP_URL}/dashboard/applications/${app.id}"`);
    expect(email.html).toContain(`href="${APP_URL}/dashboard/reminders"`);
    for (const absent of ["Later", "Done already", "Sent already", "On archived"]) {
      expect(email.text).not.toContain(absent);
      expect(email.html).not.toContain(absent);
    }
    expect(await sentAtOf(due.id)).not.toBeNull();
    expect(await sentAtOf(due2.id)).not.toBeNull();
    expect(await sentAtOf(future.id)).toBeNull();
    expect(await sentAtOf(done.id)).toBeNull();
    expect(await sentAtOf(onArchived.id)).toBeNull();
  });

  it("uses a singular subject for one reminder", async () => {
    const bob = await newUser();
    const app = await newApplication(bob.id);
    await dueReminder(bob.id, app.id, "Only one");
    const mailer = fakeMailer([bob.email]);

    await sendDueReminderEmails(db, mailer);

    expect(mailer.sent.map((e) => e.subject)).toEqual(["1 reminder due on laFija"]);
  });

  it("never claims reminders of users who are not allowed or opted out: they stay unsent and are counted as skipped", async () => {
    const allowed = await newUser();
    const notAllowed = await newUser();
    const optedOut = await newUser();
    const allowedApp = await newApplication(allowed.id);
    const notAllowedApp = await newApplication(notAllowed.id);
    const optedOutApp = await newApplication(optedOut.id);
    const a = await dueReminder(allowed.id, allowedApp.id, "Allowed one");
    const b = await dueReminder(notAllowed.id, notAllowedApp.id, "Not allowed one");
    const c = await dueReminder(optedOut.id, optedOutApp.id, "Opted out one");
    expect(await setEmailReminders(db, optedOut.id, { emailReminders: false })).toEqual({ ok: true, emailReminders: false });
    // Case-insensitive allowlist match.
    const mailer = fakeMailer([allowed.email.toUpperCase(), optedOut.email]);

    const summary = await sendDueReminderEmails(db, mailer);

    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 2 });
    expect(mailer.sent.map((e) => e.to)).toEqual([allowed.email]);
    expect(await sentAtOf(a.id)).not.toBeNull();
    expect(await sentAtOf(b.id)).toBeNull();
    expect(await sentAtOf(c.id)).toBeNull();
  });

  it("matches the allowlist case-insensitively against the stored address", async () => {
    const carol = await newUser(`Carol.${counter + 1}@Example.COM`);
    const app = await newApplication(carol.id);
    await dueReminder(carol.id, app.id, "Case");
    const mailer = fakeMailer([carol.email.toLowerCase()]);

    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(mailer.sent.map((e) => e.to)).toEqual([carol.email]);
  });

  it("with an empty allowlist claims nothing and sends nothing", async () => {
    const dave = await newUser();
    const app = await newApplication(dave.id);
    const r = await dueReminder(dave.id, app.id, "Nobody");
    const mailer = fakeMailer([]);

    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 1 });
    expect(mailer.sent).toEqual([]);
    expect(await sentAtOf(r.id)).toBeNull();
  });

  it("with * emails every opted-in user whose address is verified, and skips unverified addresses", async () => {
    const verified = await newUser();
    const unverified = await newUser(undefined, { verified: false });
    const vApp = await newApplication(verified.id);
    const uApp = await newApplication(unverified.id);
    await dueReminder(verified.id, vApp.id, "Verified");
    const u = await dueReminder(unverified.id, uApp.id, "Unverified");
    const mailer = fakeMailer("*");

    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 1 });
    expect(mailer.sent.map((e) => e.to)).toEqual([verified.email]);
    expect(await sentAtOf(u.id)).toBeNull();
  });
});

describe("sendDueReminderEmails: the S17 recipient rule", () => {
  it("does not email a listed address that is not verified", async () => {
    const listed = await newUser(undefined, { verified: false });
    const app = await newApplication(listed.id);
    const r = await dueReminder(listed.id, app.id, "Listed but unverified");
    const mailer = fakeMailer([listed.email]);

    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 1 });
    expect(mailer.sent).toEqual([]);
    expect(await sentAtOf(r.id)).toBeNull();
  });

  // Configured is implied by running the job (without configuration the cron answers 503); the other
  // three conditions are crossed here, and the outcome must agree with what Settings explains.
  const matrix = (["*", "listed", "not listed"] as const).flatMap((allowlist) =>
    [true, false].flatMap((verified) => [true, false].map((emailOn) => ({ allowlist, verified, emailOn }))),
  );

  it.each(matrix)("allowlist $allowlist, verified=$verified, switch=$emailOn", async ({ allowlist, verified, emailOn }) => {
    const subject = await newUser(undefined, { verified });
    if (!emailOn) await setEmailReminders(db, subject.id, { emailReminders: false });
    const app = await newApplication(subject.id);
    const r = await dueReminder(subject.id, app.id, "Matrix");
    const mailer = fakeMailer(
      allowlist === "*" ? "*" : allowlist === "listed" ? [subject.email] : ["someone-else@example.com"],
    );
    const expected = verified && emailOn && allowlist !== "not listed";

    const summary = await sendDueReminderEmails(db, mailer);

    expect(summary).toEqual(
      expected ? { claimed: 1, sent: 1, failed: 0, skipped: 0 } : { claimed: 0, sent: 0, failed: 0, skipped: 1 },
    );
    expect(mailer.sent.map((e) => e.to)).toEqual(expected ? [subject.email] : []);
    expect((await sentAtOf(r.id)) !== null).toBe(expected);
    const problems = reminderEmailProblems({
      state: { ok: true, config: { ...mailerConfig, recipients: mailer.recipients } },
      email: subject.email,
      emailVerified: verified,
      emailReminders: emailOn,
    });
    expect(problems.length === 0).toBe(expected);
  });
});

describe("sendDueReminderEmails: digests", () => {
  it("sends one digest per user that lists only that user's reminders", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const aliceApp = await newApplication(alice.id, "AliceCo", "Alice Role");
    const bobApp = await newApplication(bob.id, "BobCo", "Bob Role");
    await dueReminder(alice.id, aliceApp.id, "Alice first");
    await dueReminder(alice.id, aliceApp.id, "Alice second");
    await dueReminder(bob.id, bobApp.id, "Bob only");
    const mailer = fakeMailer([alice.email, bob.email]);

    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 3, sent: 3, failed: 0, skipped: 0 });

    expect(mailer.sent).toHaveLength(2);
    const toAlice = mailer.sent.find((e) => e.to === alice.email);
    const toBob = mailer.sent.find((e) => e.to === bob.email);
    expect(toAlice?.subject).toBe("2 reminders due on laFija");
    expect(toBob?.subject).toBe("1 reminder due on laFija");
    for (const body of [toAlice?.text ?? "", toAlice?.html ?? ""]) {
      expect(body).toContain("Alice first");
      expect(body).toContain("Alice second");
      expect(body).not.toContain("Bob");
      expect(body).not.toContain(bobApp.id);
    }
    for (const body of [toBob?.text ?? "", toBob?.html ?? ""]) {
      expect(body).toContain("Bob only");
      expect(body).not.toContain("Alice");
      expect(body).not.toContain(aliceApp.id);
    }
    expect(toAlice?.idempotencyKey).not.toBe(toBob?.idempotencyKey);
  });

  it("escapes company, role and message in the HTML and keeps them verbatim in the text", async () => {
    const eve = await newUser();
    const app = await newApplication(eve.id, `<b>Evil & Co</b>`, `"Role" <script>x</script>`);
    await dueReminder(eve.id, app.id, `Click <a href='https://bad'>here</a> & go`);
    const mailer = fakeMailer([eve.email]);

    await sendDueReminderEmails(db, mailer);

    const [email] = mailer.sent;
    expect(email.html).not.toContain("<b>Evil");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<a href='https://bad'>");
    expect(email.html).toContain("&lt;b&gt;Evil &amp; Co&lt;/b&gt;");
    expect(email.html).toContain("&quot;Role&quot; &lt;script&gt;x&lt;/script&gt;");
    expect(email.html).toContain("Click &lt;a href=&#39;https://bad&#39;&gt;here&lt;/a&gt; &amp; go");
    expect(email.text).toContain(`<b>Evil & Co</b>`);
    expect(email.text).toContain(`Click <a href='https://bad'>here</a> & go`);
  });

  it("gives the same idempotency key for the same user and claimed reminders, and another one when the set differs", async () => {
    const frank = await newUser();
    const app = await newApplication(frank.id);
    const r = await dueReminder(frank.id, app.id, "Retry me");
    const mailer = fakeMailer([frank.email]);
    mailer.failFor.add(frank.email);

    await sendDueReminderEmails(db, mailer);
    mailer.failFor.clear();
    await sendDueReminderEmails(db, mailer);
    const firstKey = mailer.sent[0]?.idempotencyKey;
    expect(firstKey).toMatch(/^[A-Za-z0-9/_-]{1,256}$/);

    // A retry of the same claim (same reminders, same due times) reuses the key.
    await db.update(reminder).set({ sentAt: null }).where(eq(reminder.id, r.id));
    await sendDueReminderEmails(db, mailer);
    expect(mailer.sent[1]?.idempotencyKey).toBe(firstKey);

    // Snoozing changes the due time, so the re-send is a new email.
    await snoozeReminder(db, frank.id, r.id, "1");
    await sendDueReminderEmails(db, mailer, new Date(Date.now() + DAY + HOUR));
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.sent[2]?.idempotencyKey).not.toBe(firstKey);
  });
});

describe("sendDueReminderEmails: failures and re-runs", () => {
  it("releases only the failing user's claims; other users stay sent", async () => {
    const ok = await newUser();
    const failing = await newUser();
    const okApp = await newApplication(ok.id);
    const failingApp = await newApplication(failing.id);
    const okReminder = await dueReminder(ok.id, okApp.id, "Works");
    const failing1 = await dueReminder(failing.id, failingApp.id, "Fails 1");
    const failing2 = await dueReminder(failing.id, failingApp.id, "Fails 2");
    const mailer = fakeMailer([ok.email, failing.email]);
    mailer.failFor.add(failing.email);

    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 3, sent: 1, failed: 2, skipped: 0 });

    expect(await sentAtOf(okReminder.id)).not.toBeNull();
    expect(await sentAtOf(failing1.id)).toBeNull();
    expect(await sentAtOf(failing2.id)).toBeNull();

    // The next run retries the failed user only.
    mailer.failFor.clear();
    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 2, sent: 2, failed: 0, skipped: 0 });
    expect(mailer.sent.map((e) => e.to)).toEqual([ok.email, failing.email]);
  });

  it("treats a sender that throws like a failed send", async () => {
    const gina = await newUser();
    const app = await newApplication(gina.id);
    const r = await dueReminder(gina.id, app.id, "Throws");
    const mailer = fakeMailer([gina.email]);
    mailer.send = async () => {
      throw new Error("network down");
    };

    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 1, sent: 0, failed: 1, skipped: 0 });
    expect(await sentAtOf(r.id)).toBeNull();
  });

  it("sends nothing new on a second run", async () => {
    const hank = await newUser();
    const app = await newApplication(hank.id);
    await dueReminder(hank.id, app.id, "Once");
    const mailer = fakeMailer([hank.email]);

    await sendDueReminderEmails(db, mailer);
    const second = await sendDueReminderEmails(db, mailer);

    expect(second).toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
    expect(mailer.sent).toHaveLength(1);
  });

  it("sends a snoozed reminder again once it falls due, and not before", async () => {
    const ivy = await newUser();
    const app = await newApplication(ivy.id);
    const r = await dueReminder(ivy.id, app.id, "Snoozed one");
    const mailer = fakeMailer([ivy.email]);
    await sendDueReminderEmails(db, mailer);
    expect(await sentAtOf(r.id)).not.toBeNull();

    await snoozeReminder(db, ivy.id, r.id, "1");
    expect(await sentAtOf(r.id)).toBeNull();
    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 0 });

    expect(await sendDueReminderEmails(db, mailer, new Date(Date.now() + DAY + HOUR))).toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      skipped: 0,
    });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]?.text).toContain("Snoozed one");
  });

  it("claims at most the batch size per run, oldest due first", async () => {
    const jack = await newUser();
    const app = await newApplication(jack.id);
    for (let i = 0; i < 5; i += 1) await dueReminder(jack.id, app.id, `Batch ${i}`, (10 - i) * HOUR);
    const mailer = fakeMailer([jack.email]);

    expect(await sendDueReminderEmails(db, mailer, new Date(), { batchSize: 3 })).toEqual({
      claimed: 3,
      sent: 3,
      failed: 0,
      skipped: 0,
    });
    expect(mailer.sent[0]?.text).toContain("Batch 0");
    expect(mailer.sent[0]?.text).not.toContain("Batch 3");
    expect(await sendDueReminderEmails(db, mailer, new Date(), { batchSize: 3 })).toEqual({
      claimed: 2,
      sent: 2,
      failed: 0,
      skipped: 0,
    });
  });

  it("skips locked rows instead of waiting (FOR UPDATE SKIP LOCKED in the claim)", async () => {
    const kim = await newUser();
    const app = await newApplication(kim.id);
    await dueReminder(kim.id, app.id, "Locked");
    const mailer = fakeMailer([kim.email]);
    // PGlite has one connection, so the lock cannot be held by another session here; the claim
    // statement is checked for the clause instead (concurrency is by Postgres semantics).
    const claim = claimDueRemindersSql({ now: new Date(), recipients: mailer.recipients, batchSize: 10 });
    const { sql: text } = new PgDialect().sqlToQuery(claim);
    expect(text).toMatch(/for update of r skip locked/i);
    expect(text).toMatch(/limit/i);
    expect(await sendDueReminderEmails(db, mailer)).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
  });
});

describe("claim lease (S19)", () => {
  const MINUTE = 60 * 1000;

  async function claimOf(id: string) {
    const [row] = await db
      .select({ sentAt: reminder.sentAt, claimedAt: reminder.emailClaimedAt })
      .from(reminder)
      .where(eq(reminder.id, id));
    return row;
  }

  /** A mailer whose sends wait until `release()`: lets a test look at the rows mid-send (or never finish). */
  function pausedMailer(addresses: string[]) {
    const sent: OutgoingEmail[] = [];
    let release: (result: { ok: true } | { ok: false; error: string }) => void = () => {};
    let started: () => void = () => {};
    const sending = new Promise<void>((resolve) => (started = resolve));
    const mailer: ReminderMailer = {
      appUrl: APP_URL,
      recipients: { everyone: false, addresses },
      send(email) {
        sent.push(email);
        started();
        return new Promise((resolve) => (release = resolve));
      },
    };
    return { mailer, sent, sending, release: (result: { ok: true } | { ok: false; error: string }) => release(result) };
  }

  it("after a crash between claim and send, re-claims only once the 30-minute lease expires, with the same idempotency key", async () => {
    const ola = await newUser();
    const app = await newApplication(ola.id);
    const r = await dueReminder(ola.id, app.id, "Crash me");
    const t0 = new Date();
    const crashed = pausedMailer([ola.email]);

    // The run claims and starts sending, then the process dies: the send never finishes.
    void sendDueReminderEmails(db, crashed.mailer, t0);
    await crashed.sending;
    expect(await claimOf(r.id)).toEqual({ sentAt: null, claimedAt: t0 });

    const mailer = fakeMailer([ola.email]);
    expect(await sendDueReminderEmails(db, mailer, new Date(t0.getTime() + 29 * MINUTE))).toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(await claimOf(r.id)).toEqual({ sentAt: null, claimedAt: t0 });

    const later = new Date(t0.getTime() + 31 * MINUTE);
    expect(await sendDueReminderEmails(db, mailer, later)).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(await claimOf(r.id)).toEqual({ sentAt: later, claimedAt: null });
    // Resend drops the second send within its window if the first one had been delivered.
    expect(mailer.sent[0]?.idempotencyKey).toBe(crashed.sent[0]?.idempotencyKey);
  });

  it("a second claimer cannot take leased rows", async () => {
    const pia = await newUser();
    const app = await newApplication(pia.id);
    const r = await dueReminder(pia.id, app.id, "Leased");
    const t0 = new Date();
    const recipients = { everyone: false, addresses: [pia.email] };

    const first = await db.execute(claimDueRemindersSql({ now: t0, recipients, batchSize: 10 }));
    const second = await db.execute(
      claimDueRemindersSql({ now: new Date(t0.getTime() + MINUTE), recipients, batchSize: 10 }),
    );

    expect((first as unknown as { rows: { id: string }[] }).rows.map((row) => row.id)).toEqual([r.id]);
    expect((second as unknown as { rows: unknown[] }).rows).toEqual([]);
    expect(await claimOf(r.id)).toEqual({ sentAt: null, claimedAt: t0 });
  });

  it("on success sets sent_at and clears the claim; a failure releases only this run's claims", async () => {
    const quin = await newUser();
    const app = await newApplication(quin.id);
    const leasedByOther = await dueReminder(quin.id, app.id, "Leased by another run", 2 * HOUR);
    const mine = await dueReminder(quin.id, app.id, "Mine");
    const t0 = new Date();
    const recipients = { everyone: false, addresses: [quin.email] };
    // Another (crashed) run leased the first one only.
    await db.execute(claimDueRemindersSql({ now: t0, recipients, batchSize: 1 }));
    expect(await claimOf(leasedByOther.id)).toEqual({ sentAt: null, claimedAt: t0 });

    const failing = fakeMailer([quin.email]);
    failing.failFor.add(quin.email);
    const t1 = new Date(t0.getTime() + 5 * MINUTE);
    expect(await sendDueReminderEmails(db, failing, t1)).toEqual({ claimed: 1, sent: 0, failed: 1, skipped: 0 });
    expect(await claimOf(mine.id)).toEqual({ sentAt: null, claimedAt: null });
    expect(await claimOf(leasedByOther.id)).toEqual({ sentAt: null, claimedAt: t0 });

    const ok = fakeMailer([quin.email]);
    const t2 = new Date(t0.getTime() + 6 * MINUTE);
    expect(await sendDueReminderEmails(db, ok, t2)).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(await claimOf(mine.id)).toEqual({ sentAt: t2, claimedAt: null });
    expect(await claimOf(leasedByOther.id)).toEqual({ sentAt: null, claimedAt: t0 });
  });

  it("a reminder snoozed while its email is being sent is not marked sent by that run", async () => {
    const rae = await newUser();
    const app = await newApplication(rae.id);
    const r = await dueReminder(rae.id, app.id, "Snoozed mid-send");
    const paused = pausedMailer([rae.email]);

    const run = sendDueReminderEmails(db, paused.mailer);
    await paused.sending;
    await snoozeReminder(db, rae.id, r.id, "1");
    paused.release({ ok: true });
    await run;

    expect(await claimOf(r.id)).toEqual({ sentAt: null, claimedAt: null });
  });

  it("snoozing and editing the due time clear both sent_at and the claim; a same-minute edit keeps them", async () => {
    const { updateReminder } = await import("./reminders");
    const sam = await newUser();
    const app = await newApplication(sam.id);
    const r = await dueReminder(sam.id, app.id, "Clear me");
    const at = new Date(Date.now() - MINUTE);
    const set = (sentAt: Date | null, claimedAt: Date | null) =>
      db.update(reminder).set({ sentAt, emailClaimedAt: claimedAt }).where(eq(reminder.id, r.id));

    await set(at, at);
    await snoozeReminder(db, sam.id, r.id, "3");
    expect(await claimOf(r.id)).toEqual({ sentAt: null, claimedAt: null });

    await set(at, at);
    const [{ dueAt }] = await db.select({ dueAt: reminder.dueAt }).from(reminder).where(eq(reminder.id, r.id));
    await updateReminder(db, sam.id, r.id, { dueAt: dueAt.toISOString(), message: "Only the message" });
    expect(await claimOf(r.id)).toEqual({ sentAt: at, claimedAt: at });

    await updateReminder(db, sam.id, r.id, {
      dueAt: new Date(dueAt.getTime() + DAY).toISOString(),
      message: "New due time",
    });
    expect(await claimOf(r.id)).toEqual({ sentAt: null, claimedAt: null });
  });
});

describe("email reminders setting", () => {
  it("is on by default, per user, and validated", async () => {
    const { getEmailReminders } = await import("./settings");
    const lee = await newUser();
    const max = await newUser();
    expect(await getEmailReminders(db, lee.id)).toBe(true);

    expect(await setEmailReminders(db, lee.id, { emailReminders: false })).toEqual({ ok: true, emailReminders: false });
    expect(await getEmailReminders(db, lee.id)).toBe(false);
    expect(await getEmailReminders(db, max.id)).toBe(true);

    const before = JSON.stringify(await db.select().from(userSettings).orderBy(userSettings.userId));
    for (const bad of [undefined, null, {}, { emailReminders: "false" }, { emailReminders: 1 }]) {
      expect(await setEmailReminders(db, max.id, bad)).toEqual({
        ok: false,
        reason: "invalid",
        fieldErrors: { emailReminders: ["Choose on or off."] },
      });
    }
    expect(JSON.stringify(await db.select().from(userSettings).orderBy(userSettings.userId))).toBe(before);

    expect(await setEmailReminders(db, lee.id, { emailReminders: true })).toEqual({ ok: true, emailReminders: true });
    expect(await getEmailReminders(db, lee.id)).toBe(true);
  });

  it("keeps the other settings when toggled", async () => {
    const { getUserSettings, setDefaultCurrency } = await import("./settings");
    const ned = await newUser();
    await setDefaultCurrency(db, ned.id, { defaultCurrency: "EUR" });
    await setEmailReminders(db, ned.id, { emailReminders: false });
    expect(await getUserSettings(db, ned.id)).toEqual({ followUpDays: 7, timeZone: null, defaultCurrency: "EUR" });
    // Reminders still show in-app regardless of the email switch.
    const app = await newApplication(ned.id);
    await dueReminder(ned.id, app.id, "In-app only");
    expect((await listApplicationReminders(db, ned.id, app.id))?.some((r) => r.message === "In-app only")).toBe(true);
  });
});

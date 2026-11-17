import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoAccount, user } from "@/db/schema";
import { createAuth, getUserFromHeaders, type Auth } from "@/lib/auth";
import { reminderEmailProblems, emailProblemMessage } from "@/lib/email/eligibility";
import type { OutgoingEmail, SendResult } from "@/lib/email/types";
import { createSendVerificationEmail, resendVerificationEmail } from "@/lib/email/verification";
import type { EmailConfig, EmailState } from "@/lib/env";
import { SOURCE_PRESETS } from "@/lib/validation/source";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { createDemoAccount, demoErrorMessage, getDemoAccount, DEMO_ACCOUNT_LIMIT } = await import("./demo");
const { listBoard, rowsOf } = await import("./board");
const { getApplication, listApplications } = await import("./applications");
const { countDueReminders, listReminders } = await import("./reminders");
const { getStats } = await import("./stats");
const { sendDueReminderEmails } = await import("./reminder-emails");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-with-at-least-thirty-two-chars";

const sent: OutgoingEmail[] = [];
const sender = {
  async send(email: OutgoingEmail): Promise<SendResult> {
    sent.push(email);
    return { ok: true };
  },
};
const everyone = { everyone: true, addresses: [] };
const config: EmailConfig = {
  currentSigningKey: "cur",
  nextSigningKey: "next",
  resendApiKey: "re_test",
  from: "laFija <onboarding@resend.dev>",
  recipients: everyone,
  appUrl: BASE_URL,
  cronUrl: `${BASE_URL}/api/cron/reminders`,
};
const state: EmailState = { ok: true, config };

let auth: Auth;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // Email delivery configured for everyone (`*`): demo users must still never get anything.
  auth = createAuth({
    db,
    secret: SECRET,
    baseURL: BASE_URL,
    google: { clientId: "id", clientSecret: "secret" },
    emailDelivery: { recipients: everyone, sender },
  });
});

afterAll(async () => {
  await close();
});

function cookieHeader(headers: Headers) {
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function newDemo(options: Partial<Parameters<typeof createDemoAccount>[2]> = {}) {
  const result = await createDemoAccount(auth, db, { baseURL: BASE_URL, clientIp: null, ...options });
  if (!result.ok) throw new Error(`demo creation failed: ${result.reason}`);
  return result;
}

async function signedInHeaders(email: string, password: string) {
  const { headers } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return new Headers({ cookie: cookieHeader(headers) });
}

async function tableCounts(): Promise<Record<string, number>> {
  const tables = rowsOf<{ name: string }>(
    await db.execute(sql`select table_name as "name" from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`),
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as "n" from ${sql.identifier(name)}`));
    counts[name] = row.n;
  }
  return counts;
}

describe("creating a demo account (S6)", () => {
  it("creates a demo user that can sign in, with a 24-hour demo row", async () => {
    const before = Date.now();
    const result = await newDemo();

    expect(result.email).toMatch(/^demo-[a-z0-9]{16,}@demo\.lafija\.invalid$/);
    expect(result.password.length).toBeGreaterThanOrEqual(24);
    const signedIn = await getUserFromHeaders(auth, await signedInHeaders(result.email, result.password));
    expect(signedIn).toMatchObject({ id: result.userId, email: result.email });

    const account = await getDemoAccount(db, result.userId);
    expect(account).not.toBeNull();
    expect(account!.expiresAt.getTime() - account!.createdAt.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(account!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result.expiresAt.getTime()).toBe(account!.expiresAt.getTime());
    expect(account!.msLeft).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(account!.msLeft).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("seeds a lively, deterministic search: stages, applications, history, interviews, contacts and reminders", async () => {
    const now = new Date();
    const { userId } = await newDemo({ now });

    const board = await listBoard(db, userId);
    expect(board.columns.map((column) => [column.name, column.category, column.cards.length])).toEqual([
      ["Wishlist", "wishlist", 2],
      ["Applied", "active", 6],
      ["Screening", "active", 2],
      ["Interview", "active", 2],
      ["Offer", "offer", 1],
      ["Rejected", "rejected", 5],
      ["Accepted", "accepted", 1],
      ["Withdrawn", "withdrawn", 1],
    ]);

    const applications = await listApplications(db, userId);
    expect(applications).toHaveLength(20);
    for (const app of applications) {
      expect(SOURCE_PRESETS as readonly (string | null)[]).toContain(app.source);
      expect(app.salaryRange === null).toBe(app.salaryCurrency === null);
    }
    expect(applications.filter((app) => app.salaryRange !== null).length).toBeGreaterThanOrEqual(8);
    // Applied dates span roughly the last ten weeks; wishlist cards have none.
    const appliedDays = applications
      .filter((app) => app.appliedAt !== null)
      .map((app) => (now.getTime() - Date.parse(`${app.appliedAt}T12:00:00Z`)) / 86_400_000);
    expect(appliedDays).toHaveLength(18);
    expect(Math.max(...appliedDays)).toBeGreaterThan(60);
    expect(Math.max(...appliedDays)).toBeLessThan(75);

    const stats = await getStats(db, userId, { now });
    expect(stats.totalApplications).toBe(20);
    expect(stats.notAppliedYet).toBe(2);
    expect(stats.responseRate.total).toBe(18);
    expect(stats.responseRate.responded).toBeGreaterThan(0);
    expect(stats.funnel).toMatchObject({ offer: 2, accepted: 1 });
    expect(stats.weekly.filter((week) => week.count > 0).length).toBeGreaterThanOrEqual(6);
    expect(stats.sources.length).toBeGreaterThanOrEqual(5);
    expect(stats.averageTimeInStage.some((row) => row.samples > 0)).toBe(true);

    const counts = rowsOf<{ past: number; pastPending: number; upcoming: number; upcomingPending: number; links: number; contacts: number }>(
      await db.execute(sql`select
        (select count(*)::int from "interview" where "user_id" = ${userId} and "scheduled_at" < now()) as "past",
        (select count(*)::int from "interview" where "user_id" = ${userId} and "scheduled_at" < now() and "outcome" = 'pending') as "pastPending",
        (select count(*)::int from "interview" where "user_id" = ${userId} and "scheduled_at" >= now()) as "upcoming",
        (select count(*)::int from "interview" where "user_id" = ${userId} and "scheduled_at" >= now() and "outcome" = 'pending') as "upcomingPending",
        (select count(*)::int from "application_contact" where "user_id" = ${userId}) as "links",
        (select count(*)::int from "contact" where "user_id" = ${userId}) as "contacts"`),
    )[0];
    expect(counts.past).toBeGreaterThanOrEqual(6);
    expect(counts.pastPending).toBe(0);
    expect(counts.upcoming).toBe(2);
    expect(counts.upcomingPending).toBe(2);
    expect(counts.contacts).toBe(5);
    expect(counts.links).toBe(5);

    // Six follow-ups and one manual reminder are due; others are upcoming or done.
    expect(await countDueReminders(db, userId)).toBe(7);
    const reminders = await listReminders(db, userId);
    expect(reminders.due.filter((r) => r.kind === "manual")).toHaveLength(1);
    expect(reminders.upcoming.length).toBeGreaterThanOrEqual(4);
    expect(reminders.done.length).toBeGreaterThanOrEqual(1);
  });

  it("gives two demo users the same content but fully separate data", async () => {
    const a = await newDemo();
    const b = await newDemo();

    const shape = async (userId: string) =>
      (await listApplications(db, userId)).map((app) => [app.companyName, app.role, app.stageName, app.appliedAt]);
    expect(await shape(a.userId)).toEqual(await shape(b.userId));

    const aIds = (await listApplications(db, a.userId)).map((app) => app.id);
    const bIds = (await listApplications(db, b.userId)).map((app) => app.id);
    expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    for (const id of bIds) expect(await getApplication(db, a.userId, id)).toBeNull();
    const headersA = await signedInHeaders(a.email, a.password);
    expect((await getUserFromHeaders(auth, headersA))!.id).toBe(a.userId);
  });

  it("refuses a new demo when the live demo cap is reached, leaving every table unchanged", async () => {
    const [{ live }] = rowsOf<{ live: number }>(
      await db.execute(sql`select count(*)::int as "live" from "demo_account" where "expires_at" > now()`),
    );
    expect(DEMO_ACCOUNT_LIMIT).toBe(200);
    const before = await tableCounts();
    const sentBefore = sent.length;

    await expect(createDemoAccount(auth, db, { baseURL: BASE_URL, clientIp: null, limit: live })).resolves.toEqual({
      ok: false,
      reason: "limit",
    });
    expect(await tableCounts()).toEqual(before);
    expect(sent.length).toBe(sentBefore);
    expect(demoErrorMessage("limit")).toBe(
      "Too many people are trying the demo right now. Please try again later, or create a free account.",
    );
  });

  it("does not count expired demos toward the cap", async () => {
    const [{ live }] = rowsOf<{ live: number }>(
      await db.execute(sql`select count(*)::int as "live" from "demo_account" where "expires_at" > now()`),
    );
    await newDemo({ now: new Date(Date.now() - 25 * 60 * 60 * 1000) });

    const result = await createDemoAccount(auth, db, { baseURL: BASE_URL, clientIp: null, limit: live + 1 });
    expect(result.ok).toBe(true);
  });

  it("goes through Better Auth rate limiting: a fourth sign-up from one address within 10 s is refused", async () => {
    const limited = createAuth({
      db,
      secret: SECRET,
      baseURL: BASE_URL,
      google: { clientId: "id", clientSecret: "secret" },
      rateLimit: { enabled: true },
    });
    const clientIp = "203.0.113.77";
    for (let i = 0; i < 3; i += 1) {
      expect((await createDemoAccount(limited, db, { baseURL: BASE_URL, clientIp })).ok).toBe(true);
    }
    const before = await tableCounts();

    await expect(createDemoAccount(limited, db, { baseURL: BASE_URL, clientIp })).resolves.toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(await tableCounts()).toEqual(before);
    // Another address is not affected.
    expect((await createDemoAccount(limited, db, { baseURL: BASE_URL, clientIp: "203.0.113.78" })).ok).toBe(true);
    expect(demoErrorMessage("rate_limited")).toBe("Too many demo requests from your network. Please wait a few seconds and try again.");
  });
});

describe("demo users never receive email (S23)", () => {
  it("never sends a verification email for a demo sign-up, even with `*` allowed", async () => {
    sent.length = 0;
    const demo = await newDemo();
    // Let any background send finish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);

    // The sender itself refuses a demo address.
    const direct = createSendVerificationEmail(db, { recipients: everyone, sender });
    await direct({ user: { id: demo.userId, email: demo.email }, url: `${BASE_URL}/api/auth/verify-email?token=x` });
    expect(sent).toEqual([]);
  });

  it("refuses the resend action for a demo user without calling the sender", async () => {
    sent.length = 0;
    const demo = await newDemo();
    const headers = await signedInHeaders(demo.email, demo.password);

    await expect(resendVerificationEmail(auth, headers, state)).resolves.toEqual({
      ok: false,
      message: "Demo accounts do not get email.",
    });
    expect(sent).toEqual([]);
  });

  it("never claims a demo user's due reminders for the digest, even verified with `*` and the switch on", async () => {
    const demo = await newDemo();
    await db.execute(sql`update "user" set "email_verified" = true where "id" = ${demo.userId}`);
    await db.execute(sql`insert into "user_settings" ("user_id", "email_reminders") values (${demo.userId}, true)
      on conflict ("user_id") do update set "email_reminders" = true`);
    expect(await countDueReminders(db, demo.userId)).toBe(7);

    // Control: a real verified user's due reminder is claimed in the same run.
    const { user: real } = await auth.api.signUpEmail({
      body: { name: "Real", email: "real-digest@example.com", password: "correct-horse-battery" },
    });
    await db.execute(sql`update "user" set "email_verified" = true where "id" = ${real.id}`);
    const { seedDemoData } = await import("./demo-seed");
    await seedDemoData(db, real.id, new Date());
    // A demo-domain address without a demo row (crafted) is excluded by the domain alone.
    const { user: crafted } = await auth.api.signUpEmail({
      body: { name: "Crafted", email: "crafted-digest@demo.lafija.invalid", password: "correct-horse-battery" },
    });
    await db.execute(sql`update "user" set "email_verified" = true where "id" = ${crafted.id}`);
    await seedDemoData(db, crafted.id, new Date());

    sent.length = 0;
    const summary = await sendDueReminderEmails(db, { ...sender, recipients: everyone, appUrl: BASE_URL }, new Date(), {
      batchSize: 10_000,
    });

    expect(sent.map((email) => email.to)).toEqual(["real-digest@example.com"]);
    expect(summary.sent).toBe(7);
    const [{ claimedOrSent }] = rowsOf<{ claimedOrSent: number }>(
      await db.execute(sql`select count(*)::int as "claimedOrSent" from "reminder" r
        join "user" u on u."id" = r."user_id"
        where u."email" like '%@demo.lafija.invalid' and (r."sent_at" is not null or r."email_claimed_at" is not null)`),
    );
    expect(claimedOrSent).toBe(0);
  });

  it("Settings explains that demo accounts get no reminder emails", () => {
    expect(
      reminderEmailProblems({
        state,
        email: "demo-abc@demo.lafija.invalid",
        emailVerified: true,
        emailReminders: true,
        isDemo: true,
      }),
    ).toEqual(["demo_account"]);
    expect(
      reminderEmailProblems({ state, email: "x@demo.lafija.invalid", emailVerified: true, emailReminders: true, isDemo: false }),
    ).toEqual(["demo_account"]);
    expect(emailProblemMessage("demo_account")).toBe("Email reminders are unavailable for demo accounts.");
  });
});

describe("demo rows", () => {
  it("getDemoAccount returns null for a real user", async () => {
    const { user: real } = await auth.api.signUpEmail({
      body: { name: "Real", email: "not-a-demo@example.com", password: "correct-horse-battery" },
    });
    expect(await getDemoAccount(db, real.id)).toBeNull();
    expect(await db.select().from(demoAccount).where(sql`${demoAccount.userId} = ${real.id}`)).toEqual([]);
    expect((await db.select().from(user).where(sql`${user.id} = ${real.id}`))[0].email).toBe("not-a-demo@example.com");
  });
});

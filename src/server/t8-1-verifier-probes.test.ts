import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/db";
import type { OutgoingEmail, ReminderMailer } from "@/lib/email/types";
import type { EmailState } from "@/lib/env";

vi.mock("server-only", () => ({}));

const { createApplication } = await import("./applications");
const { sendDueReminderEmails, claimDueRemindersSql } = await import("./reminder-emails");
const { reminderEmailProblems } = await import("@/lib/email/eligibility");
const { createAuth } = await import("@/lib/auth");
const { resendVerificationEmail } = await import("@/lib/email/verification");
const { parseEnv } = await import("@/lib/env");
const { rowsOf } = await import("./board");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

const cfg = (recipients: { everyone: boolean; addresses: string[] }) => ({
  currentSigningKey: "c",
  nextSigningKey: "n",
  resendApiKey: "re_x",
  from: "a@example.com",
  recipients,
  appUrl: "https://x.example",
  cronUrl: "https://x.example/api/cron/reminders",
});

let n = 0;
async function userWithDue({ verified, setting }: { verified: boolean; setting: "on" | "off" | "none" }) {
  n += 1;
  const id = `vp-${n}`;
  const email = `vp${n}@example.com`;
  await db.insert(schema.user).values({ id, name: id, email, emailVerified: verified });
  if (setting !== "none") await db.insert(schema.userSettings).values({ userId: id, emailReminders: setting === "on" });
  const created = await createApplication(db, id, { companyName: "Acme", role: "Dev" });
  if (!created.ok) throw new Error("app");
  await db.insert(schema.reminder).values({
    userId: id,
    applicationId: created.application.id,
    kind: "manual",
    message: "m",
    dueAt: new Date(Date.now() - 3600_000),
  });
  return { id, email, verified, setting };
}

describe("S17: SQL recipient rule equals reminderEmailProblems (matrix)", () => {
  for (const mode of ["*", "listed-upper", "not-listed", "empty"] as const) {
    it(`allowlist ${mode}`, async () => {
      await db.execute(sql`delete from "reminder"`);
      const users = [];
      for (const verified of [true, false])
        for (const setting of ["on", "off", "none"] as const) users.push(await userWithDue({ verified, setting }));
      const recipients =
        mode === "*"
          ? { everyone: true, addresses: [] }
          : mode === "listed-upper"
            ? { everyone: false, addresses: users.map((u) => u.email) }
            : mode === "not-listed"
              ? { everyone: false, addresses: ["other@example.com"] }
              : { everyone: false, addresses: [] };
      const sent: OutgoingEmail[] = [];
      const mailer: ReminderMailer = {
        appUrl: "https://x.example",
        recipients,
        async send(email) {
          sent.push(email);
          return { ok: true };
        },
      };
      await sendDueReminderEmails(db, mailer);
      const state: EmailState = { ok: true, config: cfg(recipients) };
      const expected = users
        .filter(
          (u) =>
            reminderEmailProblems({
              state,
              email: mode === "listed-upper" ? u.email.toUpperCase() : u.email,
              emailVerified: u.verified,
              emailReminders: u.setting !== "off",
            }).length === 0,
        )
        .map((u) => u.email)
        .sort();
      expect(sent.map((email) => email.to).sort()).toEqual(expected);
      expect(expected.length).toBe(mode === "*" || mode === "listed-upper" ? 2 : 0);
    });
  }
});

describe("S19: lease boundary", () => {
  it("is not re-claimable at exactly 30 minutes, and is at 30 minutes + 1 ms", async () => {
    await db.execute(sql`delete from "reminder"`);
    const u = await userWithDue({ verified: true, setting: "on" });
    const recipients = { everyone: true, addresses: [] };
    const t = new Date();
    const claim = async (at: Date) =>
      rowsOf<{ id: string }>(await db.execute(claimDueRemindersSql({ now: at, recipients, batchSize: 10 })));
    expect(await claim(t)).toHaveLength(1);
    expect(await claim(new Date(t.getTime() + 29 * 60_000))).toHaveLength(0);
    expect(await claim(new Date(t.getTime() + 30 * 60_000))).toHaveLength(0);
    expect(await claim(new Date(t.getTime() + 30 * 60_000 + 1))).toHaveLength(1);
    const [row] = await db.select().from(schema.reminder).where(eq(schema.reminder.userId, u.id));
    expect(row.sentAt).toBeNull();
  });
});

describe("S17: resend cooldown is atomic per user", () => {
  it("two concurrent resends send one email; another user is not throttled", async () => {
    const sent: OutgoingEmail[] = [];
    const recipients = { everyone: true, addresses: [] };
    const sender = {
      async send(email: OutgoingEmail) {
        sent.push(email);
        return { ok: true as const };
      },
    };
    const auth = createAuth({
      db,
      secret: "test-secret-with-at-least-thirty-two-chars",
      baseURL: "http://localhost:3000",
      google: { clientId: "g", clientSecret: "g" },
      emailDelivery: { recipients, sender },
    });
    const state: EmailState = { ok: true, config: cfg(recipients) };
    vi.useFakeTimers({ toFake: ["Date"] });
    const headersFor = async (email: string) => {
      await auth.api.signUpEmail({ body: { name: "x", email, password: "correct-horse-battery" } });
      const { headers } = await auth.api.signInEmail({
        body: { email, password: "correct-horse-battery" },
        returnHeaders: true,
      });
      return new Headers({ cookie: headers.getSetCookie().map((v) => v.split(";")[0]).join("; ") });
    };
    const ha = await headersFor("race-a@example.com");
    const hb = await headersFor("race-b@example.com");
    vi.setSystemTime(Date.now() + 61_000);
    sent.length = 0;
    const results = await Promise.all([
      resendVerificationEmail(auth, ha, state),
      resendVerificationEmail(auth, ha, state),
      resendVerificationEmail(auth, hb, state),
    ]);
    vi.useRealTimers();
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(sent.map((email) => email.to).sort()).toEqual(["race-a@example.com", "race-b@example.com"]);
  });
});

describe("S18: required-var errors unchanged by a malformed email var", () => {
  it("names only the required key", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://x",
        BETTER_AUTH_SECRET: "short",
        BETTER_AUTH_URL: "http://x",
        GOOGLE_CLIENT_ID: "a",
        GOOGLE_CLIENT_SECRET: "b",
        RESEND_API_KEY: "bad value",
        EMAIL_FROM: "nope",
      }),
    ).toThrow(/^Invalid environment variables: BETTER_AUTH_SECRET$/);
  });
});

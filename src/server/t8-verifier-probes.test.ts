import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reminder, user, userSettings } from "@/db/schema";
import { parseEmailEnv, parseEnv, parseRecipientAllowlist } from "@/lib/env";
import type { OutgoingEmail, ReminderMailer } from "@/lib/email/types";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const { handleReminderCron } = await import("@/server/reminder-cron");
const { sendDueReminderEmails } = await import("@/server/reminder-emails");
const { createApplication } = await import("@/server/applications");

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(reminder);
});

const base = {
  DATABASE_URL: "postgresql://user:pass@host/db",
  BETTER_AUTH_SECRET: "a-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "https://lafija.vercel.app/",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  QSTASH_CURRENT_SIGNING_KEY: "sig_current",
  QSTASH_NEXT_SIGNING_KEY: "sig_next",
  RESEND_API_KEY: "re_abc",
  EMAIL_FROM: "laFija <onboarding@resend.dev>",
};
const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** Builds a QStash-style JWT the way @upstash/qstash's Receiver verifies it. */
function sign(body: string, url: string, key = "sig_current") {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      iat: now,
      nbf: now,
      exp: now + 300,
      body: b64(createHash("sha256").update(body).digest()),
    }),
  );
  return `${header}.${payload}.${b64(createHmac("sha256", key).update(`${header}.${payload}`).digest())}`;
}

describe("cron signature subject comes from BETTER_AUTH_URL", () => {
  const email = parseEmailEnv(base, parseEnv(base).BETTER_AUTH_URL);
  if (!email.ok) throw new Error("config");
  const config = email.config;
  const call = (signature: string) =>
    handleReminderCron(
      new Request("http://0.0.0.0:3000/api/cron/reminders", {
        method: "POST",
        body: "",
        headers: { "upstash-signature": signature },
      }),
      { config: () => config, run: async () => ({ claimed: 0, sent: 0, failed: 0, skipped: 0 }) },
    );

  it("strips the trailing slash and verifies an empty-body schedule regardless of request.url", async () => {
    expect(config.cronUrl).toBe("https://lafija.vercel.app/api/cron/reminders");
    expect((await call(sign("", config.cronUrl))).status).toBe(200);
  });

  it.each([
    "https://lafija.vercel.app/api/cron/reminders/",
    "http://lafija.vercel.app/api/cron/reminders",
    "https://lafija.vercel.app/api/cron/reminders?x=1",
    "https://other.vercel.app/api/cron/reminders",
  ])("refuses subject %s", async (url) => {
    const response = await call(sign("", url));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature." });
  });

  it("ignores QSTASH_DEV", async () => {
    process.env.QSTASH_DEV = "true";
    try {
      expect((await call(sign("", config.cronUrl))).status).toBe(200);
      expect((await call(sign("", config.cronUrl, "attacker"))).status).toBe(401);
    } finally {
      delete process.env.QSTASH_DEV;
    }
  });
});

describe("allowlist and env", () => {
  it("parses edge cases", () => {
    expect(parseRecipientAllowlist(" * , A@B.com ,, a@b.com ")).toEqual({ everyone: true, addresses: ["a@b.com"] });
    expect(parseRecipientAllowlist(" , ")).toEqual({ everyone: false, addresses: [] });
    for (const bad of ["a@b.com;c@d.com", "Owner <a@b.com>", "**"]) expect(parseRecipientAllowlist(bad)).toBeNull();
  });

  it("names malformed optional keys only, and only email is disabled (S18)", () => {
    expect(parseEnv({ ...base, RESEND_API_KEY: "sk_secret_value" }).BETTER_AUTH_URL).toBe(base.BETTER_AUTH_URL);
    const email = parseEmailEnv({ ...base, RESEND_API_KEY: "sk_secret_value" }, base.BETTER_AUTH_URL);
    expect(email).toEqual({ ok: false, reason: "misconfigured", keys: ["RESEND_API_KEY"] });
    expect(JSON.stringify(email)).not.toContain("sk_secret_value");
  });
});

describe("who is emailed", () => {
  let n = 0;
  async function setup(verified: boolean, emailOn = true) {
    const id = `probe-${++n}`;
    const address = `probe${n}@example.com`;
    await db.insert(user).values({ id, name: id, email: address, emailVerified: verified });
    if (!emailOn) await db.insert(userSettings).values({ userId: id, emailReminders: false });
    const app = await createApplication(db, id, { companyName: "Acme", role: "Dev" });
    if (!app.ok) throw new Error("app");
    await db.insert(reminder).values({
      userId: id,
      applicationId: app.application.id,
      kind: "manual",
      message: "m",
      dueAt: new Date(Date.now() - 60_000),
    });
    return address;
  }
  const mailer = (recipients: ReminderMailer["recipients"]) => {
    const sent: OutgoingEmail[] = [];
    return {
      sent,
      appUrl: "https://x",
      recipients,
      send: async (email: OutgoingEmail) => (sent.push(email), { ok: true as const }),
    };
  };

  it("never emails an opted-out user, even listed and verified", async () => {
    const off = await setup(true, false);
    expect(await sendDueReminderEmails(db, mailer({ everyone: true, addresses: [off] }))).toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      skipped: 1,
    });
  });

  it("one listed address (any case) claims only that user's reminders", async () => {
    const a = await setup(true);
    await setup(true);
    const m = mailer({ everyone: false, addresses: [a.toUpperCase()] });
    await sendDueReminderEmails(db, m);
    expect(m.sent.map((email) => email.to)).toEqual([a]);
  });
});

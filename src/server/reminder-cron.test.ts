import { createHash, createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reminder, user } from "@/db/schema";
import type { EmailConfig } from "@/lib/env";
import type { OutgoingEmail } from "@/lib/email/types";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { handleReminderCron } = await import("./reminder-cron");
const { sendDueReminderEmails } = await import("./reminder-emails");
const { createApplication } = await import("./applications");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

const CRON_URL = "https://lafija.example/api/cron/reminders";
const config: EmailConfig = {
  currentSigningKey: "sig_current_test_key",
  nextSigningKey: "sig_next_test_key",
  resendApiKey: "re_test",
  from: "laFija <onboarding@resend.dev>",
  recipients: { everyone: false, addresses: ["owner@example.com"] },
  appUrl: "https://lafija.example",
  cronUrl: CRON_URL,
};

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/**
 * Signs like QStash: an HS256 JWT with issuer "Upstash", subject = destination URL and `body` =
 * base64url SHA-256 of the raw body, which is what `Receiver.verify` checks
 * (node_modules/@upstash/qstash/chunk-QZWHOQRG.mjs, `verifyWithKey` / `verifyBodyAndUrl`).
 */
function sign(body: string, { key = config.currentSigningKey, url = CRON_URL, expiresIn = 300 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      iat: now,
      nbf: now,
      exp: now + expiresIn,
      jti: crypto.randomUUID(),
      body: b64url(createHash("sha256").update(body).digest()),
    }),
  );
  const signature = b64url(createHmac("sha256", key).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function post(body: string, signature?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== undefined) headers.set("upstash-signature", signature);
  return new Request(CRON_URL, { method: "POST", body, headers });
}

const summary = { claimed: 0, sent: 0, failed: 0, skipped: 0 };

async function remindersSnapshot() {
  return JSON.stringify(await db.select().from(reminder).orderBy(reminder.id));
}

describe("handleReminderCron", () => {
  it("returns 503 when email is not configured, without verifying or running the job", async () => {
    const run = vi.fn(async () => summary);

    const response = await handleReminderCron(post("{}", sign("{}")), { config: () => null, run });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Email reminders are not configured." });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["garbage", "not-a-jwt"],
    ["signed with another key", sign("{}", { key: "attacker-key" })],
    ["signed for another URL", sign("{}", { url: "https://lafija.example/api/other" })],
    ["signed for another body", sign('{"other":true}')],
    ["expired", sign("{}", { expiresIn: -60 })],
  ])("returns 401 for a %s signature and never runs the job", async (_label, signature) => {
    const run = vi.fn(async () => summary);

    const response = await handleReminderCron(post("{}", signature), { config: () => config, run });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature." });
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts the next signing key (key rotation)", async () => {
    const run = vi.fn(async () => summary);

    const response = await handleReminderCron(post("{}", sign("{}", { key: config.nextSigningKey })), {
      config: () => config,
      run,
    });

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs the job once for a valid signature and returns its summary", async () => {
    const result = { claimed: 2, sent: 2, failed: 0, skipped: 1 };
    const run = vi.fn(async () => result);

    const response = await handleReminderCron(post("", sign("")), { config: () => config, run });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(run).toHaveBeenCalledWith(config);
  });

  it("returns 500 without details when the job throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("database password is hunter2");
    });

    const response = await handleReminderCron(post("{}", sign("{}")), { config: () => config, run });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hunter2");
  });

  it("with the real job: an invalid signature leaves the database untouched, a valid one sends", async () => {
    await db.insert(user).values({ id: "cron-owner", name: "Owner", email: "owner@example.com" });
    const created = await createApplication(db, "cron-owner", { companyName: "Acme", role: "Engineer" });
    if (!created.ok) throw new Error("create failed");
    await db.insert(reminder).values({
      userId: "cron-owner",
      applicationId: created.application.id,
      kind: "manual",
      message: "Due now",
      dueAt: new Date(Date.now() - 60_000),
    });
    const sent: OutgoingEmail[] = [];
    const run = vi.fn((c: EmailConfig) =>
      sendDueReminderEmails(db, {
        appUrl: c.appUrl,
        recipients: c.recipients,
        send: async (email) => {
          sent.push(email);
          return { ok: true };
        },
      }),
    );
    const before = await remindersSnapshot();

    const refused = await handleReminderCron(post("{}", sign("{}", { key: "wrong" })), { config: () => config, run });
    expect(refused.status).toBe(401);
    expect(await remindersSnapshot()).toBe(before);
    expect(sent).toEqual([]);

    const accepted = await handleReminderCron(post("{}", sign("{}")), { config: () => config, run });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sent.map((e) => e.to)).toEqual(["owner@example.com"]);
    const [{ count }] = (
      await db.execute(sql`select count(*)::int as "count" from "reminder" where "sent_at" is not null`)
    ).rows as { count: number }[];
    expect(count).toBe(1);
  });
});

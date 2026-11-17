import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { QStashConfig } from "@/lib/env";

vi.mock("server-only", () => ({}));

const { handleCleanupCron } = await import("./cleanup-cron");

const CLEANUP_URL = "https://lafija.example/api/cron/cleanup";
const config: QStashConfig = {
  currentSigningKey: "sig_current_test_key",
  nextSigningKey: "sig_next_test_key",
  cleanupUrl: CLEANUP_URL,
};

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** Signs like QStash (same format as src/server/reminder-cron.test.ts). */
function sign(body: string, { key = config.currentSigningKey, url = CLEANUP_URL, expiresIn = 300 } = {}) {
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
  return new Request(CLEANUP_URL, { method: "POST", body, headers });
}

describe("handleCleanupCron", () => {
  it("returns 503 without the QStash keys, without running the cleanup", async () => {
    const run = vi.fn(async () => ({ deleted: 0 }));

    const response = await handleCleanupCron(post("{}", sign("{}")), { config: () => null, run });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The cleanup job is not configured." });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["garbage", "not-a-jwt"],
    ["signed with another key", sign("{}", { key: "attacker-key" })],
    ["signed for the reminders URL", sign("{}", { url: "https://lafija.example/api/cron/reminders" })],
    ["signed for another body", sign('{"other":true}')],
    ["expired", sign("{}", { expiresIn: -60 })],
  ])("returns 401 for a %s signature and never runs the cleanup", async (_label, signature) => {
    const run = vi.fn(async () => ({ deleted: 0 }));

    const response = await handleCleanupCron(post("{}", signature), { config: () => config, run });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature." });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the cleanup once for a valid signature (current or next key) and returns its counts only", async () => {
    const run = vi.fn(async () => ({ deleted: 3 }));

    const first = await handleCleanupCron(post("", sign("")), { config: () => config, run });
    const second = await handleCleanupCron(post("{}", sign("{}", { key: config.nextSigningKey })), {
      config: () => config,
      run,
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ deleted: 3 });
    expect(second.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns 500 without details when the cleanup throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("database password is hunter2");
    });

    const response = await handleCleanupCron(post("{}", sign("{}")), { config: () => config, run });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hunter2");
  });
});

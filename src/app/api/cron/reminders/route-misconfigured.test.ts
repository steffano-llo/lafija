import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// S18: every email variable is set but one is malformed. The app keeps working (getEnv), and the
// endpoint answers 503 before verifying anything or touching the database.
vi.stubEnv("DATABASE_URL", "postgresql://user:pass@127.0.0.1:1/never-used");
vi.stubEnv("BETTER_AUTH_SECRET", "a-secret-that-is-at-least-32-characters");
vi.stubEnv("BETTER_AUTH_URL", "https://lafija.example");
vi.stubEnv("GOOGLE_CLIENT_ID", "id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "sig_current");
vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "sig_next");
vi.stubEnv("RESEND_API_KEY", "not-a-resend-key-secret");
vi.stubEnv("EMAIL_FROM", "laFija <onboarding@resend.dev>");
vi.stubEnv("EMAIL_ALLOWED_RECIPIENTS", "owner@example.com");

const getDb = vi.fn(() => {
  throw new Error("the database must not be touched");
});
vi.mock("@/db", () => ({ getDb }));
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

const route = await import("./route");
const { getEnv } = await import("@/lib/env");

afterAll(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("POST /api/cron/reminders with a malformed email variable", () => {
  it("answers 503 without touching the database, warns once naming the key, and getEnv still works", async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await route.POST(
        new Request("https://lafija.example/api/cron/reminders", { method: "POST", body: "{}" }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Email reminders are not configured." });
    }

    expect(getDb).not.toHaveBeenCalled();
    expect(getEnv().BETTER_AUTH_URL).toBe("https://lafija.example");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Email delivery is disabled: invalid environment variables: RESEND_API_KEY");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("not-a-resend-key-secret");
  });
});

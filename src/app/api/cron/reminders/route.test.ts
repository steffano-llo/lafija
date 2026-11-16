import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Valid required variables and no email group: the endpoint must answer 503 before any DB access.
vi.stubEnv("DATABASE_URL", "postgresql://user:pass@127.0.0.1:1/never-used");
vi.stubEnv("BETTER_AUTH_SECRET", "a-secret-that-is-at-least-32-characters");
vi.stubEnv("BETTER_AUTH_URL", "https://lafija.example");
vi.stubEnv("GOOGLE_CLIENT_ID", "id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
for (const key of [
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMAIL_ALLOWED_RECIPIENTS",
]) {
  vi.stubEnv(key, "");
}

const getDb = vi.fn(() => {
  throw new Error("the database must not be touched");
});
vi.mock("@/db", () => ({ getDb }));

const route = await import("./route");

describe("POST /api/cron/reminders", () => {
  it("exports only POST, so Next answers other methods with 405", () => {
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });

  it("answers 503 when email is not configured, without touching the database", async () => {
    const response = await route.POST(
      new Request("https://lafija.example/api/cron/reminders", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Email reminders are not configured." });
    expect(getDb).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Valid required variables; the QStash keys are switched per test. The email group (Resend, sender,
// allowlist) stays unset: the cleanup endpoint does not depend on it.
vi.stubEnv("DATABASE_URL", "postgresql://user:pass@127.0.0.1:1/never-used");
vi.stubEnv("BETTER_AUTH_SECRET", "a-secret-that-is-at-least-32-characters");
vi.stubEnv("BETTER_AUTH_URL", "https://lafija.example");
vi.stubEnv("GOOGLE_CLIENT_ID", "id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
for (const key of ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_ALLOWED_RECIPIENTS"]) vi.stubEnv(key, "");

const getDb = vi.fn(() => {
  throw new Error("the database must not be touched");
});
vi.mock("@/db", () => ({ getDb }));

const route = await import("./route");
const URL_ = "https://lafija.example/api/cron/cleanup";

describe("POST /api/cron/cleanup", () => {
  it("exports only POST, so Next answers other methods with 405", () => {
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });

  it("answers 503 without the QStash keys, without touching the database", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");

    const response = await route.POST(new Request(URL_, { method: "POST", body: "{}" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The cleanup job is not configured." });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("answers 401 to an unsigned request when only the QStash keys are set, without touching the database", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "sig_current");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "sig_next");

    const response = await route.POST(new Request(URL_, { method: "POST", body: "{}" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature." });
    expect(getDb).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEmailEnv, parseEnv, parseRecipientAllowlist } from "./env";

const valid = {
  DATABASE_URL: "postgresql://user:pass@host.neon.tech/lafija?sslmode=require",
  BETTER_AUTH_SECRET: "a-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "https://lafija.vercel.app",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
};

describe("parseEnv", () => {
  it("returns the typed environment when every required variable is valid", () => {
    const env = parseEnv({ ...valid, NODE_ENV: "production" });

    expect(env).toEqual({ ...valid, NODE_ENV: "production" });
  });

  it("defaults NODE_ENV to development", () => {
    const env = parseEnv(valid);

    expect(env.NODE_ENV).toBe("development");
  });

  it("names the missing variable without echoing any value", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined, NODE_ENV: "test" })).toThrowError(
      "Invalid environment variables: DATABASE_URL",
    );
  });

  it("rejects a DATABASE_URL that is not a postgres connection string", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "mysql://secret@host/db" })).toThrowError(
      "Invalid environment variables: DATABASE_URL",
    );
  });

  it("lists every missing auth variable", () => {
    expect(() => parseEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrowError(
      "Invalid environment variables: BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET",
    );
  });

  it("rejects a BETTER_AUTH_SECRET shorter than 32 characters without echoing it", () => {
    const run = () => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short-secret" });

    expect(run).toThrowError("Invalid environment variables: BETTER_AUTH_SECRET");
    expect(run).not.toThrowError(/short-secret/);
  });

  it("rejects a BETTER_AUTH_URL that is not a URL", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_URL: "lafija" })).toThrowError(
      "Invalid environment variables: BETTER_AUTH_URL",
    );
  });
});

describe("parseEnv ignores the email group (S18)", () => {
  it("returns only the required variables, whatever the email variables hold", () => {
    const malformed = {
      RESEND_API_KEY: "sk_secret_value",
      EMAIL_FROM: "not an address",
      EMAIL_ALLOWED_RECIPIENTS: "nope",
      QSTASH_CURRENT_SIGNING_KEY: "has spaces",
    };
    expect(parseEnv({ ...valid, ...malformed })).toEqual({ ...valid, NODE_ENV: "development" });
  });
});

describe("parseEmailEnv (T8, S18)", () => {
  const email = {
    QSTASH_CURRENT_SIGNING_KEY: "sig_current_key",
    QSTASH_NEXT_SIGNING_KEY: "sig_next_key",
    RESEND_API_KEY: "re_123_abc",
    EMAIL_FROM: "laFija <onboarding@resend.dev>",
    EMAIL_ALLOWED_RECIPIENTS: "Owner@Example.com, other@example.com",
  };
  const APP = "https://lafija.vercel.app";

  it("is not configured without the four delivery variables, and empty values count as unset", () => {
    const missing = ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "RESEND_API_KEY", "EMAIL_FROM"];
    expect(parseEmailEnv({}, APP)).toEqual({ ok: false, reason: "not_configured", missing });
    const blank = Object.fromEntries(Object.keys(email).map((key) => [key, ""]));
    expect(parseEmailEnv(blank, APP)).toEqual({ ok: false, reason: "not_configured", missing });
    expect(parseEmailEnv({ RESEND_API_KEY: "re_1", EMAIL_FROM: "a@b.co" }, APP)).toEqual({
      ok: false,
      reason: "not_configured",
      missing: ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"],
    });
  });

  it("accepts both sender forms and *", () => {
    expect(parseEmailEnv({ ...email, EMAIL_FROM: "reminders@lafija.dev" }, APP)).toMatchObject({
      ok: true,
      config: { from: "reminders@lafija.dev" },
    });
    expect(parseEmailEnv({ ...email, EMAIL_ALLOWED_RECIPIENTS: "*" }, APP)).toMatchObject({
      ok: true,
      config: { recipients: { everyone: true, addresses: [] } },
    });
  });

  it.each([
    ["RESEND_API_KEY", "not-a-resend-key"],
    ["EMAIL_FROM", "laFija onboarding@resend.dev"],
    ["EMAIL_FROM", "laFija <not-an-email>"],
    ["EMAIL_ALLOWED_RECIPIENTS", "owner@example.com, not-an-email"],
    ["QSTASH_CURRENT_SIGNING_KEY", "has spaces in it"],
    ["QSTASH_NEXT_SIGNING_KEY", "has spaces in it"],
  ])("is misconfigured for an invalid %s, naming only the key", (key, value) => {
    const result = parseEmailEnv({ ...email, [key]: value }, APP);

    expect(result).toEqual({ ok: false, reason: "misconfigured", keys: [key] });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it("lists every invalid email variable, never a value, even when others are missing", () => {
    const result = parseEmailEnv({ RESEND_API_KEY: "secret-value", EMAIL_FROM: "secret-from" }, APP);

    expect(result).toEqual({ ok: false, reason: "misconfigured", keys: ["RESEND_API_KEY", "EMAIL_FROM"] });
    expect(JSON.stringify(result)).not.toMatch(/secret/);
  });

  it("returns the config with the parsed allowlist, the app URL and the cron URL", () => {
    expect(
      parseEmailEnv(
        {
          QSTASH_CURRENT_SIGNING_KEY: "cur",
          QSTASH_NEXT_SIGNING_KEY: "next",
          RESEND_API_KEY: "re_1",
          EMAIL_FROM: "laFija <onboarding@resend.dev>",
          EMAIL_ALLOWED_RECIPIENTS: "Owner@Example.com",
        },
        "https://lafija.vercel.app/",
      ),
    ).toEqual({
      ok: true,
      config: {
        currentSigningKey: "cur",
        nextSigningKey: "next",
        resendApiKey: "re_1",
        from: "laFija <onboarding@resend.dev>",
        recipients: { everyone: false, addresses: ["owner@example.com"] },
        appUrl: "https://lafija.vercel.app",
        cronUrl: "https://lafija.vercel.app/api/cron/reminders",
      },
    });
  });
});

describe("getEnv and getEmailState with a malformed email variable (S18)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("keeps getEnv working, disables email naming the keys and warns once without values", async () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "sig_current_key");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "sig_next_key");
    vi.stubEnv("RESEND_API_KEY", "sk_secret_value");
    vi.stubEnv("EMAIL_FROM", "laFija <onboarding@resend.dev>");
    vi.stubEnv("EMAIL_ALLOWED_RECIPIENTS", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const env = await import("./env");

    expect(env.getEnv()).toEqual({ ...valid, NODE_ENV: "test" });
    expect(env.getEmailState()).toEqual({ ok: false, reason: "misconfigured", keys: ["RESEND_API_KEY"] });
    expect(env.getEmailState()).toEqual({ ok: false, reason: "misconfigured", keys: ["RESEND_API_KEY"] });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Email delivery is disabled: invalid environment variables: RESEND_API_KEY",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk_secret_value");
  });

  it("does not warn when email is simply not configured", async () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);
    for (const key of ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "RESEND_API_KEY", "EMAIL_FROM"]) {
      vi.stubEnv(key, "");
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const env = await import("./env");

    expect(env.getEmailState()).toMatchObject({ ok: false, reason: "not_configured" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("parseRecipientAllowlist", () => {
  it("is empty (nobody gets email) when unset or blank", () => {
    expect(parseRecipientAllowlist(undefined)).toEqual({ everyone: false, addresses: [] });
    expect(parseRecipientAllowlist("  ")).toEqual({ everyone: false, addresses: [] });
  });

  it("lowercases, trims, ignores empty entries and removes duplicates", () => {
    expect(parseRecipientAllowlist(" Owner@Example.com ,, other@example.com,OWNER@example.com, ")).toEqual({
      everyone: false,
      addresses: ["owner@example.com", "other@example.com"],
    });
  });

  it("allows everyone with *", () => {
    expect(parseRecipientAllowlist("*")).toEqual({ everyone: true, addresses: [] });
    expect(parseRecipientAllowlist("owner@example.com, *")).toEqual({ everyone: true, addresses: ["owner@example.com"] });
  });

  it("returns null when an entry is not an address", () => {
    expect(parseRecipientAllowlist("owner@example.com, nope")).toBeNull();
  });
});

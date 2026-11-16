import { describe, expect, it } from "vitest";
import { getEmailConfig, parseEnv, parseRecipientAllowlist } from "./env";

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

describe("parseEnv: optional email group (T8)", () => {
  const email = {
    QSTASH_CURRENT_SIGNING_KEY: "sig_current_key",
    QSTASH_NEXT_SIGNING_KEY: "sig_next_key",
    RESEND_API_KEY: "re_123_abc",
    EMAIL_FROM: "laFija <onboarding@resend.dev>",
    EMAIL_ALLOWED_RECIPIENTS: "Owner@Example.com, other@example.com",
  };

  it("is valid without any email variable, and empty values count as unset", () => {
    expect(parseEnv(valid)).toEqual({ ...valid, NODE_ENV: "development" });
    const blank = Object.fromEntries(Object.keys(email).map((key) => [key, ""]));
    expect(parseEnv({ ...valid, ...blank })).toEqual({ ...valid, NODE_ENV: "development" });
  });

  it("keeps every valid email variable", () => {
    expect(parseEnv({ ...valid, ...email })).toEqual({ ...valid, ...email, NODE_ENV: "development" });
    expect(parseEnv({ ...valid, EMAIL_FROM: "reminders@lafija.dev" }).EMAIL_FROM).toBe("reminders@lafija.dev");
    expect(parseEnv({ ...valid, EMAIL_ALLOWED_RECIPIENTS: "*" }).EMAIL_ALLOWED_RECIPIENTS).toBe("*");
  });

  it.each([
    ["RESEND_API_KEY", "not-a-resend-key"],
    ["EMAIL_FROM", "laFija onboarding@resend.dev"],
    ["EMAIL_FROM", "laFija <not-an-email>"],
    ["EMAIL_ALLOWED_RECIPIENTS", "owner@example.com, not-an-email"],
    ["QSTASH_CURRENT_SIGNING_KEY", "has spaces in it"],
    ["QSTASH_NEXT_SIGNING_KEY", "has spaces in it"],
  ])("rejects an invalid %s naming only the key", (key, value) => {
    const run = () => parseEnv({ ...valid, ...email, [key]: value });

    expect(run).toThrowError(`Invalid environment variables: ${key}`);
    expect(run).not.toThrowError(value);
  });

  it("lists every invalid email variable, never a value", () => {
    const run = () => parseEnv({ ...valid, RESEND_API_KEY: "secret-value", EMAIL_FROM: "secret-from" });

    expect(run).toThrowError("Invalid environment variables: RESEND_API_KEY, EMAIL_FROM");
    expect(run).not.toThrowError(/secret/);
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

describe("getEmailConfig", () => {
  const base = parseEnv({ ...valid });

  it("is unconfigured without the four delivery variables, naming the missing ones", () => {
    expect(getEmailConfig(base)).toEqual({
      ok: false,
      missing: ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "RESEND_API_KEY", "EMAIL_FROM"],
    });
    expect(getEmailConfig(parseEnv({ ...valid, RESEND_API_KEY: "re_1", EMAIL_FROM: "a@b.co" }))).toEqual({
      ok: false,
      missing: ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"],
    });
  });

  it("returns the config with the parsed allowlist, the app URL and the cron URL", () => {
    const env = parseEnv({
      ...valid,
      BETTER_AUTH_URL: "https://lafija.vercel.app/",
      QSTASH_CURRENT_SIGNING_KEY: "cur",
      QSTASH_NEXT_SIGNING_KEY: "next",
      RESEND_API_KEY: "re_1",
      EMAIL_FROM: "laFija <onboarding@resend.dev>",
      EMAIL_ALLOWED_RECIPIENTS: "Owner@Example.com",
    });
    expect(getEmailConfig(env)).toEqual({
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

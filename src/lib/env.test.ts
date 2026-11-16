import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

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

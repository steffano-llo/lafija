import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  it("returns the typed environment when every required variable is valid", () => {
    const env = parseEnv({
      DATABASE_URL: "postgresql://user:pass@host.neon.tech/lafija?sslmode=require",
      NODE_ENV: "production",
    });

    expect(env).toEqual({
      DATABASE_URL: "postgresql://user:pass@host.neon.tech/lafija?sslmode=require",
      NODE_ENV: "production",
    });
  });

  it("defaults NODE_ENV to development", () => {
    const env = parseEnv({ DATABASE_URL: "postgresql://localhost/lafija" });

    expect(env.NODE_ENV).toBe("development");
  });

  it("names the missing variable without echoing any value", () => {
    expect(() => parseEnv({ NODE_ENV: "test" })).toThrowError(
      "Invalid environment variables: DATABASE_URL",
    );
  });

  it("rejects a DATABASE_URL that is not a postgres connection string", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://secret@host/db" })).toThrowError(
      "Invalid environment variables: DATABASE_URL",
    );
  });
});

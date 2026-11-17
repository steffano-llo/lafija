import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `npm run reminders:send` exits before touching the database when email is unavailable, naming
// variables only (S18). The child gets a minimal environment, never the developer's own variables.

const root = fileURLToPath(new URL("../..", import.meta.url));
const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runScript(env: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key]) base[key] = process.env[key]!;
  }
  return spawnSync(process.execPath, [tsx, "--conditions=react-server", "scripts/send-reminders.ts"], {
    cwd: root,
    env: {
      ...base,
      DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/never-used",
      BETTER_AUTH_SECRET: "a-secret-that-is-at-least-32-characters",
      BETTER_AUTH_URL: "https://lafija.example",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      NODE_ENV: "test",
      ...env,
    },
    encoding: "utf8",
    timeout: 25_000,
  });
}

describe("scripts/send-reminders.ts", () => {
  it("exits non-zero naming the malformed email variables, never their values", () => {
    const result = runScript({
      QSTASH_CURRENT_SIGNING_KEY: "sig_current",
      QSTASH_NEXT_SIGNING_KEY: "sig_next",
      RESEND_API_KEY: "sk_secret_value",
      EMAIL_FROM: "secret-sender",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Email is misconfigured. Invalid: RESEND_API_KEY, EMAIL_FROM");
    expect(result.stdout + result.stderr).not.toMatch(/sk_secret_value|secret-sender/);
  });

  it("exits non-zero naming the missing variables when email is not configured", () => {
    const result = runScript({});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Email is not configured. Missing: QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, RESEND_API_KEY, EMAIL_FROM",
    );
  });
});

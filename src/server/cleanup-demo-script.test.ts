import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `npm run demo:cleanup` validates the environment before touching the database and names
// variables only. The child gets a minimal environment, never the developer's own variables.

const root = fileURLToPath(new URL("../..", import.meta.url));
const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

describe("scripts/cleanup-demo.ts", () => {
  it("exits non-zero naming the invalid variables, never their values", () => {
    const base: Record<string, string> = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
      if (process.env[key]) base[key] = process.env[key]!;
    }
    const result = spawnSync(process.execPath, [tsx, "--conditions=react-server", "scripts/cleanup-demo.ts"], {
      cwd: root,
      env: {
        ...base,
        DATABASE_URL: "mysql://user:pass-secret-value@127.0.0.1:1/never-used",
        BETTER_AUTH_SECRET: "a-secret-that-is-at-least-32-characters",
        BETTER_AUTH_URL: "https://lafija.example",
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        NODE_ENV: "test",
      },
      encoding: "utf8",
      timeout: 25_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid environment variables: DATABASE_URL");
    expect(result.stdout).toBe("");
    expect(result.stdout + result.stderr).not.toContain("pass-secret-value");
  });
});

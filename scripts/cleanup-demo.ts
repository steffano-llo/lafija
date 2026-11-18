/**
 * Deletes expired demo accounts once against DATABASE_URL: the same code QStash triggers hourly
 * through POST /api/cron/cleanup.
 *
 *   npm run demo:cleanup -- --env-file <path to your local env file>
 *
 * Without `--env-file` it uses the variables already in the environment. Prints only the count of
 * deleted demo accounts, or the names of invalid variables; never a value.
 */
import { config } from "dotenv";

function envFileArgument(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((arg) => arg === "--env-file" || arg.startsWith("--env-file="));
  if (index === -1) return undefined;
  const arg = argv[index];
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1];
}

async function main() {
  const envFile = envFileArgument(process.argv.slice(2));
  if (envFile) config({ path: envFile, quiet: true });

  const { getEnv } = await import("../src/lib/env");
  getEnv();
  const { getDb } = await import("../src/db");
  const { deleteExpiredDemoAccounts } = await import("../src/server/demo");
  const summary = await deleteExpiredDemoAccounts(getDb());
  console.log(JSON.stringify(summary));
}

main().catch((error: unknown) => {
  // parseEnv's message lists variable names only; any other message could quote a connection string.
  const safe = error instanceof Error && error.message.startsWith("Invalid environment variables:");
  console.error(
    safe ? (error as Error).message : `Demo cleanup failed (${error instanceof Error ? error.name : "unknown error"}).`,
  );
  process.exitCode = 1;
});

/**
 * Runs the reminder email job once against DATABASE_URL with the real Resend sender: the same code
 * QStash triggers through POST /api/cron/reminders (QStash cannot reach localhost).
 *
 *   npm run reminders:send -- --env-file <path to your local env file>
 *
 * Without `--env-file` it uses the variables already in the environment. Variables already set in
 * the shell win over the file. Prints only the summary, or the names of missing variables; never a
 * value.
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

  const { getEmailConfig, getEnv } = await import("../src/lib/env");
  const email = getEmailConfig(getEnv());
  if (!email.ok) {
    console.error(`Email is not configured. Missing: ${email.missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const { recipients } = email.config;
  if (!recipients.everyone && recipients.addresses.length === 0) {
    console.warn("EMAIL_ALLOWED_RECIPIENTS is empty: nobody gets email.");
  }
  const { getDb } = await import("../src/db");
  const { createResendMailer } = await import("../src/lib/email/resend-sender");
  const { sendDueReminderEmails } = await import("../src/server/reminder-emails");
  const summary = await sendDueReminderEmails(getDb(), createResendMailer(email.config));
  console.log(JSON.stringify(summary));
}

main().catch((error: unknown) => {
  // parseEnv's message lists variable names only; any other message could quote a connection string.
  const safe = error instanceof Error && error.message.startsWith("Invalid environment variables:");
  console.error(
    safe ? (error as Error).message : `Reminder email job failed (${error instanceof Error ? error.name : "unknown error"}).`,
  );
  process.exitCode = 1;
});

import { getDb } from "@/db";
import { createResendMailer } from "@/lib/email/resend-sender";
import { getEmailConfig, getEnv } from "@/lib/env";
import { handleReminderCron } from "@/server/reminder-cron";
import { sendDueReminderEmails } from "@/server/reminder-emails";

/**
 * QStash schedule target (every 15 minutes). Only POST is exported, so Next answers other methods
 * with 405. Not under `src/proxy.ts` (its matcher is /dashboard only): the QStash signature is the
 * guard, checked in `handleReminderCron` before the database is touched.
 */
export async function POST(request: Request): Promise<Response> {
  return handleReminderCron(request, {
    config: () => {
      const email = getEmailConfig(getEnv());
      return email.ok ? email.config : null;
    },
    run: (config) => sendDueReminderEmails(getDb(), createResendMailer(config)),
  });
}

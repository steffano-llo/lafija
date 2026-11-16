import { Resend } from "resend";
import type { EmailConfig } from "@/lib/env";
import type { ReminderMailer } from "./types";

/**
 * The real mailer: Resend's `emails.send(payload, { idempotencyKey })`
 * (node_modules/resend/dist/index.d.mts: `Emails.send` and `IdempotentRequest.idempotencyKey`,
 * sent as the `Idempotency-Key` header). The SDK resolves `{ data, error }` instead of throwing for
 * API errors; the error's message (never the key) is reported back.
 */
export function createResendMailer(config: EmailConfig): ReminderMailer {
  const resend = new Resend(config.resendApiKey);
  return {
    appUrl: config.appUrl,
    recipients: config.recipients,
    async send(email) {
      const { error } = await resend.emails.send(
        { from: config.from, to: email.to, subject: email.subject, text: email.text, html: email.html },
        { idempotencyKey: email.idempotencyKey },
      );
      return error ? { ok: false, error: `${error.name}: ${error.message}` } : { ok: true };
    },
  };
}

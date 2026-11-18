import type { RecipientAllowlist } from "@/lib/env";

/** One email ready to send. `idempotencyKey` lets the provider drop a duplicate of the same send. */
export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

/** Never throws on a refused send: the result says so (a throw is treated the same way anyway). */
export type SendResult = { ok: true } | { ok: false; error: string };

export type EmailSender = { send(email: OutgoingEmail): Promise<SendResult> };

/** What the reminder job needs: who may receive, where links point, and how to send. */
export type ReminderMailer = EmailSender & {
  recipients: RecipientAllowlist;
  /** Public origin without a trailing slash, e.g. https://lafija.vercel.app */
  appUrl: string;
};

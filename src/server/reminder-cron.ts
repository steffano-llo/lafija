import "server-only";

import { Receiver } from "@upstash/qstash";
import type { EmailConfig } from "@/lib/env";
import type { ReminderEmailSummary } from "./reminder-emails";

export type ReminderCronDeps = {
  /** The email configuration, or null when email is not configured (→ 503). */
  config: () => EmailConfig | null;
  /** The job; only called after the signature is verified. */
  run: (config: EmailConfig) => Promise<ReminderEmailSummary>;
};

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * QStash calls this every 15 minutes. Order: configuration (503 without it, since there are no keys
 * to verify with), then the `Upstash-Signature` JWT over the raw body with `Receiver.verify`
 * (node_modules/@upstash/qstash/client-DodvH7Uq.d.ts, `Receiver` / `VerifyRequest`): issuer, expiry,
 * HMAC with the current or next signing key, body hash, and subject = `config.cronUrl`. Anything
 * else is 401 before the job (and so the database) is touched. `devMode: false` ignores QSTASH_DEV.
 * A valid signature can be replayed for up to 5 minutes; that only triggers another idempotent run.
 */
export async function handleReminderCron(request: Request, deps: ReminderCronDeps): Promise<Response> {
  const config = deps.config();
  if (!config) return json({ error: "Email reminders are not configured." }, 503);

  const signature = request.headers.get("upstash-signature");
  if (!signature) return json({ error: "Invalid signature." }, 401);
  const body = await request.text();
  const receiver = new Receiver({
    currentSigningKey: config.currentSigningKey,
    nextSigningKey: config.nextSigningKey,
    devMode: false,
  });
  try {
    await receiver.verify({ signature, body, url: config.cronUrl });
  } catch {
    return json({ error: "Invalid signature." }, 401);
  }

  try {
    return json(await deps.run(config), 200);
  } catch (error) {
    // QStash retries on a non-2xx answer. The cause is logged server-side only, never returned.
    console.error("Reminder email job failed:", error instanceof Error ? error.name : "unknown error");
    return json({ error: "The reminder email job failed." }, 500);
  }
}

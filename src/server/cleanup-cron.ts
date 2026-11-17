import "server-only";

import { Receiver } from "@upstash/qstash";
import type { QStashConfig } from "@/lib/env";
import type { DemoCleanupSummary } from "./demo";

export type CleanupCronDeps = {
  /** The QStash keys and this endpoint's URL, or null when the keys are not set (→ 503). */
  config: () => QStashConfig | null;
  /** The cleanup; only called after the signature is verified. */
  run: () => Promise<DemoCleanupSummary>;
};

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * QStash calls this hourly to delete expired demo accounts. Same guard as the reminders cron
 * (`src/server/reminder-cron.ts`): configuration first (503 without the keys, nothing to verify
 * with), then `Receiver.verify` of the `Upstash-Signature` JWT over the raw body with subject =
 * `config.cleanupUrl` (a signature made for the reminders URL is refused). Anything else is 401
 * before the cleanup (and so the database) is touched. Answers counts only.
 */
export async function handleCleanupCron(request: Request, deps: CleanupCronDeps): Promise<Response> {
  const config = deps.config();
  if (!config) return json({ error: "The cleanup job is not configured." }, 503);

  const signature = request.headers.get("upstash-signature");
  if (!signature) return json({ error: "Invalid signature." }, 401);
  const body = await request.text();
  const receiver = new Receiver({
    currentSigningKey: config.currentSigningKey,
    nextSigningKey: config.nextSigningKey,
    devMode: false,
  });
  try {
    await receiver.verify({ signature, body, url: config.cleanupUrl });
  } catch {
    return json({ error: "Invalid signature." }, 401);
  }

  try {
    const { deleted } = await deps.run();
    return json({ deleted }, 200);
  } catch (error) {
    // QStash retries on a non-2xx answer. The cause is logged server-side only, never returned.
    console.error("Demo cleanup failed:", error instanceof Error ? error.name : "unknown error");
    return json({ error: "The cleanup job failed." }, 500);
  }
}

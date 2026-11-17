import { getDb } from "@/db";
import { getEnv, parseQStashEnv } from "@/lib/env";
import { handleCleanupCron } from "@/server/cleanup-cron";
import { deleteExpiredDemoAccounts } from "@/server/demo";

/**
 * QStash schedule target (hourly): deletes expired demo accounts. Only POST is exported, so Next
 * answers other methods with 405. Needs only the two QStash signing keys (503 without them),
 * independent of the email variables; the signature is checked before the database is touched.
 */
export async function POST(request: Request): Promise<Response> {
  return handleCleanupCron(request, {
    config: () => parseQStashEnv(process.env, getEnv().BETTER_AUTH_URL),
    run: () => deleteExpiredDemoAccounts(getDb()),
  });
}

import "server-only";

import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { buildDigestEmail, type DigestItem } from "@/lib/email/digest";
import type { ReminderMailer, SendResult } from "@/lib/email/types";
import type { RecipientAllowlist } from "@/lib/env";
import type { Db } from "./applications";
import { rowsOf } from "./board";

/** Reminders claimed per run at most; the rest wait for the next run (every 15 minutes). */
export const REMINDER_EMAIL_BATCH_SIZE = 200;

/**
 * Counts of reminders (not emails) in one run: `claimed` (marked sent by this run), `sent` (in a
 * digest the provider accepted), `failed` (in a digest that failed; released for the next run) and
 * `skipped` (due, open, unsent, application not archived, but the user opted out or the address is
 * not allowed: never claimed, in-app only).
 */
export type ReminderEmailSummary = { claimed: number; sent: number; failed: number; skipped: number };

type ClaimedRow = {
  id: string;
  userId: string;
  applicationId: string;
  message: string;
  dueAt: string;
  email: string;
  timeZone: string;
  role: string;
  company: string;
};

/**
 * Whether user `u` may receive email: in the allowlist (any case), or, with `*`, any address
 * Better Auth has verified (Google sign-in, or a verified email), so a sign-up cannot direct
 * digests to someone else's mailbox. Users with an opted-out settings row (`us`) never qualify.
 */
function recipientSql(recipients: RecipientAllowlist): SQL {
  const addresses = JSON.stringify(recipients.addresses.map((address) => address.trim().toLowerCase()));
  const listed = sql`lower(u."email") in (select jsonb_array_elements_text(${addresses}::jsonb))`;
  const allowed = recipients.everyone ? sql`(u."email_verified" or ${listed})` : listed;
  return sql`coalesce(us."email_reminders", true) and ${allowed}`;
}

/** Due, open, unsent reminders of non-archived applications, before deciding who may get email. */
function dueSql(now: string): SQL {
  return sql`r."due_at" <= ${now}::timestamptz and r."done_at" is null and r."sent_at" is null and not a."archived"`;
}

const FROM_DUE_REMINDERS = sql`
  from "reminder" r
  join "application" a on a."id" = r."application_id" and a."user_id" = r."user_id"
  join "user" u on u."id" = r."user_id"
  left join "user_settings" us on us."user_id" = r."user_id"
`;

/**
 * One statement that claims due reminders by setting `sent_at = now`: eligible rows are locked with
 * `FOR UPDATE OF r SKIP LOCKED` (a concurrent run skips them instead of waiting or double-sending),
 * oldest due first, at most `batchSize`. Under READ COMMITTED a row changed since the snapshot is
 * re-checked after the lock, so a reminder snoozed, done or claimed meanwhile drops out. Returns
 * what the digests need, ordered by user then due time.
 */
export function claimDueRemindersSql({
  now,
  recipients,
  batchSize,
}: {
  now: Date;
  recipients: RecipientAllowlist;
  batchSize: number;
}): SQL {
  const at = now.toISOString();
  return sql`
    with "eligible" as (
      select r."id" ${FROM_DUE_REMINDERS}
      where ${dueSql(at)} and ${recipientSql(recipients)}
      order by r."due_at", r."id"
      limit ${batchSize}
      for update of r skip locked
    ),
    "claimed" as (
      update "reminder" r set "sent_at" = ${at}::timestamptz
      from "eligible" e
      where r."id" = e."id"
      returning r."id", r."user_id", r."application_id", r."message", r."due_at"
    )
    select c."id", c."user_id" as "userId", c."application_id" as "applicationId", c."message",
      to_char(c."due_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "dueAt",
      u."email", coalesce(us."time_zone", 'UTC') as "timeZone", a."role", co."name" as "company"
    from "claimed" c
    join "user" u on u."id" = c."user_id"
    join "application" a on a."id" = c."application_id" and a."user_id" = c."user_id"
    join "company" co on co."id" = a."company_id" and co."user_id" = a."user_id"
    left join "user_settings" us on us."user_id" = c."user_id"
    order by c."user_id", c."due_at", c."id"
  `;
}

async function countSkipped(db: Db, now: Date, recipients: RecipientAllowlist): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as "count" ${FROM_DUE_REMINDERS}
    where ${dueSql(now.toISOString())} and not (${recipientSql(recipients)})
  `);
  return rowsOf<{ count: number }>(result)[0]?.count ?? 0;
}

/** Puts this run's claims of one user back (sent_at null), so the next run retries them. */
async function releaseClaims(db: Db, userId: string, ids: string[], now: Date): Promise<void> {
  await db.execute(sql`
    update "reminder" set "sent_at" = null
    where "user_id" = ${userId} and "sent_at" = ${now.toISOString()}::timestamptz
      and "id" in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
  `);
}

/**
 * Same user and same reminders at the same due times → same key, so a retry after a lost response
 * is dropped by Resend instead of sent twice; a snoozed or edited reminder has a new due time and
 * therefore a new key.
 */
function idempotencyKey(userId: string, rows: readonly ClaimedRow[]): string {
  const parts = rows.map((row) => `${row.id}@${row.dueAt}`).sort();
  const digest = createHash("sha256").update(`${userId}\n${parts.join("\n")}`).digest("hex");
  return `lafija-reminders-${digest}`;
}

async function safeSend(mailer: ReminderMailer, email: Parameters<ReminderMailer["send"]>[0]): Promise<SendResult> {
  try {
    return await mailer.send(email);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "send failed" };
  }
}

/**
 * Emails due reminders: claims them atomically (see `claimDueRemindersSql`), then sends one digest
 * per user. When a user's digest fails, only that user's claims of this run are released. Users who
 * opted out or whose address is not allowed are never claimed: their reminders stay unsent, in-app.
 */
export async function sendDueReminderEmails(
  db: Db,
  sender: ReminderMailer,
  now: Date = new Date(),
  { batchSize = REMINDER_EMAIL_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<ReminderEmailSummary> {
  const { recipients } = sender;
  const canEmailAnyone = recipients.everyone || recipients.addresses.length > 0;
  const rows = canEmailAnyone
    ? rowsOf<ClaimedRow>(await db.execute(claimDueRemindersSql({ now, recipients, batchSize })))
    : [];

  const byUser = new Map<string, ClaimedRow[]>();
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

  const summary: ReminderEmailSummary = { claimed: rows.length, sent: 0, failed: 0, skipped: 0 };
  for (const [userId, userRows] of byUser) {
    const items: DigestItem[] = userRows.map((row) => ({
      applicationId: row.applicationId,
      company: row.company,
      role: row.role,
      message: row.message,
      dueAt: new Date(row.dueAt),
    }));
    const email = buildDigestEmail({ appUrl: sender.appUrl, timeZone: userRows[0].timeZone, items });
    const result = await safeSend(sender, {
      to: userRows[0].email,
      ...email,
      idempotencyKey: idempotencyKey(userId, userRows),
    });
    if (result.ok) {
      summary.sent += userRows.length;
    } else {
      await releaseClaims(
        db,
        userId,
        userRows.map((row) => row.id),
        now,
      );
      summary.failed += userRows.length;
    }
  }
  summary.skipped = await countSkipped(db, now, recipients);
  return summary;
}

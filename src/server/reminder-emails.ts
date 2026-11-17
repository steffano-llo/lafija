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

/** A claim older than this is taken to belong to a run that died mid-send, and is claimed again (S19). */
export const REMINDER_EMAIL_LEASE_MINUTES = 30;

/**
 * Counts of reminders (not emails) in one run: `claimed` (leased by this run), `sent` (in a digest
 * the provider accepted; now `sent_at`), `failed` (in a digest that failed; lease released for the
 * next run) and `skipped` (due, open, unsent, application not archived, but the recipient rule
 * fails: unverified address, switch off or address not allowed; never claimed, in-app only).
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
 * The S17 recipient rule for user `u` (delivery being configured is implied by running the job):
 * the address is verified (`email_verified`: the verification link, or Google sign-in when Google
 * says so), the switch in the settings row `us` is on (no row = on), and the allowlist has `*` or
 * the address (any case). Listing an address never bypasses verification. Same rule as
 * `reminderEmailProblems` in `src/lib/email/eligibility.ts`, which Settings explains.
 */
function recipientSql(recipients: RecipientAllowlist): SQL {
  const addresses = JSON.stringify(recipients.addresses.map((address) => address.trim().toLowerCase()));
  const allowed = recipients.everyone
    ? sql`true`
    : sql`lower(u."email") in (select jsonb_array_elements_text(${addresses}::jsonb))`;
  return sql`(u."email_verified" and coalesce(us."email_reminders", true) and ${allowed})`;
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

/** Not leased, or leased so long ago that the run holding it must have died (S19). */
function unleasedSql(now: string): SQL {
  return sql`(r."email_claimed_at" is null
    or r."email_claimed_at" < ${now}::timestamptz - make_interval(mins => ${REMINDER_EMAIL_LEASE_MINUTES}))`;
}

/**
 * One statement that leases due reminders by setting `email_claimed_at = now` (S19): due, unsent,
 * and not leased or leased more than 30 minutes ago. Eligible rows are locked with
 * `FOR UPDATE OF r SKIP LOCKED` (a concurrent run skips them instead of waiting or double-sending),
 * oldest due first, at most `batchSize`. Under READ COMMITTED a row changed since the snapshot is
 * re-checked after the lock, so a reminder snoozed, done, sent or leased meanwhile drops out.
 * Returns what the digests need, ordered by user then due time.
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
      where ${dueSql(at)} and ${unleasedSql(at)} and ${recipientSql(recipients)}
      order by r."due_at", r."id"
      limit ${batchSize}
      for update of r skip locked
    ),
    "claimed" as (
      update "reminder" r set "email_claimed_at" = ${at}::timestamptz
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

/**
 * Rows of `ids` still leased by this run (same user, `email_claimed_at` = this run's claim time).
 * A reminder snoozed or given a new due time meanwhile lost its lease, so it is left alone.
 */
function ownClaimsSql(userId: string, ids: string[], now: Date): SQL {
  return sql`"user_id" = ${userId} and "email_claimed_at" = ${now.toISOString()}::timestamptz
    and "id" in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
}

/** The digest was accepted: this run's leases of one user become `sent_at`. */
async function markSent(db: Db, userId: string, ids: string[], now: Date): Promise<void> {
  await db.execute(sql`
    update "reminder" set "sent_at" = ${now.toISOString()}::timestamptz, "email_claimed_at" = null
    where ${ownClaimsSql(userId, ids, now)}
  `);
}

/** The digest failed: releases this run's leases of one user, so the next run retries them. */
async function releaseClaims(db: Db, userId: string, ids: string[], now: Date): Promise<void> {
  await db.execute(sql`update "reminder" set "email_claimed_at" = null where ${ownClaimsSql(userId, ids, now)}`);
}

/**
 * Same user and same reminders at the same due times → same key, so a retry after a lost response,
 * or a re-claim after a crash, is dropped by Resend (within its idempotency window) instead of sent
 * twice. The key never includes the claim time. A snoozed or edited reminder has a new due time and
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
 * Emails due reminders: leases them atomically (see `claimDueRemindersSql`), then sends one digest
 * per user. When a user's digest is accepted, that user's leases of this run become `sent_at`; when
 * it fails, only those leases are released. A run that dies mid-send leaves its leases, which expire
 * after 30 minutes. Users who fail the recipient rule are never claimed: their reminders stay
 * unsent, in-app.
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
    const ids = userRows.map((row) => row.id);
    if (result.ok) {
      await markSent(db, userId, ids, now);
      summary.sent += userRows.length;
    } else {
      await releaseClaims(db, userId, ids, now);
      summary.failed += userRows.length;
    }
  }
  summary.skipped = await countSkipped(db, now, recipients);
  return summary;
}

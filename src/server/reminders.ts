import "server-only";

import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { application, company, reminder, userSettings } from "@/db/schema";
import {
  FOLLOW_UP_DAYS_DEFAULT,
  parseFollowUpSettings,
  parseReminderInput,
  parseSnoozeDays,
  type FollowUpSettingsFieldErrors,
  type ReminderFieldErrors,
  type ReminderKind,
} from "@/lib/validation/reminder";
import { FALLBACK_TIME_ZONE } from "@/lib/validation/settings";
import type { Db } from "./applications";
import { runAtomic } from "./atomic";
import { isId } from "./ids";
import { followUpDueSql } from "./time-zone-sql";

export type Reminder = {
  id: string;
  applicationId: string;
  kind: ReminderKind;
  dueAt: Date;
  message: string;
  /** The transition an automatic follow-up was created for; null for manual reminders. */
  transitionId: string | null;
  sentAt: Date | null;
  /** The user changed the due time (edit or snooze): time zone changes leave it alone. */
  dueCustomized: boolean;
  doneAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  companyName: string;
  role: string;
};

export type ReminderResult =
  | { ok: true; reminder: Reminder }
  | { ok: false; reason: "invalid"; fieldErrors: ReminderFieldErrors }
  | { ok: false; reason: "not_found" };

/**
 * `closed`: a follow-up of an earlier stage (or of an archived application) cannot be reopened.
 * `done`: a done reminder cannot be snoozed; reopen it first.
 */
export type ReminderChangeResult =
  | { ok: true; reminder: Reminder }
  | { ok: false; reason: "invalid" | "not_found" | "closed" | "done" };

export type FollowUpSettingsResult =
  | { ok: true; followUpDays: number | null }
  | { ok: false; reason: "invalid"; fieldErrors: FollowUpSettingsFieldErrors };

export type ReminderLists = { due: Reminder[]; upcoming: Reminder[]; done: Reminder[] };

const notFound = { ok: false, reason: "not_found" } as const;

/** How far back the "Done" list of the reminders page goes. */
export const DONE_LIST_DAYS = 30;

const reminderColumns = {
  id: reminder.id,
  applicationId: reminder.applicationId,
  kind: reminder.kind,
  dueAt: reminder.dueAt,
  message: reminder.message,
  transitionId: reminder.transitionId,
  sentAt: reminder.sentAt,
  dueCustomized: reminder.dueCustomized,
  doneAt: reminder.doneAt,
  createdAt: reminder.createdAt,
  updatedAt: reminder.updatedAt,
  companyName: company.name,
  role: application.role,
};

/**
 * The transition an application's open follow-up belongs to: its latest transition into its
 * current stage. That is its latest transition, except when two concurrent stage changes record
 * their start times out of lock order (`stage_transition.at` is the transaction start); the stage
 * the application is in decides. `a` is the application row's alias.
 */
const currentTransitionSql = (a: SQL): SQL => sql`(
  select st."id" from "stage_transition" st
  where st."application_id" = ${a}."id" and st."user_id" = ${a}."user_id" and st."to_stage_id" = ${a}."stage_id"
  order by st."at" desc, (st."from_stage_id" is not null) desc, st."id" desc
  limit 1
)`;

/**
 * The follow-up step of a stage change (create, board move, edit-form stage change). Callers run
 * it right after the statement that locks and writes the application, in the same transaction
 * (`runAtomic`). It acts only on a transition of this application written in this transaction:
 * `stage_transition.at` defaults to `now()`, which Postgres fixes for the whole transaction, so
 * `at = now()` finds it. No such transition (a refused write, a reorder within a column, an edit
 * that keeps the stage) means the statement changes nothing.
 *
 * With that transition, the wanted state is one open follow-up for it when the application is not
 * archived, its stage's category is `active` and the user's follow-up days are not off (the setting
 * only gates creation, so changing it applies to later transitions only). The statement closes
 * every other open follow-up of the application and inserts the wanted one, due at 09:00 in the
 * user's time zone (UTC while none is stored) on the transition's local date plus that many days
 * (`followUpDueSql`), unless a follow-up of that transition already exists, open or done: one
 * the user marked done stays done. Idempotent. Under READ COMMITTED it reads a snapshot taken after
 * the row lock, so it sees whatever a concurrent writer of the same application committed first.
 */
export function syncFollowUpSql(userId: string, applicationId: string): SQL {
  return sql`
    with "fresh" as (
      select st."id", st."at", a."user_id", a."id" as "application_id", a."stage_id", a."company_id",
        a."role", a."archived"
      from "stage_transition" st
      join "application" a on a."id" = st."application_id" and a."user_id" = st."user_id"
        and a."stage_id" = st."to_stage_id"
      where st."application_id" = ${applicationId} and st."user_id" = ${userId} and st."at" = now()
      order by (st."from_stage_id" is not null) desc, st."id" desc
      limit 1
    ),
    "wanted" as (
      select fr."application_id", fr."user_id", fr."id" as "transition_id",
        ${followUpDueSql(sql`fr."at"`, sql`f."days"`, sql`f."tz"`)} as "due_at",
        left('Follow up with ' || co."name" || ' about ' || fr."role", 500) as "message"
      from "fresh" fr
      join "stage" s on s."id" = fr."stage_id" and s."user_id" = fr."user_id" and s."category" = 'active'
      join "company" co on co."id" = fr."company_id" and co."user_id" = fr."user_id"
      cross join lateral (
        -- No settings row means the default; a row with null means follow-ups are off.
        select case when us."user_id" is null then ${FOLLOW_UP_DAYS_DEFAULT}::int else us."follow_up_days" end as "days",
          coalesce(us."time_zone", ${FALLBACK_TIME_ZONE}) as "tz"
        from (select 1) as "one" left join "user_settings" us on us."user_id" = fr."user_id"
      ) f
      where not fr."archived" and f."days" is not null
    ),
    "closed" as (
      update "reminder" r set "done_at" = now(), "updated_at" = now()
      where r."application_id" = ${applicationId} and r."user_id" = ${userId}
        and r."kind" = 'follow_up' and r."done_at" is null
        and exists (select 1 from "fresh")
        and r."transition_id" is distinct from (select w."transition_id" from "wanted" w)
      returning r."id"
    ),
    "created" as (
      insert into "reminder" ("id", "user_id", "application_id", "kind", "due_at", "message", "transition_id")
      select gen_random_uuid()::text, w."user_id", w."application_id", 'follow_up', w."due_at", w."message", w."transition_id"
      from "wanted" w
      -- Reading the closed rows makes the close run first, so the "one open follow-up per
      -- application" index never sees the old and the new one open together.
      cross join (select count(*) from "closed") as "closed_count"
      where not exists (
        select 1 from "reminder" r where r."kind" = 'follow_up' and r."transition_id" = w."transition_id"
      )
      returning "id"
    )
    select (select count(*) from "closed")::int as "closed", (select count(*) from "created")::int as "created"
  `;
}

/**
 * The follow-up step of archiving, run after the archive update in the same transaction: closes
 * the application's open follow-up only if the application is archived (and the user's), so a
 * refused archive changes nothing. Idempotent.
 */
export function closeArchivedFollowUpSql(userId: string, applicationId: string): SQL {
  return sql`
    update "reminder" r set "done_at" = now(), "updated_at" = now()
    where r."application_id" = ${applicationId} and r."user_id" = ${userId}
      and r."kind" = 'follow_up' and r."done_at" is null
      and exists (
        select 1 from "application" a
        where a."id" = r."application_id" and a."user_id" = r."user_id" and a."archived"
      )
    returning r."id"
  `;
}

/**
 * Runs one follow-up step on its own (tests): `transition` is `syncFollowUpSql`, `archive` is
 * `closeArchivedFollowUpSql`. Writers batch them after their statement instead.
 */
export async function syncFollowUp(
  db: Db,
  userId: string,
  applicationId: string,
  step: "transition" | "archive" = "transition",
): Promise<void> {
  await db.execute(
    step === "archive" ? closeArchivedFollowUpSql(userId, applicationId) : syncFollowUpSql(userId, applicationId),
  );
}

/** True for a unique violation (23505), raw or wrapped by Drizzle in `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

// Every query below filters by `userId`: callers pass the id returned by `requireUser()`.

async function ownsApplication(db: Db, userId: string, applicationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: application.id })
    .from(application)
    .where(and(eq(application.userId, userId), eq(application.id, applicationId)))
    .limit(1);
  return Boolean(row);
}

function selectReminders(db: Db) {
  return db
    .select(reminderColumns)
    .from(reminder)
    .innerJoin(application, and(eq(application.id, reminder.applicationId), eq(application.userId, reminder.userId)))
    .innerJoin(company, and(eq(company.id, application.companyId), eq(company.userId, application.userId)));
}

async function getReminder(db: Db, userId: string, id: string): Promise<Reminder | null> {
  const [row] = await selectReminders(db)
    .where(and(eq(reminder.userId, userId), eq(reminder.id, id)))
    .limit(1);
  return row ?? null;
}

async function loaded(db: Db, userId: string, id: string): Promise<{ ok: true; reminder: Reminder } | typeof notFound> {
  const row = await getReminder(db, userId, id);
  return row ? { ok: true, reminder: row } : notFound;
}

/** Reminders of the user's application: open ones by due time, then done ones; null when not theirs. */
export async function listApplicationReminders(
  db: Db,
  userId: string,
  applicationId: string,
): Promise<Reminder[] | null> {
  if (!isId(applicationId) || !(await ownsApplication(db, userId, applicationId))) return null;
  return selectReminders(db)
    .where(and(eq(reminder.userId, userId), eq(reminder.applicationId, applicationId)))
    .orderBy(sql`${reminder.doneAt} is not null`, asc(reminder.dueAt), asc(reminder.createdAt), asc(reminder.id));
}

/**
 * The user's reminders of non-archived applications: due (due now or earlier, not done), upcoming
 * (later, not done) and done in the last 30 days (most recently done first).
 */
export async function listReminders(db: Db, userId: string): Promise<ReminderLists> {
  const own = and(eq(reminder.userId, userId), eq(application.archived, false));
  const [open, done] = await Promise.all([
    db
      // "Now" is the database's, as in the due count, so both agree on what is due.
      .select({ ...reminderColumns, isDue: sql<boolean>`${reminder.dueAt} <= now()` })
      .from(reminder)
      .innerJoin(application, and(eq(application.id, reminder.applicationId), eq(application.userId, reminder.userId)))
      .innerJoin(company, and(eq(company.id, application.companyId), eq(company.userId, application.userId)))
      .where(and(own, isNull(reminder.doneAt)))
      .orderBy(asc(reminder.dueAt), asc(reminder.createdAt), asc(reminder.id)),
    selectReminders(db)
      .where(
        and(
          own,
          isNotNull(reminder.doneAt),
          gte(reminder.doneAt, sql`now() - make_interval(days => ${DONE_LIST_DAYS}::int)`),
        ),
      )
      .orderBy(desc(reminder.doneAt), asc(reminder.id)),
  ]);
  const withoutFlag = (row: Reminder & { isDue: boolean }): Reminder => {
    const { isDue, ...rest } = row;
    void isDue;
    return rest;
  };
  return {
    due: open.filter((r) => r.isDue).map(withoutFlag),
    upcoming: open.filter((r) => !r.isDue).map(withoutFlag),
    done,
  };
}

/** Number of the user's reminders that are due now and not done, on non-archived applications. */
export async function countDueReminders(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reminder)
    .innerJoin(application, and(eq(application.id, reminder.applicationId), eq(application.userId, reminder.userId)))
    .where(
      and(
        eq(reminder.userId, userId),
        isNull(reminder.doneAt),
        lte(reminder.dueAt, sql`now()`),
        eq(application.archived, false),
      ),
    );
  return row?.n ?? 0;
}

/** Adds a manual reminder to the user's application. */
export async function createReminder(
  db: Db,
  userId: string,
  applicationId: string,
  input: unknown,
): Promise<ReminderResult> {
  if (!isId(applicationId) || !(await ownsApplication(db, userId, applicationId))) return notFound;
  const parsed = parseReminderInput(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  // The composite foreign key (application_id, user_id) also refuses another user's application.
  const [row] = await db
    .insert(reminder)
    .values({ userId, applicationId, kind: "manual", dueAt: parsed.data.dueAt, message: parsed.data.message })
    .returning({ id: reminder.id });
  return row ? loaded(db, userId, row.id) : notFound;
}

/**
 * Replaces the due time and message of the user's reminder; a new due time is emailed again (clears
 * `sent_at` and any email lease). The form submits whole minutes, so a due time in the same UTC
 * minute as the stored one counts as unchanged: the stored value, `sent_at`, the lease and
 * `due_customized` stay (editing only the message is not
 * a new due time). A new due time marks it customized, so a time zone change never moves it.
 */
export async function updateReminder(db: Db, userId: string, id: string, input: unknown): Promise<ReminderResult> {
  if (!isId(id)) return notFound;
  const parsed = parseReminderInput(input);
  if (!parsed.success) {
    return (await getReminder(db, userId, id))
      ? { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors }
      : notFound;
  }
  const { dueAt, message } = parsed.data;
  const sameMinute = sql`date_trunc('minute', ${reminder.dueAt} at time zone 'UTC')
    = date_trunc('minute', ${dueAt.toISOString()}::timestamptz at time zone 'UTC')`;
  const [row] = await db
    .update(reminder)
    .set({
      dueAt: sql`case when ${sameMinute} then ${reminder.dueAt} else ${dueAt.toISOString()}::timestamptz end`,
      message,
      sentAt: sql`case when ${sameMinute} then ${reminder.sentAt} else null end`,
      emailClaimedAt: sql`case when ${sameMinute} then ${reminder.emailClaimedAt} else null end`,
      dueCustomized: sql`case when ${sameMinute} then ${reminder.dueCustomized} else true end`,
    })
    .where(and(eq(reminder.userId, userId), eq(reminder.id, id)))
    .returning({ id: reminder.id });
  return row ? loaded(db, userId, row.id) : notFound;
}

/**
 * Marks the user's reminder done (`true`) or not done (`false`). A follow-up can only be reopened
 * while it belongs to the application's current transition (`currentTransitionSql`) and the
 * application is not archived, so an application never has two open follow-ups or one from a stage
 * it has left. The reopen first locks the application row, like every stage change does, so it
 * runs entirely before or after a concurrent move and its check reads a snapshot from after the
 * lock. If another follow-up of the application is open anyway, the unique index refuses the
 * reopen and the result is `closed`, with nothing changed.
 */
export async function setReminderDone(db: Db, userId: string, id: string, done: unknown): Promise<ReminderChangeResult> {
  if (!isId(id)) return notFound;
  if (typeof done !== "boolean") return (await getReminder(db, userId, id)) ? { ok: false, reason: "invalid" } : notFound;
  const own = and(eq(reminder.userId, userId), eq(reminder.id, id));
  if (done) {
    const [row] = await db
      .update(reminder)
      .set({ doneAt: sql`coalesce(${reminder.doneAt}, now())` })
      .where(own)
      .returning({ id: reminder.id });
    return row ? loaded(db, userId, row.id) : notFound;
  }
  const lock = sql`
    select a."id" from "application" a
    where a."user_id" = ${userId}
      and a."id" = (select r."application_id" from "reminder" r where r."id" = ${id} and r."user_id" = ${userId})
    for update of a
  `;
  const reopen = sql`
    update "reminder" r set "done_at" = null, "updated_at" = now()
    where r."id" = ${id} and r."user_id" = ${userId}
      and (
        r."done_at" is null
        or r."kind" = 'manual'
        or exists (
          select 1 from "application" a
          where a."id" = r."application_id" and a."user_id" = r."user_id" and a."archived" = false
            and r."transition_id" = ${currentTransitionSql(sql`a`)}
        )
      )
    returning r."id"
  `;
  let reopened: unknown[];
  try {
    [, reopened] = await runAtomic(db, [lock, reopen]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    reopened = [];
  }
  if (reopened.length > 0) return loaded(db, userId, id);
  return (await getReminder(db, userId, id)) ? { ok: false, reason: "closed" } : notFound;
}

/**
 * Moves the due time of the user's open reminder to 1, 3 or 7 days from now (not from its due
 * time); it is emailed again (clears `sent_at` and any email lease) and counts as customized.
 */
export async function snoozeReminder(db: Db, userId: string, id: string, days: unknown): Promise<ReminderChangeResult> {
  if (!isId(id)) return notFound;
  const parsed = parseSnoozeDays(days);
  if (parsed === null) return (await getReminder(db, userId, id)) ? { ok: false, reason: "invalid" } : notFound;
  const [row] = await db
    .update(reminder)
    .set({
      dueAt: sql`now() + make_interval(days => ${parsed}::int)`,
      sentAt: null,
      emailClaimedAt: null,
      dueCustomized: true,
    })
    .where(and(eq(reminder.userId, userId), eq(reminder.id, id), isNull(reminder.doneAt)))
    .returning({ id: reminder.id });
  if (row) return loaded(db, userId, row.id);
  return (await getReminder(db, userId, id)) ? { ok: false, reason: "done" } : notFound;
}

export async function deleteReminder(db: Db, userId: string, id: string): Promise<{ ok: true } | typeof notFound> {
  if (!isId(id)) return notFound;
  const deleted = await db
    .delete(reminder)
    .where(and(eq(reminder.userId, userId), eq(reminder.id, id)))
    .returning({ id: reminder.id });
  return deleted.length > 0 ? { ok: true } : notFound;
}

/** Days after a move into an active stage before its follow-up is due; null when off. */
export async function getFollowUpDays(db: Db, userId: string): Promise<number | null> {
  const [row] = await db
    .select({ followUpDays: userSettings.followUpDays })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row ? row.followUpDays : FOLLOW_UP_DAYS_DEFAULT;
}

/**
 * Sets the user's follow-up days (1-60) or turns automatic follow-ups off. Forward only: existing
 * reminders are never touched, now or later; the setting only decides whether, and when due, a
 * follow-up is created for later transitions into an active stage.
 */
export async function setFollowUpDays(db: Db, userId: string, input: unknown): Promise<FollowUpSettingsResult> {
  const parsed = parseFollowUpSettings(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  const { followUpDays } = parsed.data;
  await db
    .insert(userSettings)
    .values({ userId, followUpDays })
    .onConflictDoUpdate({ target: userSettings.userId, set: { followUpDays, updatedAt: new Date() } });
  return { ok: true, followUpDays };
}

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
import type { Db } from "./applications";
import { isId } from "./ids";

export type Reminder = {
  id: string;
  applicationId: string;
  kind: ReminderKind;
  dueAt: Date;
  message: string;
  /** The transition an automatic follow-up was created for; null for manual reminders. */
  transitionId: string | null;
  sentAt: Date | null;
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
  doneAt: reminder.doneAt,
  createdAt: reminder.createdAt,
  updatedAt: reminder.updatedAt,
  companyName: company.name,
  role: application.role,
};

/**
 * CTEs that keep automatic follow-ups in step with stage changes. They go in the same statement as
 * the change, after a CTE named "logged" that returns the new transitions as
 * ("id", "user_id", "application_id", "to_stage_id", "at"). For each transition they close the
 * application's open follow-up and, when the target stage's category is `active`, the application is
 * not archived and the user's follow-up days are not off, insert a follow-up due that many days
 * after the transition. `message` is the follow-up text when the caller knows it (the application
 * row is not visible to the statement on create, or still has the old company and role on edit);
 * null builds it from the stored application.
 */
export function followUpCtes(message: string | null): SQL {
  const messageSql =
    message === null
      ? sql`(
          select left('Follow up with ' || co."name" || ' about ' || ap."role", 500)
          from "application" ap join "company" co on co."id" = ap."company_id" and co."user_id" = ap."user_id"
          where ap."id" = l."application_id" and ap."user_id" = l."user_id"
        )`
      : sql`${message}::text`;
  return sql`
    "follow_up_closed" as (
      update "reminder" r set "done_at" = now(), "updated_at" = now()
      from "logged" l
      where r."application_id" = l."application_id" and r."user_id" = l."user_id"
        and r."kind" = 'follow_up' and r."done_at" is null
      returning r."id"
    ),
    "follow_up_created" as (
      insert into "reminder" ("id", "user_id", "application_id", "kind", "due_at", "message", "transition_id")
      select gen_random_uuid()::text, l."user_id", l."application_id", 'follow_up',
        l."at" + make_interval(days => f."days"), ${messageSql}, l."id"
      from "logged" l
      join "stage" s on s."id" = l."to_stage_id" and s."user_id" = l."user_id" and s."category" = 'active'
      cross join lateral (
        -- No settings row means the default; a row with null means follow-ups are off.
        select case when us."user_id" is null then ${FOLLOW_UP_DAYS_DEFAULT}::int else us."follow_up_days" end as "days"
        from (select 1) as "one" left join "user_settings" us on us."user_id" = l."user_id"
      ) f
      -- Reading the closed rows makes the close run first, so the "one open follow-up per
      -- application" index never sees the old and the new one open together.
      cross join (select count(*) from "follow_up_closed") as "closed_count"
      where f."days" is not null
        and not exists (
          select 1 from "application" ap
          where ap."id" = l."application_id" and ap."user_id" = l."user_id" and ap."archived"
        )
      returning "id"
    )
  `;
}

/** Closes the open follow-up of applications returned by a CTE named "archived" ("id", "user_id"). */
export const closeFollowUpsOfArchivedCte: SQL = sql`
  "follow_up_closed" as (
    update "reminder" r set "done_at" = now(), "updated_at" = now()
    from "archived" a
    where r."application_id" = a."id" and r."user_id" = a."user_id"
      and r."kind" = 'follow_up' and r."done_at" is null
    returning r."id"
  )
`;

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

/** Replaces the due time and message of the user's reminder; a new due time is emailed again. */
export async function updateReminder(db: Db, userId: string, id: string, input: unknown): Promise<ReminderResult> {
  if (!isId(id)) return notFound;
  const parsed = parseReminderInput(input);
  if (!parsed.success) {
    return (await getReminder(db, userId, id))
      ? { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors }
      : notFound;
  }
  const { dueAt, message } = parsed.data;
  const [row] = await db
    .update(reminder)
    .set({
      dueAt,
      message,
      sentAt: sql`case when ${reminder.dueAt} = ${dueAt.toISOString()}::timestamptz then ${reminder.sentAt} else null end`,
    })
    .where(and(eq(reminder.userId, userId), eq(reminder.id, id)))
    .returning({ id: reminder.id });
  return row ? loaded(db, userId, row.id) : notFound;
}

/**
 * Marks the user's reminder done (`true`) or not done (`false`). A follow-up can only be reopened
 * while it belongs to the application's latest transition and the application is not archived, so
 * an application never has two open follow-ups or one from a stage it has left.
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
  const reopenable = sql`(
    ${reminder.doneAt} is null
    or ${reminder.kind} = 'manual'
    or (
      exists (
        select 1 from "application" a
        where a."id" = ${reminder.applicationId} and a."user_id" = ${reminder.userId} and a."archived" = false
      )
      and ${reminder.transitionId} = (
        select st."id" from "stage_transition" st
        where st."application_id" = ${reminder.applicationId} and st."user_id" = ${reminder.userId}
        order by st."at" desc, (st."from_stage_id" is not null) desc, st."id" desc
        limit 1
      )
    )
  )`;
  const [row] = await db
    .update(reminder)
    .set({ doneAt: null })
    .where(and(own, reopenable))
    .returning({ id: reminder.id });
  if (row) return loaded(db, userId, row.id);
  return (await getReminder(db, userId, id)) ? { ok: false, reason: "closed" } : notFound;
}

/** Moves the due time of the user's open reminder to 1, 3 or 7 days from now; it is emailed again. */
export async function snoozeReminder(db: Db, userId: string, id: string, days: unknown): Promise<ReminderChangeResult> {
  if (!isId(id)) return notFound;
  const parsed = parseSnoozeDays(days);
  if (parsed === null) return (await getReminder(db, userId, id)) ? { ok: false, reason: "invalid" } : notFound;
  const [row] = await db
    .update(reminder)
    .set({ dueAt: sql`now() + make_interval(days => ${parsed}::int)`, sentAt: null })
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

/** Sets the user's follow-up days (1-60) or turns automatic follow-ups off. Existing reminders stay. */
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

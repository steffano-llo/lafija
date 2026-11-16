import "server-only";

import { eq, sql } from "drizzle-orm";
import { userSettings } from "@/db/schema";
import { FOLLOW_UP_DAYS_DEFAULT } from "@/lib/validation/reminder";
import {
  DEFAULT_CURRENCY,
  FALLBACK_TIME_ZONE,
  isTimeZoneShape,
  parseCurrencySettings,
  parseEmailRemindersSettings,
  parseTimeZoneSettings,
  TIME_ZONE_INVALID_MESSAGE,
  type CurrencyFieldErrors,
  type EmailRemindersFieldErrors,
  type TimeZoneFieldErrors,
} from "@/lib/validation/settings";
import type { Db } from "./applications";
import { runAtomic } from "./atomic";
import { rowsOf } from "./board";
import { followUpDueSql } from "./time-zone-sql";

export type UserSettings = { followUpDays: number | null; timeZone: string | null; defaultCurrency: string };

export type TimeZoneResult =
  | { ok: true; timeZone: string }
  | { ok: false; reason: "invalid"; fieldErrors: TimeZoneFieldErrors };

export type DetectTimeZoneResult = { ok: true; saved: boolean } | { ok: false; reason: "invalid" };

export type CurrencyResult =
  | { ok: true; defaultCurrency: string }
  | { ok: false; reason: "invalid"; fieldErrors: CurrencyFieldErrors };

// Every query below filters by `userId`: callers pass the id returned by `requireUser()`.

/** The user's preferences; no settings row means the defaults (7 days, zone unknown, USD). */
export async function getUserSettings(db: Db, userId: string): Promise<UserSettings> {
  const [row] = await db
    .select({
      followUpDays: userSettings.followUpDays,
      timeZone: userSettings.timeZone,
      defaultCurrency: userSettings.defaultCurrency,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row ?? { followUpDays: FOLLOW_UP_DAYS_DEFAULT, timeZone: null, defaultCurrency: DEFAULT_CURRENCY };
}

/** Zone names Postgres accepts in `at time zone`, sorted; what the Settings select offers. */
export async function listTimeZones(db: Db): Promise<string[]> {
  const result = await db.execute(sql`
    select "name" from pg_timezone_names where "name" !~ '^(posix|right)/' order by "name" collate "C"
  `);
  return rowsOf<{ name: string }>(result).map((row) => row.name);
}

async function timeZoneExists(db: Db, timeZone: string): Promise<boolean> {
  const result = await db.execute(sql`select exists (select 1 from pg_timezone_names where "name" = ${timeZone}) as "ok"`);
  return rowsOf<{ ok: boolean }>(result)[0]?.ok === true;
}

/**
 * Saves the user's zone and, when it was saved, realigns their open, unsent, non-customized
 * follow-ups to 09:00 in it, keeping each one's number of days (its local due date minus its
 * transition's local date, both in the previous zone). Two statements in one transaction: the
 * first creates or locks the settings row, so the second reads the zone in force after the lock
 * (a concurrent change waits). `onlyIfUnset` keeps a stored zone: detection never overwrites.
 */
async function saveTimeZone(db: Db, userId: string, timeZone: string, onlyIfUnset: boolean): Promise<boolean> {
  const lock = sql`
    insert into "user_settings" ("user_id") values (${userId})
    on conflict ("user_id") do update set "updated_at" = "user_settings"."updated_at"
    returning "user_id"
  `;
  const save = sql`
    with "previous" as (
      select coalesce(us."time_zone", ${FALLBACK_TIME_ZONE}) as "tz" from "user_settings" us where us."user_id" = ${userId}
    ),
    "saved" as (
      update "user_settings" us set "time_zone" = ${timeZone}, "updated_at" = now()
      where us."user_id" = ${userId}
        and (${!onlyIfUnset}::boolean or us."time_zone" is null)
        and exists (select 1 from pg_timezone_names where "name" = ${timeZone})
      returning us."time_zone" as "tz"
    ),
    "realigned" as (
      update "reminder" r set
        "due_at" = ${followUpDueSql(
          sql`st."at"`,
          sql`(r."due_at" at time zone p."tz")::date - (st."at" at time zone p."tz")::date`,
          sql`s."tz"`,
        )},
        "updated_at" = now()
      from "saved" s, "previous" p, "stage_transition" st
      where r."user_id" = ${userId} and r."kind" = 'follow_up' and r."done_at" is null and r."sent_at" is null
        and not r."due_customized"
        and st."id" = r."transition_id" and st."user_id" = r."user_id"
      returning r."id"
    )
    select (select count(*) from "saved")::int as "saved", (select count(*) from "realigned")::int as "realigned"
  `;
  const [, [result]] = await runAtomic(db, [lock, save]);
  return (result as { saved: number }).saved > 0;
}

/**
 * Stores the zone the browser reports, only while the user has none: a zone the user chose (or
 * detected earlier) is never overwritten. An unknown zone is refused before anything is written.
 */
export async function saveDetectedTimeZone(db: Db, userId: string, timeZone: unknown): Promise<DetectTimeZoneResult> {
  if (!isTimeZoneShape(timeZone) || !(await timeZoneExists(db, timeZone))) return { ok: false, reason: "invalid" };
  return { ok: true, saved: await saveTimeZone(db, userId, timeZone, true) };
}

/** Sets the user's zone from Settings and realigns their follow-ups (see `saveTimeZone`). */
export async function setTimeZone(db: Db, userId: string, input: unknown): Promise<TimeZoneResult> {
  const parsed = parseTimeZoneSettings(input);
  if (!parsed.success || !(await timeZoneExists(db, parsed.data.timeZone))) {
    return { ok: false, reason: "invalid", fieldErrors: { timeZone: [TIME_ZONE_INVALID_MESSAGE] } };
  }
  await saveTimeZone(db, userId, parsed.data.timeZone, false);
  return { ok: true, timeZone: parsed.data.timeZone };
}

/** Sets the currency preselected for new salaries; existing applications keep theirs. */
export async function setDefaultCurrency(db: Db, userId: string, input: unknown): Promise<CurrencyResult> {
  const parsed = parseCurrencySettings(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  const { defaultCurrency } = parsed.data;
  await db
    .insert(userSettings)
    .values({ userId, defaultCurrency })
    .onConflictDoUpdate({ target: userSettings.userId, set: { defaultCurrency, updatedAt: new Date() } });
  return { ok: true, defaultCurrency };
}

export type EmailRemindersResult =
  | { ok: true; emailReminders: boolean }
  | { ok: false; reason: "invalid"; fieldErrors: EmailRemindersFieldErrors };

/** Whether the user's due reminders are emailed (no settings row = on). */
export async function getEmailReminders(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailReminders: userSettings.emailReminders })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row?.emailReminders ?? true;
}

/** Turns reminder emails on or off for this user only; reminders stay in-app either way. */
export async function setEmailReminders(db: Db, userId: string, input: unknown): Promise<EmailRemindersResult> {
  const parsed = parseEmailRemindersSettings(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  const { emailReminders } = parsed.data;
  await db
    .insert(userSettings)
    .values({ userId, emailReminders })
    .onConflictDoUpdate({ target: userSettings.userId, set: { emailReminders, updatedAt: new Date() } });
  return { ok: true, emailReminders };
}

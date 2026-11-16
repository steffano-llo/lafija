import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { FALLBACK_TIME_ZONE } from "@/lib/validation/settings";

/** The user's time zone for SQL date rules: the stored one, else UTC. */
export function userTimeZoneSql(userId: string): SQL {
  return sql`coalesce((select us."time_zone" from "user_settings" us where us."user_id" = ${userId}), ${FALLBACK_TIME_ZONE})`;
}

/**
 * Follow-up due time: 09:00 in `tz` on the local date of `at` in `tz` plus `days` days. Postgres
 * applies the zone's offset (DST included) on that date.
 */
export function followUpDueSql(at: SQL, days: SQL, tz: SQL): SQL {
  return sql`(((((${at}) at time zone ${tz})::date + (${days})) + time '09:00') at time zone ${tz})`;
}

/** Today's date in the user's time zone (the transaction's `now()`, the time its transition gets). */
export function userLocalDateSql(userId: string): SQL {
  return sql`(now() at time zone ${userTimeZoneSql(userId)})::date`;
}

/**
 * True when the stage comes after the user's first stage: its position is greater than the
 * smallest position among the user's non-archived stages (applied-date autofill, S13).
 */
export function isAfterFirstStageSql(userId: string, stageId: SQL): SQL {
  return sql`coalesce((
    (select s."position" from "stage" s where s."id" = ${stageId} and s."user_id" = ${userId})
    > (select min(s."position") from "stage" s where s."user_id" = ${userId} and s."archived" = false)
  ), false)`;
}

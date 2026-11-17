import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { StageCategory } from "@/lib/validation/stage";
import type { Db } from "./applications";
import { rowsOf } from "./board";
import { userTimeZoneSql } from "./time-zone-sql";

/**
 * Search statistics (S5), computed in SQL from `stage_transition`, stage categories and positions,
 * and `application`; never from stage names. Every query filters by `userId` (callers pass the id
 * returned by `requireUser()`), on every table it reads. Definitions are documented in the README.
 */

export type StatsOptions = {
  /** History metrics (everything but totals per stage) include archived applications. Default true. */
  includeArchived?: boolean;
  /** Reference instant for "until now" and "the last 12 weeks". Default: the current time. */
  now?: Date;
};

export type StageTotal = { stageId: string; name: string; category: StageCategory; count: number };
export type ResponseRate = { total: number; responded: number; rate: number | null };
export type Funnel = { total: number; responded: number; offer: number; accepted: number };
export type StageDuration = {
  stageId: string;
  name: string;
  category: StageCategory;
  archived: boolean;
  /** Mean days in the stage, one decimal (half rounded up). */
  averageDays: number;
  /** Number of stays measured. */
  samples: number;
};
export type WeekCount = { weekStart: string; count: number };
export type SourceStats = { source: string; count: number; responded: number; rate: number };

export type Stats = {
  includeArchived: boolean;
  timeZone: string;
  totalApplications: number;
  stageTotals: StageTotal[];
  responseRate: ResponseRate;
  funnel: Funnel;
  averageTimeInStage: StageDuration[];
  weekly: WeekCount[];
  sources: SourceStats[];
};

export const UNKNOWN_SOURCE = "Unknown";
export const WEEKS = 12;

function resolve(options: StatsOptions = {}) {
  return { includeArchived: options.includeArchived ?? true, now: options.now ?? new Date() };
}

function nowSql(now: Date): SQL {
  return sql`${now.toISOString()}::timestamptz`;
}

/** The user's applications in scope: all of them, or only non-archived ones. */
function appScopeSql(userId: string, includeArchived: boolean): SQL {
  return includeArchived
    ? sql`a."user_id" = ${userId}`
    : sql`a."user_id" = ${userId} and a."archived" = false`;
}

/**
 * One row per application in scope with what it ever reached, from its transitions:
 * `responded` = a stage whose position is greater than the user's first stage (lowest position
 * among non-archived stages, read now); `offer` / `accepted` = a stage of that category.
 */
function applicationFlagsSql(userId: string, includeArchived: boolean): SQL {
  return sql`
    select
      a."id",
      coalesce(nullif(btrim(a."source"), ''), ${UNKNOWN_SOURCE}) as "source",
      coalesce(bool_or(s."position" > f."position"), false) as "responded",
      coalesce(bool_or(s."category" = 'offer'), false) as "offer",
      coalesce(bool_or(s."category" = 'accepted'), false) as "accepted"
    from "application" a
    cross join (
      select min(fs."position") as "position" from "stage" fs where fs."user_id" = ${userId} and fs."archived" = false
    ) f
    left join "stage_transition" t on t."application_id" = a."id" and t."user_id" = ${userId}
    left join "stage" s on s."id" = t."to_stage_id" and s."user_id" = ${userId}
    where ${appScopeSql(userId, includeArchived)}
    group by a."id", a."source"
  `;
}

/** Current non-archived applications per non-archived stage, in stage order (zero included). */
export async function getStageTotals(db: Db, userId: string): Promise<StageTotal[]> {
  const result = await db.execute(sql`
    select s."id" as "stageId", s."name", s."category", count(a."id")::int as "count"
    from "stage" s
    left join "application" a on a."stage_id" = s."id" and a."user_id" = ${userId} and a."archived" = false
    where s."user_id" = ${userId} and s."archived" = false
    group by s."id", s."name", s."category", s."position"
    order by s."position", s."id"
  `);
  return rowsOf<StageTotal>(result);
}

/** Applications that ever reached a stage after the user's first stage, over all applications in scope. */
export async function getResponseRate(db: Db, userId: string, options?: StatsOptions): Promise<ResponseRate> {
  const { total, responded } = await getFunnel(db, userId, options);
  return { total, responded, rate: total === 0 ? null : responded / total };
}

/** Applications → ever after the first stage → ever in an offer stage → ever in an accepted stage. */
export async function getFunnel(db: Db, userId: string, options?: StatsOptions): Promise<Funnel> {
  const { includeArchived } = resolve(options);
  const result = await db.execute(sql`
    select
      count(*)::int as "total",
      count(*) filter (where f."responded")::int as "responded",
      count(*) filter (where f."offer")::int as "offer",
      count(*) filter (where f."accepted")::int as "accepted"
    from (${applicationFlagsSql(userId, includeArchived)}) f
  `);
  return rowsOf<Funnel>(result)[0];
}

/**
 * Per stage (archived stages too), the mean time between entering it and the application's next
 * transition. The current stay counts until `now` for non-archived applications; an archived
 * application's last stay has no end we know of (archiving records no transition), so it is left
 * out. Stages without any measured stay are not returned. Ordered by stage position.
 */
export async function getAverageTimeInStage(db: Db, userId: string, options?: StatsOptions): Promise<StageDuration[]> {
  const { includeArchived, now } = resolve(options);
  const result = await db.execute(sql`
    with "stays" as (
      select
        t."to_stage_id",
        t."at",
        lead(t."at") over (partition by t."application_id" order by t."at", t."id") as "next_at",
        a."archived"
      from "stage_transition" t
      join "application" a on a."id" = t."application_id" and ${appScopeSql(userId, includeArchived)}
      where t."user_id" = ${userId}
    )
    select
      s."id" as "stageId",
      s."name",
      s."category",
      s."archived",
      round(
        avg(extract(epoch from greatest(coalesce(st."next_at", ${nowSql(now)}) - st."at", interval '0'))) / 86400,
        1
      )::float8 as "averageDays",
      count(*)::int as "samples"
    from "stays" st
    join "stage" s on s."id" = st."to_stage_id" and s."user_id" = ${userId}
    where st."next_at" is not null or st."archived" = false
    group by s."id", s."name", s."category", s."archived", s."position"
    order by s."position", s."id"
  `);
  return rowsOf<StageDuration>(result);
}

/**
 * Applications per week for the last 12 weeks (the current one included), oldest first, zero-filled.
 * The date is the applied date, else the creation date in the user's time zone (UTC when unknown);
 * weeks start on Monday and "now" is read in the same zone.
 */
export async function getWeeklyApplications(db: Db, userId: string, options?: StatsOptions): Promise<WeekCount[]> {
  const { includeArchived, now } = resolve(options);
  const result = await db.execute(sql`
    with "tz" as (select ${userTimeZoneSql(userId)} as "name"),
    "today" as (select ((${nowSql(now)}) at time zone "tz"."name")::date as "d" from "tz"),
    "weeks" as (
      select ("today"."d" - (extract(isodow from "today"."d")::int - 1) - 7 * g)::date as "week_start"
      from "today", generate_series(0, ${WEEKS - 1}) g
    ),
    "dated" as (
      select coalesce(a."applied_at", (a."created_at" at time zone "tz"."name")::date) as "d"
      from "application" a, "tz"
      where ${appScopeSql(userId, includeArchived)}
    ),
    "bucketed" as (select ("d" - (extract(isodow from "d")::int - 1))::date as "week_start" from "dated")
    select w."week_start"::text as "weekStart", count(b."week_start")::int as "count"
    from "weeks" w
    left join "bucketed" b on b."week_start" = w."week_start"
    group by w."week_start"
    order by w."week_start"
  `);
  return rowsOf<WeekCount>(result);
}

/** Count and response rate per source (trimmed; empty is "Unknown"), most applications first. */
export async function getSourceStats(db: Db, userId: string, options?: StatsOptions): Promise<SourceStats[]> {
  const { includeArchived } = resolve(options);
  const result = await db.execute(sql`
    select
      f."source",
      count(*)::int as "count",
      count(*) filter (where f."responded")::int as "responded",
      (count(*) filter (where f."responded"))::float8 / count(*) as "rate"
    from (${applicationFlagsSql(userId, includeArchived)}) f
    group by f."source"
    order by count(*) desc, f."source" collate "C"
  `);
  return rowsOf<SourceStats>(result);
}

async function getTimeZone(db: Db, userId: string): Promise<string> {
  const result = await db.execute(sql`select ${userTimeZoneSql(userId)} as "timeZone"`);
  return rowsOf<{ timeZone: string }>(result)[0].timeZone;
}

/** Every metric for the statistics page. */
export async function getStats(db: Db, userId: string, options?: StatsOptions): Promise<Stats> {
  const resolved = resolve(options);
  const [timeZone, stageTotals, funnel, averageTimeInStage, weekly, sources] = await Promise.all([
    getTimeZone(db, userId),
    getStageTotals(db, userId),
    getFunnel(db, userId, resolved),
    getAverageTimeInStage(db, userId, resolved),
    getWeeklyApplications(db, userId, resolved),
    getSourceStats(db, userId, resolved),
  ]);
  return {
    includeArchived: resolved.includeArchived,
    timeZone,
    totalApplications: funnel.total,
    stageTotals,
    responseRate: { total: funnel.total, responded: funnel.responded, rate: funnel.total === 0 ? null : funnel.responded / funnel.total },
    funnel,
    averageTimeInStage,
    weekly,
    sources,
  };
}

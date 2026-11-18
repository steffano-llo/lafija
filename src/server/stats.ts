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
/** `total` = applied applications (ever reached a non-wishlist stage); every step is within them. */
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
  /** Every application in scope, applied or not. */
  totalApplications: number;
  /** Applications in scope that only ever sat in wishlist stages; left out of every rate. */
  notAppliedYet: number;
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
 * One row per application in scope with what it ever reached, from its transitions (S21):
 * - `applied_*`: its first transition (by time, then id) into a stage whose category is not
 *   `wishlist`; `applied` is false when it only ever sat in wishlist stages.
 * - `responded`: it ever reached a stage positioned after its applied stage whose category is
 *   neither `withdrawn` nor `wishlist`. Positions are read now, so reordering stages reinterprets
 *   history. Every transition before the applied one is into a wishlist stage, so "after reaching
 *   the applied stage" needs no time condition.
 * - `offer` / `accepted`: it ever reached a stage of that category (such stages are never wishlist,
 *   so these imply `applied`).
 */
function applicationFlagsSql(userId: string, includeArchived: boolean): SQL {
  return sql`
    select
      a."id",
      a."applied_at",
      coalesce(nullif(btrim(a."source"), ''), ${UNKNOWN_SOURCE}) as "source",
      ap."position" is not null as "applied",
      ap."at" as "applied_transition_at",
      coalesce(bool_or(s."category" not in ('withdrawn', 'wishlist') and s."position" > ap."position"), false) as "responded",
      coalesce(bool_or(s."category" = 'offer'), false) as "offer",
      coalesce(bool_or(s."category" = 'accepted'), false) as "accepted"
    from "application" a
    left join lateral (
      select fs."position", ft."at"
      from "stage_transition" ft
      join "stage" fs on fs."id" = ft."to_stage_id" and fs."user_id" = ${userId}
      where ft."application_id" = a."id" and ft."user_id" = ${userId} and fs."category" <> 'wishlist'
      order by ft."at", ft."id"
      limit 1
    ) ap on true
    left join "stage_transition" t on t."application_id" = a."id" and t."user_id" = ${userId}
    left join "stage" s on s."id" = t."to_stage_id" and s."user_id" = ${userId}
    where ${appScopeSql(userId, includeArchived)}
    group by a."id", a."applied_at", a."source", ap."position", ap."at"
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

/** Applied applications that got a response, over applied applications in scope (S21). */
export async function getResponseRate(db: Db, userId: string, options?: StatsOptions): Promise<ResponseRate> {
  const { total, responded } = await getFunnel(db, userId, options);
  return { total, responded, rate: total === 0 ? null : responded / total };
}

type Counts = Funnel & { notApplied: number };

async function getCounts(db: Db, userId: string, options?: StatsOptions): Promise<Counts> {
  const { includeArchived } = resolve(options);
  const result = await db.execute(sql`
    select
      count(*) filter (where f."applied")::int as "total",
      count(*) filter (where f."applied" and f."responded")::int as "responded",
      count(*) filter (where f."applied" and f."offer")::int as "offer",
      count(*) filter (where f."applied" and f."accepted")::int as "accepted",
      count(*) filter (where not f."applied")::int as "notApplied"
    from (${applicationFlagsSql(userId, includeArchived)}) f
  `);
  return rowsOf<Counts>(result)[0];
}

/** Applied → responded → ever in an offer stage → ever in an accepted stage, all within applied applications. */
export async function getFunnel(db: Db, userId: string, options?: StatsOptions): Promise<Funnel> {
  const { total, responded, offer, accepted } = await getCounts(db, userId, options);
  return { total, responded, offer, accepted };
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
 * Applied applications per week for the last 12 weeks (the current one included), oldest first,
 * zero-filled. The date is the applied date, else the local date of the first transition into a
 * non-wishlist stage, in the user's time zone (UTC when unknown); weeks start on Monday and "now" is
 * read in the same zone. Wishlist-only applications are not counted.
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
      select coalesce(f."applied_at", (f."applied_transition_at" at time zone "tz"."name")::date) as "d"
      from (${applicationFlagsSql(userId, includeArchived)}) f, "tz"
      where f."applied"
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

/** Applied applications and their response rate per source (trimmed; empty is "Unknown"), most applications first. */
export async function getSourceStats(db: Db, userId: string, options?: StatsOptions): Promise<SourceStats[]> {
  const { includeArchived } = resolve(options);
  const result = await db.execute(sql`
    select
      f."source",
      count(*)::int as "count",
      count(*) filter (where f."responded")::int as "responded",
      (count(*) filter (where f."responded"))::float8 / count(*) as "rate"
    from (${applicationFlagsSql(userId, includeArchived)}) f
    where f."applied"
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
  const [timeZone, stageTotals, counts, averageTimeInStage, weekly, sources] = await Promise.all([
    getTimeZone(db, userId),
    getStageTotals(db, userId),
    getCounts(db, userId, resolved),
    getAverageTimeInStage(db, userId, resolved),
    getWeeklyApplications(db, userId, resolved),
    getSourceStats(db, userId, resolved),
  ]);
  const funnel: Funnel = { total: counts.total, responded: counts.responded, offer: counts.offer, accepted: counts.accepted };
  return {
    includeArchived: resolved.includeArchived,
    timeZone,
    totalApplications: funnel.total + counts.notApplied,
    notAppliedYet: counts.notApplied,
    stageTotals,
    responseRate: { total: funnel.total, responded: funnel.responded, rate: funnel.total === 0 ? null : funnel.responded / funnel.total },
    funnel,
    averageTimeInStage,
    weekly,
    sources,
  };
}

import { z } from "zod";

/** `?archived=exclude` leaves archived applications out of the history metrics; anything else includes them. */
const statsSearchParamsSchema = z.object({
  archived: z.enum(["include", "exclude"]).optional().catch(undefined),
});

export type StatsSearchOptions = { includeArchived: boolean };

export function parseStatsSearchParams(input: unknown): StatsSearchOptions {
  const parsed = statsSearchParamsSchema.safeParse(input ?? {});
  return { includeArchived: !(parsed.success && parsed.data.archived === "exclude") };
}

export const STATS_PATH = "/dashboard/stats";

/** Link to the statistics page with archived applications included or excluded. */
export function statsHref(includeArchived: boolean): string {
  return includeArchived ? STATS_PATH : `${STATS_PATH}?archived=exclude`;
}

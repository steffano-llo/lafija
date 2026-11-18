import { describe, expect, it } from "vitest";
import { parseStatsSearchParams, statsHref } from "./stats";

describe("stats search params", () => {
  it("includes archived applications unless ?archived=exclude", () => {
    expect(parseStatsSearchParams({})).toEqual({ includeArchived: true });
    expect(parseStatsSearchParams({ archived: "include" })).toEqual({ includeArchived: true });
    expect(parseStatsSearchParams({ archived: "exclude" })).toEqual({ includeArchived: false });
  });

  it("ignores unknown or repeated values instead of failing", () => {
    expect(parseStatsSearchParams({ archived: "EXCLUDE" })).toEqual({ includeArchived: true });
    expect(parseStatsSearchParams({ archived: ["exclude", "include"] })).toEqual({ includeArchived: true });
    expect(parseStatsSearchParams(undefined)).toEqual({ includeArchived: true });
  });

  it("builds the toggle links", () => {
    expect(statsHref(true)).toBe("/dashboard/stats");
    expect(statsHref(false)).toBe("/dashboard/stats?archived=exclude");
  });
});

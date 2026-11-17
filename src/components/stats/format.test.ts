import { describe, expect, it } from "vitest";
import { formatDays, formatPercent, formatWeek, rateLabel } from "./format";

describe("stats formatting", () => {
  it("shows rates as whole percentages and no rate as a dash", () => {
    expect(formatPercent(5 / 6)).toBe("83%");
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(null)).toBe("—");
    expect(rateLabel({ responded: 5, total: 6, rate: 5 / 6 })).toBe("83% (5 of 6)");
    expect(rateLabel({ responded: 0, total: 0, rate: null })).toBe("— (0 of 0)");
  });

  it("shows days with one decimal", () => {
    expect(formatDays(2.9)).toBe("2.9 days");
    expect(formatDays(2)).toBe("2.0 days");
    expect(formatDays(1)).toBe("1.0 day");
  });

  it("labels a week by its Monday, independent of the reader's zone", () => {
    expect(formatWeek("2026-03-16", 2026)).toBe("Mar 16");
    expect(formatWeek("2025-12-29", 2026)).toBe("Dec 29, 2025");
    expect(formatWeek("2026-01-05", 2026)).toBe("Jan 5");
  });
});

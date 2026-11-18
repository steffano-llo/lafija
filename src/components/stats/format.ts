/** "83%" for 5/6; "—" when there is nothing to divide. */
export function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** "83% (5 of 6)". */
export function rateLabel({ responded, total, rate }: { responded: number; total: number; rate: number | null }): string {
  return `${formatPercent(rate)} (${responded} of ${total})`;
}

/** Days with one decimal: "2.9 days". */
export function formatDays(days: number): string {
  const text = days.toFixed(1);
  return text === "1.0" ? `${text} day` : `${text} days`;
}

/**
 * A week by its Monday ("Mar 16"), with the year when it differs from `currentYear` (the year of
 * the latest week shown). Formatted in UTC: the date is already a calendar date in the user's zone.
 */
export function formatWeek(weekStart: string, currentYear: number): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(date.getUTCFullYear() !== currentYear ? { year: "numeric" } : {}),
  }).format(date);
}

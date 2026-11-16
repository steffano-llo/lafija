const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** Calendar dates are stored without a time zone, so they are formatted as UTC midnight. */
export function formatAppliedDate(value: string | null): string {
  return value ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : "—";
}

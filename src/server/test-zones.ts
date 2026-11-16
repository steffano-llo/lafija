// Test oracle for time-zone rules, computed with Intl (independent of the SQL under test).

/** `YYYY-MM-DD` of the instant in the zone. */
export function localDateIn(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Milliseconds the zone's wall clock is ahead of UTC at the instant. */
function offsetMs(zone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of 09:00 on `date` in the zone. */
export function nineAmIn(date: string, zone: string): Date {
  const wall = Date.parse(`${date}T09:00:00Z`);
  let t = wall - offsetMs(zone, new Date(wall));
  t = wall - offsetMs(zone, new Date(t));
  return new Date(t);
}

/** Due time of a follow-up: 09:00 in the zone on the transition's local date plus `days`. */
export function followUpDue(at: Date, days: number, zone: string): Date {
  return nineAmIn(addDays(localDateIn(at, zone), days), zone);
}

/** "23 h 5 min left", "45 min left", or "less than a minute left"; never negative. */
export function formatTimeLeft(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "less than a minute left";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} min left` : `${hours} h ${rest} min left`;
}

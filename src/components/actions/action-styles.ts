/**
 * One look for every action that is not the main one of its place (S11): outlined and small.
 * Links styled as buttons use the same props through `buttonVariants`.
 */
export const SECONDARY_ACTION = { variant: "outline", size: "sm" } as const;

/** Every destructive action (delete, unlink): outlined, small and red, always confirmed first. */
export const DESTRUCTIVE_ACTION = { variant: "destructive-outline", size: "sm" } as const;

/** "1 day", "3 days", "7 days". */
export function snoozeLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** How buttons name a reminder for screen readers: reminder “<message>”. */
export function reminderName(message: string): string {
  return `reminder “${message}”`;
}

/** Accessible name of the ⋯ menu of a reminder. */
export function reminderMenuLabel(message: string): string {
  return `More actions for ${reminderName(message)}`;
}

/** The server refuses to snooze a done reminder, so only open ones offer Snooze. */
export function canSnooze(reminder: { doneAt: string | null }): boolean {
  return reminder.doneAt === null;
}

import { z } from "zod";

export const REMINDER_KINDS = ["manual", "follow_up"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const REMINDER_KIND_LABELS: Record<ReminderKind, string> = {
  manual: "Reminder",
  follow_up: "Follow-up",
};

export const REMINDER_MESSAGE_MAX = 500;

/** Snooze choices, in days from now. */
export const SNOOZE_DAYS = [1, 3, 7] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

/** Automatic follow-up delay: days after a move into an active stage. Null means off. */
export const FOLLOW_UP_DAYS_DEFAULT = 7;
export const FOLLOW_UP_DAYS_MIN = 1;
export const FOLLOW_UP_DAYS_MAX = 60;

/** Message of an automatic follow-up reminder. */
export function followUpMessage(companyName: string, role: string): string {
  return `Follow up with ${companyName} about ${role}`;
}

/** Earliest and latest accepted instants: safe for timestamptz and far enough for any reminder. */
const MIN_DUE_AT = Date.UTC(1970, 0, 1);
const MAX_DUE_AT = Date.UTC(2100, 0, 1);

const dueAt = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string({ error: (issue) => (issue.input === undefined ? "Due date and time is required." : "Enter a valid date and time.") })
    .trim()
    // An instant with its offset: the browser converts the local time it shows into one.
    .pipe(z.iso.datetime({ offset: true, error: "Enter a valid date and time." }))
    .transform((value) => new Date(value))
    .refine((date) => !Number.isNaN(date.getTime()), "Enter a valid date and time.")
    .refine((date) => date.getTime() >= MIN_DUE_AT && date.getTime() < MAX_DUE_AT, "Enter a date between 1970 and 2099."),
);

const message = z
  .string({ error: "Message is required." })
  .trim()
  .min(1, "Message is required.")
  .max(REMINDER_MESSAGE_MAX, `Message must be at most ${REMINDER_MESSAGE_MAX} characters.`);

export const reminderInputSchema = z.object({ dueAt, message });

export type ReminderInput = z.output<typeof reminderInputSchema>;
export type ReminderField = keyof ReminderInput;
export type ReminderFieldErrors = Partial<Record<ReminderField, string[]>>;

export function parseReminderInput(
  input: unknown,
): { success: true; data: ReminderInput } | { success: false; fieldErrors: ReminderFieldErrors } {
  const result = reminderInputSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: z.flattenError(result.error).fieldErrors };
}

/** 1, 3 or 7 (as a number or its decimal string); null for anything else. */
export function parseSnoozeDays(value: unknown): SnoozeDays | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return SNOOZE_DAYS.find((days) => days === n) ?? null;
}

const followUpDays = z.preprocess(
  (value) => {
    if (value === "off" || value === null) return null;
    if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
    return value;
  },
  z
    .number({ error: `Choose off or a number of days from ${FOLLOW_UP_DAYS_MIN} to ${FOLLOW_UP_DAYS_MAX}.` })
    .int(`Choose off or a number of days from ${FOLLOW_UP_DAYS_MIN} to ${FOLLOW_UP_DAYS_MAX}.`)
    .min(FOLLOW_UP_DAYS_MIN, `Choose off or a number of days from ${FOLLOW_UP_DAYS_MIN} to ${FOLLOW_UP_DAYS_MAX}.`)
    .max(FOLLOW_UP_DAYS_MAX, `Choose off or a number of days from ${FOLLOW_UP_DAYS_MIN} to ${FOLLOW_UP_DAYS_MAX}.`)
    .nullable(),
);

export const followUpSettingsSchema = z.object({ followUpDays });

export type FollowUpSettingsInput = z.output<typeof followUpSettingsSchema>;
export type FollowUpSettingsFieldErrors = Partial<Record<keyof FollowUpSettingsInput, string[]>>;

/** `{ followUpDays: "off" | null | 1..60 }`, the number possibly as a decimal string. */
export function parseFollowUpSettings(
  input: unknown,
): { success: true; data: FollowUpSettingsInput } | { success: false; fieldErrors: FollowUpSettingsFieldErrors } {
  const result = followUpSettingsSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: z.flattenError(result.error).fieldErrors };
}

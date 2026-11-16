import type { ReminderField, ReminderKind } from "@/lib/validation/reminder";

/** Fields the reminder forms post; `dueAt` is the ISO instant the browser computes. */
export const REMINDER_FIELDS = ["dueAt", "message"] as const satisfies readonly ReminderField[];

export type ReminderFormField = (typeof REMINDER_FIELDS)[number];

/** A reminder as pages pass it to the browser (dates as ISO strings). */
export type ReminderItem = {
  id: string;
  applicationId: string;
  kind: ReminderKind;
  dueAt: string;
  message: string;
  doneAt: string | null;
  companyName: string;
  role: string;
};

export function toReminderItem(reminder: {
  id: string;
  applicationId: string;
  kind: ReminderKind;
  dueAt: Date;
  message: string;
  doneAt: Date | null;
  companyName: string;
  role: string;
}): ReminderItem {
  return {
    id: reminder.id,
    applicationId: reminder.applicationId,
    kind: reminder.kind,
    dueAt: reminder.dueAt.toISOString(),
    message: reminder.message,
    doneAt: reminder.doneAt ? reminder.doneAt.toISOString() : null,
    companyName: reminder.companyName,
    role: reminder.role,
  };
}

/** State of the follow-up settings form. */
export type FollowUpSettingsState = {
  value: string;
  error?: string;
  saved?: boolean;
};

export const REMINDER_MESSAGES = {
  invalid: "Please fix the highlighted fields.",
  reminder_not_found: "This reminder no longer exists.",
  application_not_found: "This application no longer exists.",
  invalid_snooze: "Choose 1, 3 or 7 days.",
  done: "Reopen this reminder before snoozing it.",
  closed: "This follow-up belongs to an earlier stage and cannot be reopened.",
} as const;

"use server";

import { revalidatePath } from "next/cache";
import { readFields, type DetailButtonState, type DetailFormState } from "@/components/applications/form-state";
import {
  REMINDER_FIELDS,
  REMINDER_MESSAGES,
  type FollowUpSettingsState,
  type ReminderFormField,
} from "@/components/reminders/form-state";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { isId } from "@/server/ids";
import {
  createReminder,
  deleteReminder,
  setFollowUpDays,
  setReminderDone,
  snoozeReminder,
  updateReminder,
  type ReminderChangeResult,
} from "@/server/reminders";

// Every action: `requireUser()` first, bound args re-checked at runtime (the client can post any
// value), then a data function that filters by the user. Unknown and foreign ids change nothing.
// Reminders show on the application pages, the reminders page and the due indicator of every
// dashboard page, so every change revalidates the whole dashboard.

function revalidateDashboard() {
  revalidatePath("/dashboard", "layout");
}

export async function createReminderAction(
  applicationId: unknown,
  _state: DetailFormState<ReminderFormField>,
  formData: FormData,
): Promise<DetailFormState<ReminderFormField>> {
  const user = await requireUser();
  const values = readFields(formData, REMINDER_FIELDS);
  if (!isId(applicationId)) return { values, message: REMINDER_MESSAGES.application_not_found };
  const result = await createReminder(getDb(), user.id, applicationId, values);
  if (!result.ok) {
    return result.reason === "invalid"
      ? { values, fieldErrors: result.fieldErrors, message: REMINDER_MESSAGES.invalid }
      : { values, message: REMINDER_MESSAGES.application_not_found };
  }
  revalidateDashboard();
  return { values: {}, saved: true };
}

export async function updateReminderAction(
  reminderId: unknown,
  _state: DetailFormState<ReminderFormField>,
  formData: FormData,
): Promise<DetailFormState<ReminderFormField>> {
  const user = await requireUser();
  const values = readFields(formData, REMINDER_FIELDS);
  if (!isId(reminderId)) return { values, message: REMINDER_MESSAGES.reminder_not_found };
  const result = await updateReminder(getDb(), user.id, reminderId, values);
  if (!result.ok) {
    return result.reason === "invalid"
      ? { values, fieldErrors: result.fieldErrors, message: REMINDER_MESSAGES.invalid }
      : { values, message: REMINDER_MESSAGES.reminder_not_found };
  }
  revalidateDashboard();
  return { values, saved: true };
}

function changeFailure(result: Exclude<ReminderChangeResult, { ok: true }>): DetailButtonState {
  switch (result.reason) {
    case "invalid":
      return { message: REMINDER_MESSAGES.invalid_snooze };
    case "done":
      return { message: REMINDER_MESSAGES.done };
    case "closed":
      return { message: REMINDER_MESSAGES.closed };
    default:
      return { message: REMINDER_MESSAGES.reminder_not_found };
  }
}

export async function setReminderDoneAction(reminderId: unknown, done: unknown): Promise<DetailButtonState> {
  const user = await requireUser();
  if (!isId(reminderId) || typeof done !== "boolean") return { message: REMINDER_MESSAGES.reminder_not_found };
  const result = await setReminderDone(getDb(), user.id, reminderId, done);
  if (!result.ok) return changeFailure(result);
  revalidateDashboard();
  return {};
}

export async function snoozeReminderAction(reminderId: unknown, days: unknown): Promise<DetailButtonState> {
  const user = await requireUser();
  if (!isId(reminderId)) return { message: REMINDER_MESSAGES.reminder_not_found };
  const result = await snoozeReminder(getDb(), user.id, reminderId, days);
  if (!result.ok) return changeFailure(result);
  revalidateDashboard();
  return {};
}

export async function deleteReminderAction(reminderId: unknown): Promise<DetailButtonState> {
  const user = await requireUser();
  if (!isId(reminderId)) return { message: REMINDER_MESSAGES.reminder_not_found };
  const result = await deleteReminder(getDb(), user.id, reminderId);
  if (!result.ok) return { message: REMINDER_MESSAGES.reminder_not_found };
  revalidateDashboard();
  return {};
}

export async function setFollowUpDaysAction(
  _state: FollowUpSettingsState,
  formData: FormData,
): Promise<FollowUpSettingsState> {
  const user = await requireUser();
  const raw = formData.get("followUpDays");
  const value = typeof raw === "string" ? raw : "";
  const result = await setFollowUpDays(getDb(), user.id, { followUpDays: value });
  if (!result.ok) return { value, error: result.fieldErrors.followUpDays?.[0] ?? REMINDER_MESSAGES.invalid };
  revalidateDashboard();
  return { value: result.followUpDays === null ? "off" : String(result.followUpDays), saved: true };
}

"use server";

import { revalidatePath } from "next/cache";
import type { SettingsFormState } from "@/components/settings/form-state";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { CURRENCY_INVALID_MESSAGE, TIME_ZONE_INVALID_MESSAGE } from "@/lib/validation/settings";
import { saveDetectedTimeZone, setDefaultCurrency, setTimeZone } from "@/server/settings";

// Every action: `requireUser()` first, then a data function that validates its input and filters by
// the user. A time zone change moves follow-up due times shown on every dashboard page.

function revalidateDashboard() {
  revalidatePath("/dashboard", "layout");
}

/**
 * Called by the browser with the zone it reports. Saves it only while the user has none, so a
 * zone the user chose is never overwritten. `saved` tells the page to refresh.
 */
export async function detectTimeZoneAction(timeZone: unknown): Promise<{ saved: boolean }> {
  const user = await requireUser();
  const result = await saveDetectedTimeZone(getDb(), user.id, timeZone);
  if (!result.ok || !result.saved) return { saved: false };
  revalidateDashboard();
  return { saved: true };
}

function readValue(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

export async function setTimeZoneAction(_state: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const user = await requireUser();
  const value = readValue(formData, "timeZone");
  const result = await setTimeZone(getDb(), user.id, { timeZone: value });
  if (!result.ok) return { value, error: result.fieldErrors.timeZone?.[0] ?? TIME_ZONE_INVALID_MESSAGE };
  revalidateDashboard();
  return { value: result.timeZone, saved: true };
}

export async function setDefaultCurrencyAction(
  _state: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await requireUser();
  const value = readValue(formData, "defaultCurrency");
  const result = await setDefaultCurrency(getDb(), user.id, { defaultCurrency: value });
  if (!result.ok) return { value, error: result.fieldErrors.defaultCurrency?.[0] ?? CURRENCY_INVALID_MESSAGE };
  revalidateDashboard();
  return { value: result.defaultCurrency, saved: true };
}

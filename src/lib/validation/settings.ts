import { z } from "zod";

/** Currencies the forms offer, in this order. Any ISO 4217 code is accepted by the server. */
export const CURRENCIES = ["USD", "EUR", "ARS", "BRL", "CLP", "COP", "MXN", "PEN", "UYU", "GBP", "CAD"] as const;

/** Default currency of a new user (L24). */
export const DEFAULT_CURRENCY = "USD";

export const CURRENCY_INVALID_MESSAGE = "Choose a valid currency.";
export const TIME_ZONE_INVALID_MESSAGE = "Choose a valid time zone.";

/** Follow-ups and applied dates use UTC until the user's zone is known. */
export const FALLBACK_TIME_ZONE = "UTC";

let isoCodes: Set<string> | null = null;

/** Three uppercase letters that name an ISO 4217 currency. */
export function isCurrencyCode(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) return false;
  isoCodes ??= new Set(Intl.supportedValuesOf("currency"));
  return isoCodes.has(value);
}

export const currencySchema = z.custom<string>(isCurrencyCode, { error: CURRENCY_INVALID_MESSAGE });

/**
 * Shape of an IANA zone name ("UTC", "America/Argentina/Buenos_Aires"). Whether the zone exists is
 * decided by the database (`pg_timezone_names`), the same list `at time zone` uses.
 */
export function isTimeZoneShape(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value);
}

export const timeZoneSettingsSchema = z.object({
  timeZone: z.custom<string>(isTimeZoneShape, { error: TIME_ZONE_INVALID_MESSAGE }),
});
export type TimeZoneFieldErrors = { timeZone?: string[] };

export const currencySettingsSchema = z.object({ defaultCurrency: currencySchema });
export type CurrencyFieldErrors = { defaultCurrency?: string[] };

export function parseTimeZoneSettings(
  input: unknown,
): { success: true; data: { timeZone: string } } | { success: false; fieldErrors: TimeZoneFieldErrors } {
  const result = timeZoneSettingsSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: { timeZone: [TIME_ZONE_INVALID_MESSAGE] } };
}

export function parseCurrencySettings(
  input: unknown,
): { success: true; data: { defaultCurrency: string } } | { success: false; fieldErrors: CurrencyFieldErrors } {
  const result = currencySettingsSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: { defaultCurrency: [CURRENCY_INVALID_MESSAGE] } };
}

export const EMAIL_REMINDERS_INVALID_MESSAGE = "Choose on or off.";

export const emailRemindersSettingsSchema = z.object({ emailReminders: z.boolean() });
export type EmailRemindersFieldErrors = { emailReminders?: string[] };

export function parseEmailRemindersSettings(
  input: unknown,
): { success: true; data: { emailReminders: boolean } } | { success: false; fieldErrors: EmailRemindersFieldErrors } {
  const result = emailRemindersSettingsSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: { emailReminders: [EMAIL_REMINDERS_INVALID_MESSAGE] } };
}

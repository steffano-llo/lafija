import { z } from "zod";

export const APPLICATION_LIMITS = {
  companyName: 120,
  role: 120,
  url: 2048,
  source: 80,
  salaryRange: 80,
} as const;

/** Furthest time zone ahead of UTC: a date that is "today" anywhere on Earth is never rejected. */
const MAX_UTC_OFFSET_MS = 14 * 60 * 60 * 1000;

/** Latest calendar date (YYYY-MM-DD) that is not in the future for some time zone. */
export function latestAllowedDate(now: Date = new Date()): string {
  return new Date(now.getTime() + MAX_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function requiredText(label: string, max: number) {
  return z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters.`);
}

/** Optional text: trimmed, and blank or missing becomes null. */
function optionalText(schema: z.ZodType<string>) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    },
    schema.nullable(),
  );
}

export const applicationInputSchema = z.object({
  companyName: requiredText("Company", APPLICATION_LIMITS.companyName),
  role: requiredText("Role", APPLICATION_LIMITS.role),
  url: optionalText(
    z
      .string({ error: "Enter a valid http(s) URL." })
      .max(APPLICATION_LIMITS.url, `URL must be at most ${APPLICATION_LIMITS.url} characters.`)
      .refine(isHttpUrl, { message: "Enter a valid http(s) URL.", abort: true }),
  ),
  source: optionalText(
    z
      .string({ error: "Enter a valid source." })
      .max(APPLICATION_LIMITS.source, `Source must be at most ${APPLICATION_LIMITS.source} characters.`),
  ),
  salaryRange: optionalText(
    z
      .string({ error: "Enter a valid salary range." })
      .max(
        APPLICATION_LIMITS.salaryRange,
        `Salary range must be at most ${APPLICATION_LIMITS.salaryRange} characters.`,
      ),
  ),
  appliedAt: optionalText(
    z
      .string({ error: "Enter a valid date." })
      .refine(isCalendarDate, { message: "Enter a valid date.", abort: true })
      .refine((value) => value <= latestAllowedDate(), "Applied date cannot be in the future."),
  ),
});

export type ApplicationInput = z.output<typeof applicationInputSchema>;
export type ApplicationField = keyof ApplicationInput;
export type FieldErrors = Partial<Record<ApplicationField, string[]>>;

export function parseApplicationInput(
  input: unknown,
): { success: true; data: ApplicationInput } | { success: false; fieldErrors: FieldErrors } {
  const result = applicationInputSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: z.flattenError(result.error).fieldErrors };
}

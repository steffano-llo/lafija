import { z } from "zod";
import { optionalText } from "./application";

export const INTERVIEW_TYPES = ["phone", "video", "onsite", "technical", "other"] as const;
export const INTERVIEW_OUTCOMES = ["pending", "passed", "failed", "cancelled"] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number];
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = {
  phone: "Phone",
  video: "Video",
  onsite: "On-site",
  technical: "Technical",
  other: "Other",
};

export const INTERVIEW_OUTCOME_LABELS: Record<InterviewOutcome, string> = {
  pending: "Pending",
  passed: "Passed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const INTERVIEW_NOTES_MAX = 5_000;

/** Earliest and latest accepted instants: far enough for any real interview, safe for timestamptz. */
const MIN_SCHEDULED_AT = Date.UTC(1970, 0, 1);
const MAX_SCHEDULED_AT = Date.UTC(2100, 0, 1);

const scheduledAt = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string({ error: (issue) => (issue.input === undefined ? "Date and time is required." : "Enter a valid date and time.") })
    .trim()
    // An instant with its offset: the browser converts the local time it shows into one.
    .pipe(z.iso.datetime({ offset: true, error: "Enter a valid date and time." }))
    .transform((value) => new Date(value))
    .refine((date) => !Number.isNaN(date.getTime()), "Enter a valid date and time.")
    .refine(
      (date) => date.getTime() >= MIN_SCHEDULED_AT && date.getTime() < MAX_SCHEDULED_AT,
      "Enter a date between 1970 and 2099.",
    ),
);

const type = z.enum(INTERVIEW_TYPES, { error: "Choose a valid interview type." });
const outcome = z.enum(INTERVIEW_OUTCOMES, { error: "Choose a valid outcome." });

export const interviewInputSchema = z.object({
  scheduledAt,
  type,
  // Missing means "pending"; anything else must be one of the outcomes.
  outcome: z.preprocess((value) => (value === undefined || value === "" ? "pending" : value), outcome),
  notes: optionalText(
    z
      .string({ error: "Enter valid notes." })
      .max(INTERVIEW_NOTES_MAX, `Notes must be at most ${INTERVIEW_NOTES_MAX} characters.`),
  ),
});

export type InterviewInput = z.output<typeof interviewInputSchema>;
export type InterviewField = keyof InterviewInput;
export type InterviewFieldErrors = Partial<Record<InterviewField, string[]>>;

export function parseInterviewInput(
  input: unknown,
): { success: true; data: InterviewInput } | { success: false; fieldErrors: InterviewFieldErrors } {
  const result = interviewInputSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: z.flattenError(result.error).fieldErrors };
}

export function parseInterviewOutcome(value: unknown): InterviewOutcome | null {
  const result = outcome.safeParse(value);
  return result.success ? result.data : null;
}

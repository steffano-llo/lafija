import type { InterviewField, InterviewOutcome, InterviewType } from "@/lib/validation/interview";

/** Fields the interview forms post; `scheduledAt` is the ISO instant the browser computes. */
export const INTERVIEW_FIELDS = ["scheduledAt", "type", "outcome", "notes"] as const satisfies readonly InterviewField[];

export type InterviewFormField = (typeof INTERVIEW_FIELDS)[number];

/** An interview as the detail page passes it to the browser (dates as ISO strings). */
export type InterviewItem = {
  id: string;
  scheduledAt: string;
  type: InterviewType;
  outcome: InterviewOutcome;
  notes: string | null;
  /** Past and still pending: the page asks for the outcome. */
  needsOutcome: boolean;
};

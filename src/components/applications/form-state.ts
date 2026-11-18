import type { ApplicationField, FieldErrors } from "@/lib/validation/application";
import { INTERVIEW_PENDING_PAST_MESSAGE } from "@/lib/validation/interview";

/** Raw form values, echoed back so a rejected submission keeps what the user typed. */
export type ApplicationFormValues = Partial<Record<ApplicationField, string>>;

export type ApplicationFormState = {
  values: ApplicationFormValues;
  fieldErrors?: FieldErrors;
  message?: string;
};

export type ApplicationFormAction = (state: ApplicationFormState, formData: FormData) => Promise<ApplicationFormState>;

/** Result of the archive / unarchive button: only an error message, if any. */
export type ArchiveState = { message?: string };

export const ARCHIVE_REFUSAL_MESSAGES = {
  not_found: "This application no longer exists.",
  stage_archived:
    "Its stage is archived. Unarchive the stage, or edit the application into another stage, then unarchive it.",
} as const;

const fields: ApplicationField[] = [
  "companyName",
  "role",
  "stageId",
  "url",
  "source",
  "salaryRange",
  "salaryCurrency",
  "appliedAt",
];

/** Reads only the known fields, ignoring React's `$ACTION_` entries and anything else posted. */
export function readApplicationForm(formData: FormData): ApplicationFormValues {
  const values: ApplicationFormValues = {};
  for (const field of fields) {
    const value = formData.get(field);
    if (typeof value === "string") values[field] = value;
  }
  return values;
}

/** State of a form on the application detail page (notes, interview, contact). */
export type DetailFormState<F extends string> = {
  values: Partial<Record<F, string>>;
  fieldErrors?: Partial<Record<F, string[]>>;
  message?: string;
  /** Set when the last submission was saved: forms close or clear on it. */
  saved?: boolean;
};

export type DetailFormAction<F extends string> = (
  state: DetailFormState<F>,
  formData: FormData,
) => Promise<DetailFormState<F>>;

/** Result of a one-button form (delete, unlink, link, outcome): only an error message, if any. */
export type DetailButtonState = { message?: string };

export type DetailButtonAction = (state: DetailButtonState, formData: FormData) => Promise<DetailButtonState>;

export const DETAIL_MESSAGES = {
  invalid: "Please fix the highlighted fields.",
  application_not_found: "This application no longer exists.",
  interview_not_found: "This interview no longer exists.",
  contact_not_found: "This contact no longer exists.",
  other_company: "This contact belongs to another company.",
  invalid_outcome: "Choose a valid outcome.",
  pending_past: INTERVIEW_PENDING_PAST_MESSAGE,
} as const;

/** Reads only the named fields, ignoring React's `$ACTION_` entries and anything else posted. */
export function readFields<F extends string>(formData: FormData, fields: readonly F[]): Partial<Record<F, string>> {
  const values: Partial<Record<F, string>> = {};
  for (const field of fields) {
    const value = formData.get(field);
    if (typeof value === "string") values[field] = value;
  }
  return values;
}

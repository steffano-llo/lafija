import type { StageField, StageFieldErrors } from "@/lib/validation/stage";

/** Raw form values, echoed back so a rejected submission keeps what the user typed. */
export type StageFormValues = Partial<Record<StageField, string>>;

export type StageFormState = {
  values: StageFormValues;
  fieldErrors?: StageFieldErrors;
  message?: string;
  saved?: boolean;
};

export type StageFormAction = (state: StageFormState, formData: FormData) => Promise<StageFormState>;

/** Result of a row button (move, archive, delete): only an error message, if any. */
export type StageRowState = { message?: string };

export type StageRowAction = (state: StageRowState, formData: FormData) => Promise<StageRowState>;

export const STAGE_ROW_INTENTS = ["up", "down", "archive", "unarchive", "delete"] as const;
export type StageRowIntent = (typeof STAGE_ROW_INTENTS)[number];

export function isStageRowIntent(value: unknown): value is StageRowIntent {
  return typeof value === "string" && (STAGE_ROW_INTENTS as readonly string[]).includes(value);
}

/** Reads only the known fields, ignoring React's `$ACTION_` entries and anything else posted. */
export function readStageForm(formData: FormData): StageFormValues {
  const values: StageFormValues = {};
  for (const field of ["name", "category"] as const) {
    const value = formData.get(field);
    if (typeof value === "string") values[field] = value;
  }
  return values;
}

/** What the user sees when a stage operation is refused. */
export const STAGE_REFUSAL_MESSAGES = {
  not_found: "This stage no longer exists.",
  in_use: "Applications use this stage or have been in it, so it cannot be deleted. Archive it instead.",
  has_applications: "Move the active applications in this stage to another stage before archiving it.",
  last_stage: "You need at least one active stage.",
} as const;

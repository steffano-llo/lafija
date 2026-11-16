import type { ApplicationField, FieldErrors } from "@/lib/validation/application";

/** Raw form values, echoed back so a rejected submission keeps what the user typed. */
export type ApplicationFormValues = Partial<Record<ApplicationField, string>>;

export type ApplicationFormState = {
  values: ApplicationFormValues;
  fieldErrors?: FieldErrors;
  message?: string;
};

export type ApplicationFormAction = (state: ApplicationFormState, formData: FormData) => Promise<ApplicationFormState>;

const fields: ApplicationField[] = ["companyName", "role", "stageId", "url", "source", "salaryRange", "appliedAt"];

/** Reads only the known fields, ignoring React's `$ACTION_` entries and anything else posted. */
export function readApplicationForm(formData: FormData): ApplicationFormValues {
  const values: ApplicationFormValues = {};
  for (const field of fields) {
    const value = formData.get(field);
    if (typeof value === "string") values[field] = value;
  }
  return values;
}

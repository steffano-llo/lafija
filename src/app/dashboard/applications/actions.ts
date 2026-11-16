"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readApplicationForm, type ApplicationFormState } from "@/components/applications/form-state";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import {
  createApplication,
  setApplicationArchived,
  updateApplication,
  type ApplicationResult,
} from "@/server/applications";

const LIST_PATH = "/dashboard/applications";

function failure(
  result: Exclude<ApplicationResult, { ok: true }>,
  values: ApplicationFormState["values"],
): ApplicationFormState {
  if (result.reason === "invalid") {
    return { values, fieldErrors: result.fieldErrors, message: "Please fix the highlighted fields." };
  }
  return { values, message: "This application no longer exists." };
}

export async function createApplicationAction(
  _state: ApplicationFormState,
  formData: FormData,
): Promise<ApplicationFormState> {
  const user = await requireUser();
  const values = readApplicationForm(formData);
  const result = await createApplication(getDb(), user.id, values);
  if (!result.ok) return failure(result, values);
  revalidatePath(LIST_PATH);
  redirect(LIST_PATH);
}

export async function updateApplicationAction(
  id: string,
  _state: ApplicationFormState,
  formData: FormData,
): Promise<ApplicationFormState> {
  const user = await requireUser();
  const values = readApplicationForm(formData);
  const result = await updateApplication(getDb(), user.id, id, values);
  if (!result.ok) return failure(result, values);
  revalidatePath(LIST_PATH);
  redirect(result.application.archived ? `${LIST_PATH}?view=archived` : LIST_PATH);
}

/** Bound per row in the list; a foreign or unknown id changes nothing. */
export async function setApplicationArchivedAction(id: string, archived: boolean): Promise<void> {
  const user = await requireUser();
  await setApplicationArchived(getDb(), user.id, id, archived);
  revalidatePath(LIST_PATH);
}

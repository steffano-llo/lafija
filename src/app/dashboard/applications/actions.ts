"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ARCHIVE_REFUSAL_MESSAGES,
  readApplicationForm,
  type ApplicationFormState,
  type ArchiveState,
} from "@/components/applications/form-state";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import {
  createApplication,
  setApplicationArchived,
  updateApplication,
  type ApplicationResult,
} from "@/server/applications";

const LIST_PATH = "/dashboard/applications";
const BOARD_PATH = "/dashboard/board";

function revalidate() {
  revalidatePath(LIST_PATH);
  revalidatePath(BOARD_PATH);
}

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
  revalidate();
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
  revalidate();
  redirect(result.application.archived ? `${LIST_PATH}?view=archived` : LIST_PATH);
}

/**
 * Bound per row in the list; a foreign or unknown id changes nothing. Bound args are re-checked at
 * runtime because the client can post any value.
 */
export async function setApplicationArchivedAction(id: unknown, archived: unknown): Promise<ArchiveState> {
  const user = await requireUser();
  if (typeof id !== "string" || typeof archived !== "boolean") return { message: ARCHIVE_REFUSAL_MESSAGES.not_found };
  const result = await setApplicationArchived(getDb(), user.id, id, archived);
  if (!result.ok) {
    return {
      message: result.reason === "stage_archived" ? ARCHIVE_REFUSAL_MESSAGES.stage_archived : ARCHIVE_REFUSAL_MESSAGES.not_found,
    };
  }
  revalidate();
  return {};
}

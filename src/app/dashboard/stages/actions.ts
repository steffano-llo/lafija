"use server";

import { revalidatePath } from "next/cache";
import {
  STAGE_REFUSAL_MESSAGES,
  isStageRowIntent,
  readStageForm,
  type StageFormState,
  type StageRowState,
} from "@/components/stages/form-state";
import { getDb } from "@/db";
import { requireUser } from "@/lib/session";
import { createStage, deleteStage, moveStage, setStageArchived, updateStage, type StageResult } from "@/server/stages";

const STAGES_PATH = "/dashboard/stages";

function revalidate() {
  revalidatePath(STAGES_PATH);
  // Application forms and the list show stage names.
  revalidatePath("/dashboard/applications", "layout");
  // The board has one column per active stage.
  revalidatePath("/dashboard/board");
}

function failure(result: Exclude<StageResult, { ok: true }>, values: StageFormState["values"]): StageFormState {
  if (result.reason === "invalid") {
    return { values, fieldErrors: result.fieldErrors, message: "Please fix the highlighted fields." };
  }
  return { values, message: STAGE_REFUSAL_MESSAGES.not_found };
}

export async function createStageAction(_state: StageFormState, formData: FormData): Promise<StageFormState> {
  const user = await requireUser();
  const values = readStageForm(formData);
  const result = await createStage(getDb(), user.id, values);
  if (!result.ok) return failure(result, values);
  revalidate();
  // Cleared for the next stage; the category keeps the user's last choice.
  return { values: { category: result.stage.category } };
}

export async function updateStageAction(id: unknown, _state: StageFormState, formData: FormData): Promise<StageFormState> {
  const user = await requireUser();
  const values = readStageForm(formData);
  if (typeof id !== "string") return { values, message: STAGE_REFUSAL_MESSAGES.not_found };
  const result = await updateStage(getDb(), user.id, id, values);
  if (!result.ok) return failure(result, values);
  revalidate();
  return { values: { name: result.stage.name, category: result.stage.category }, saved: true };
}

/** One action per row: the pressed button's `intent` says what to do. Bound args are re-checked at runtime. */
export async function stageRowAction(id: unknown, _state: StageRowState, formData: FormData): Promise<StageRowState> {
  const user = await requireUser();
  const intent = formData.get("intent");
  if (typeof id !== "string" || !isStageRowIntent(intent)) return { message: STAGE_REFUSAL_MESSAGES.not_found };
  const db = getDb();

  const result =
    intent === "up" || intent === "down"
      ? await moveStage(db, user.id, id, intent)
      : intent === "delete"
        ? await deleteStage(db, user.id, id)
        : await setStageArchived(db, user.id, id, intent === "archive");

  if (!result.ok) return { message: STAGE_REFUSAL_MESSAGES[result.reason] };
  revalidate();
  return {};
}

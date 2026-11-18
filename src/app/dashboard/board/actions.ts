"use server";

import { revalidatePath } from "next/cache";
import { MOVE_REFUSAL_MESSAGES, type MoveActionResult } from "@/components/board/messages";
import { getDb } from "@/db";
import { parseMoveInput } from "@/lib/validation/board";
import { requireUser } from "@/lib/session";
import { moveApplication } from "@/server/board";

/**
 * Moves one card on the board. Every argument comes from the client, so all of them are checked
 * at runtime; ownership and the target stage are checked by `moveApplication` in its statement.
 */
export async function moveApplicationAction(
  applicationId: unknown,
  stageId: unknown,
  index: unknown,
): Promise<MoveActionResult> {
  const user = await requireUser();
  const parsed = parseMoveInput({ applicationId, stageId, index });
  if (!parsed.success) return { ok: false, message: MOVE_REFUSAL_MESSAGES.invalid };

  const { applicationId: id, ...target } = parsed.data;
  const result = await moveApplication(getDb(), user.id, id, target);
  if (!result.ok) return { ok: false, message: MOVE_REFUSAL_MESSAGES[result.reason] };

  revalidatePath("/dashboard/board");
  revalidatePath("/dashboard/applications", "layout");
  return { ok: true };
}

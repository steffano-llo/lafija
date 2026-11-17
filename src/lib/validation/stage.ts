import { z } from "zod";

/**
 * Fixed meaning of a stage, used by statistics instead of its (editable) name. `wishlist` means
 * "not applied yet" (S21): reaching any other category makes an application applied.
 */
export const STAGE_CATEGORIES = ["wishlist", "active", "offer", "rejected", "accepted", "withdrawn"] as const;

export type StageCategory = (typeof STAGE_CATEGORIES)[number];

export const STAGE_CATEGORY_LABELS: Record<StageCategory, string> = {
  wishlist: "Wishlist",
  active: "Active",
  offer: "Offer",
  rejected: "Rejected",
  accepted: "Accepted",
  withdrawn: "Withdrawn",
};

/** Option text of the category selects on the stages page. */
export const STAGE_CATEGORY_OPTION_LABELS: Record<StageCategory, string> = {
  ...STAGE_CATEGORY_LABELS,
  wishlist: "Wishlist (not applied yet)",
};

export const STAGE_NAME_MAX = 60;

export const stageInputSchema = z.object({
  name: z
    .string({ error: "Name is required." })
    .trim()
    .min(1, "Name is required.")
    .max(STAGE_NAME_MAX, `Name must be at most ${STAGE_NAME_MAX} characters.`),
  category: z.enum(STAGE_CATEGORIES, { error: "Choose a category." }),
});

export type StageInput = z.output<typeof stageInputSchema>;
export type StageField = keyof StageInput;
export type StageFieldErrors = Partial<Record<StageField, string[]>>;

export function parseStageInput(
  input: unknown,
): { success: true; data: StageInput } | { success: false; fieldErrors: StageFieldErrors } {
  const result = stageInputSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return { success: false, fieldErrors: z.flattenError(result.error).fieldErrors };
}

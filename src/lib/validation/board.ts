import { z } from "zod";

/** Ids are random UUIDs; the bound keeps hostile input out of queries. */
const id = z.string().min(1).max(100);

/** A board move: which application, to which stage, and where in that column (0 = top). */
export const moveInputSchema = z.object({
  applicationId: id,
  stageId: id,
  index: z.number().int().min(0).max(1_000_000),
});

export type MoveInput = z.output<typeof moveInputSchema>;

export function parseMoveInput(input: unknown): { success: true; data: MoveInput } | { success: false } {
  const result = moveInputSchema.safeParse(input);
  return result.success ? { success: true, data: result.data } : { success: false };
}

import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { application, stage } from "@/db/schema";
import { parseStageInput, type StageCategory, type StageFieldErrors } from "@/lib/validation/stage";
import type { Db } from "./applications";

/** Stages every user starts with, in board order. The migration 0002 backfill repeats this list. */
export const DEFAULT_STAGES: readonly { name: string; category: StageCategory }[] = [
  { name: "Applied", category: "active" },
  { name: "Screening", category: "active" },
  { name: "Interview", category: "active" },
  { name: "Offer", category: "offer" },
  { name: "Rejected", category: "rejected" },
  { name: "Accepted", category: "accepted" },
];

export type Stage = {
  id: string;
  name: string;
  category: StageCategory;
  position: number;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type StageResult =
  | { ok: true; stage: Stage }
  | { ok: false; reason: "invalid"; fieldErrors: StageFieldErrors }
  | { ok: false; reason: "not_found" };

export type SetStageArchivedResult =
  | { ok: true; stage: Stage }
  | { ok: false; reason: "not_found" | "has_applications" | "last_stage" };

export type DeleteStageResult = { ok: true } | { ok: false; reason: "not_found" | "in_use" | "last_stage" };

export type MoveStageResult = { ok: true } | { ok: false; reason: "not_found" };

export type MoveDirection = "up" | "down";

const notFound = { ok: false, reason: "not_found" } as const;
const duplicateName = (): StageResult => ({
  ok: false,
  reason: "invalid",
  fieldErrors: { name: ["A stage with this name already exists."] },
});

const stageColumns = {
  id: stage.id,
  name: stage.name,
  category: stage.category,
  position: stage.position,
  archived: stage.archived,
  createdAt: stage.createdAt,
  updatedAt: stage.updatedAt,
};

/** Postgres SQLSTATE of a driver error, also when Drizzle wraps it in `cause`. */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

// Every query below filters by `userId`: callers pass the id returned by `requireUser()`.

/**
 * Gives the user the default stages when they have none at all (archived included).
 * One statement, no transaction: concurrent calls insert the same names, the unique
 * index on (user_id, lower(name)) keeps one of each, and the rest do nothing.
 */
export async function ensureDefaultStages(db: Db, userId: string): Promise<void> {
  const rows = DEFAULT_STAGES.map(
    ({ name, category }, position) =>
      sql`(${crypto.randomUUID()}::text, ${name}::text, ${category}::stage_category, ${position}::integer)`,
  );
  await db.execute(sql`
    insert into "stage" ("id", "user_id", "name", "category", "position")
    select d."id", ${userId}::text, d."name", d."category", d."position"
    from (values ${sql.join(rows, sql`, `)}) as d("id", "name", "category", "position")
    where not exists (select 1 from "stage" s where s."user_id" = ${userId}::text)
    on conflict do nothing
  `);
}

async function selectStages(db: Db, userId: string): Promise<Stage[]> {
  return db
    .select(stageColumns)
    .from(stage)
    .where(eq(stage.userId, userId))
    .orderBy(asc(stage.position), asc(stage.createdAt), asc(stage.id));
}

/** The user's stages, archived included, in board order. Seeds the defaults on first use. */
export async function listStages(db: Db, userId: string): Promise<Stage[]> {
  const stages = await selectStages(db, userId);
  if (stages.length > 0) return stages;
  await ensureDefaultStages(db, userId);
  return selectStages(db, userId);
}

/** The user's stage with this id, or null when it does not exist or belongs to someone else. */
export async function getStage(db: Db, userId: string, id: string): Promise<Stage | null> {
  const [row] = await db
    .select(stageColumns)
    .from(stage)
    .where(and(eq(stage.userId, userId), eq(stage.id, id)))
    .limit(1);
  return row ?? null;
}

async function loaded(db: Db, userId: string, id: string): Promise<StageResult> {
  const row = await getStage(db, userId, id);
  return row ? { ok: true, stage: row } : notFound;
}

/** Validates the input and appends a new stage after the user's last one. */
export async function createStage(db: Db, userId: string, input: unknown): Promise<StageResult> {
  const parsed = parseStageInput(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  // The defaults come first, so a brand-new user's own stage lands after them.
  await ensureDefaultStages(db, userId);

  const [row] = await db
    .insert(stage)
    .values({
      ...parsed.data,
      userId,
      position: sql`(select coalesce(max(s."position"), -1) + 1 from "stage" s where s."user_id" = ${userId})`,
    })
    .onConflictDoNothing()
    .returning({ id: stage.id });
  // The only unique key a new random id can hit is the name.
  if (!row) return duplicateName();
  return loaded(db, userId, row.id);
}

/** Renames the user's stage and sets its category. */
export async function updateStage(db: Db, userId: string, id: string, input: unknown): Promise<StageResult> {
  if (!(await getStage(db, userId, id))) return notFound;
  const parsed = parseStageInput(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };

  try {
    const updated = await db
      .update(stage)
      .set(parsed.data)
      .where(and(eq(stage.userId, userId), eq(stage.id, id)))
      .returning({ id: stage.id });
    if (updated.length === 0) return notFound;
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) return duplicateName();
    throw error;
  }
  return loaded(db, userId, id);
}

/**
 * Swaps the stage with its neighbour in board order; a no-op at either end.
 * Positions are rewritten as 0..n-1 in one statement, which also closes gaps left by deletes.
 */
export async function moveStage(db: Db, userId: string, id: string, direction: MoveDirection): Promise<MoveStageResult> {
  const stages = await selectStages(db, userId);
  const index = stages.findIndex((s) => s.id === id);
  if (index < 0) return notFound;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= stages.length) return { ok: true };

  const order = [...stages];
  [order[index], order[target]] = [order[target], order[index]];
  const changes = order.map((s, position) => ({ id: s.id, position })).filter((c, i) => order[i].position !== c.position);
  if (changes.length === 0) return { ok: true };

  await db
    .update(stage)
    .set({
      position: sql`case ${sql.join(
        changes.map((c) => sql`when "stage"."id" = ${c.id} then ${c.position}::integer`),
        sql` `,
      )} end`,
    })
    .where(
      and(
        eq(stage.userId, userId),
        inArray(
          stage.id,
          changes.map((c) => c.id),
        ),
      ),
    );
  return { ok: true };
}

/** True when the user has a non-archived application in the stage. */
async function hasActiveApplications(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: application.id })
    .from(application)
    .where(and(eq(application.userId, userId), eq(application.stageId, id), eq(application.archived, false)))
    .limit(1);
  return rows.length > 0;
}

/** Raw SQL: some application of the user is in the stage, or the stage appears in any history. */
const usedSql = (userId: string) => sql`(
  exists (select 1 from "application" a where a."user_id" = ${userId} and a."stage_id" = "stage"."id")
  or exists (
    select 1 from "stage_transition" t
    where t."user_id" = ${userId} and (t."from_stage_id" = "stage"."id" or t."to_stage_id" = "stage"."id")
  )
)`;

async function isUsed(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: stage.id })
    .from(stage)
    .where(and(eq(stage.userId, userId), eq(stage.id, id), usedSql(userId)))
    .limit(1);
  return rows.length > 0;
}

/** Another non-archived stage of the same user exists (raw SQL, so it can sit in a single statement). */
const anotherActiveStage = (userId: string) => sql`exists (
  select 1 from "stage" other
  where other."user_id" = ${userId} and other."id" <> "stage"."id" and other."archived" = false
)`;

/**
 * Archives or restores the user's stage. Archiving is refused while active applications
 * are in the stage (`has_applications`) or when it is the last active stage (`last_stage`).
 * The rules are part of the update statement itself, so the check and the write cannot drift apart.
 */
export async function setStageArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean,
): Promise<SetStageArchivedResult> {
  const guards = archived
    ? [
        sql`not exists (
          select 1 from "application" a where a."stage_id" = "stage"."id" and a."archived" = false
        )`,
        sql`("stage"."archived" or ${anotherActiveStage(userId)})`,
      ]
    : [];
  const updated = await db
    .update(stage)
    .set({ archived })
    .where(and(eq(stage.userId, userId), eq(stage.id, id), ...guards))
    .returning({ id: stage.id });

  if (updated.length === 0) {
    if (!(await getStage(db, userId, id))) return notFound;
    if (await hasActiveApplications(db, userId, id)) return { ok: false, reason: "has_applications" };
    return { ok: false, reason: "last_stage" };
  }
  const row = await getStage(db, userId, id);
  return row ? { ok: true, stage: row } : notFound;
}

/**
 * Deletes the user's stage when no application (archived or not) uses it, no stage transition
 * mentions it, and it is not the last active stage. The foreign keys from application and
 * stage_transition also block a racing insert.
 */
export async function deleteStage(db: Db, userId: string, id: string): Promise<DeleteStageResult> {
  let deleted: { id: string }[];
  try {
    deleted = await db
      .delete(stage)
      .where(
        and(
          eq(stage.userId, userId),
          eq(stage.id, id),
          sql`not ${usedSql(userId)}`,
          sql`("stage"."archived" or ${anotherActiveStage(userId)})`,
        ),
      )
      .returning({ id: stage.id });
  } catch (error) {
    if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) return { ok: false, reason: "in_use" };
    throw error;
  }

  if (deleted.length === 0) {
    if (!(await getStage(db, userId, id))) return notFound;
    if (await isUsed(db, userId, id)) return { ok: false, reason: "in_use" };
    return { ok: false, reason: "last_stage" };
  }
  return { ok: true };
}

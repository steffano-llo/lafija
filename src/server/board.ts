import "server-only";

import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { application, company, stage, stageTransition } from "@/db/schema";
import { parseMoveInput } from "@/lib/validation/board";
import type { StageCategory } from "@/lib/validation/stage";
import type { Db } from "./applications";
import { isId } from "./ids";
import { keyAfter, keyForIndex } from "./ordering";
import { runAtomic } from "./atomic";
import { syncFollowUpSql } from "./reminders";

export type BoardCard = { id: string; companyName: string; role: string; appliedAt: string | null };

export type BoardColumn = { id: string; name: string; category: StageCategory; cards: BoardCard[] };

export type StageTransition = {
  id: string;
  applicationId: string;
  fromStageId: string | null;
  toStageId: string;
  at: Date;
};

export type MoveApplicationResult = { ok: true } | { ok: false; reason: "not_found" | "invalid" };

/** Board order: keys by code unit (see ordering.ts), ties broken by id so the order is stable. */
export const ORDER_KEY_SQL: SQL = sql`${application.position} collate "C"`;

/** Rows of a raw statement: Neon HTTP and PGlite both return `{ rows }` from `execute`. */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

// Every query below filters by `userId`: callers pass the id returned by `requireUser()`.

/** The user's non-archived stages in order, each with its non-archived applications in board order. */
export async function listBoard(db: Db, userId: string): Promise<{ columns: BoardColumn[] }> {
  const stages = await db
    .select({ id: stage.id, name: stage.name, category: stage.category })
    .from(stage)
    .where(and(eq(stage.userId, userId), eq(stage.archived, false)))
    .orderBy(asc(stage.position), asc(stage.createdAt), asc(stage.id));
  const cards = await db
    .select({
      id: application.id,
      stageId: application.stageId,
      companyName: company.name,
      role: application.role,
      appliedAt: application.appliedAt,
    })
    .from(application)
    .innerJoin(company, eq(company.id, application.companyId))
    .where(and(eq(application.userId, userId), eq(application.archived, false)))
    .orderBy(ORDER_KEY_SQL, asc(application.id));

  const columns = stages.map((s) => ({ ...s, cards: [] as BoardCard[] }));
  const byStage = new Map(columns.map((c) => [c.id, c]));
  for (const { stageId, ...card } of cards) byStage.get(stageId)?.cards.push(card);
  return { columns };
}

/** The user's stage history, oldest first (creation transitions included). */
export async function listStageTransitions(db: Db, userId: string): Promise<StageTransition[]> {
  return db
    .select({
      id: stageTransition.id,
      applicationId: stageTransition.applicationId,
      fromStageId: stageTransition.fromStageId,
      toStageId: stageTransition.toStageId,
      at: stageTransition.at,
    })
    .from(stageTransition)
    .where(eq(stageTransition.userId, userId))
    .orderBy(asc(stageTransition.at), sql`${stageTransition.fromStageId} is not null`, asc(stageTransition.id));
}

export type HistoryEntry = {
  id: string;
  at: Date;
  /** Null for the entry recorded when the application was created. */
  fromStageName: string | null;
  toStageName: string;
  /** "Created in Applied" or "Applied → Screening". */
  label: string;
};

export function historyLabel(fromStageName: string | null, toStageName: string): string {
  return fromStageName === null ? `Created in ${toStageName}` : `${fromStageName} → ${toStageName}`;
}

const fromStage = alias(stage, "from_stage");
const toStage = alias(stage, "to_stage");

/**
 * Stage history of the user's application, oldest first (same order as `listStageTransitions`),
 * with current stage names; null when the application is unknown or someone else's.
 */
export async function listApplicationHistory(
  db: Db,
  userId: string,
  applicationId: string,
): Promise<HistoryEntry[] | null> {
  if (!isId(applicationId)) return null;
  const [own] = await db
    .select({ id: application.id })
    .from(application)
    .where(and(eq(application.userId, userId), eq(application.id, applicationId)))
    .limit(1);
  if (!own) return null;
  const rows = await db
    .select({
      id: stageTransition.id,
      at: stageTransition.at,
      fromStageName: fromStage.name,
      toStageName: toStage.name,
    })
    .from(stageTransition)
    .leftJoin(fromStage, eq(fromStage.id, stageTransition.fromStageId))
    .innerJoin(toStage, eq(toStage.id, stageTransition.toStageId))
    .where(and(eq(stageTransition.userId, userId), eq(stageTransition.applicationId, applicationId)))
    .orderBy(asc(stageTransition.at), sql`${stageTransition.fromStageId} is not null`, asc(stageTransition.id));
  return rows.map((row) => ({ ...row, label: historyLabel(row.fromStageName, row.toStageName) }));
}

/** Sorted keys of the user's non-archived applications in a stage, leaving one application out. */
async function columnKeys(db: Db, userId: string, stageId: string, excludeId: string): Promise<string[]> {
  const rows = await db
    .select({ position: application.position })
    .from(application)
    .where(
      and(
        eq(application.userId, userId),
        eq(application.stageId, stageId),
        eq(application.archived, false),
        sql`${application.id} <> ${excludeId}`,
      ),
    )
    .orderBy(ORDER_KEY_SQL, asc(application.id));
  return rows.map((r) => r.position);
}

/**
 * Key that puts a new card at the bottom of the stage's column. Archived applications count,
 * so a restored one never ties with a newer card.
 */
export async function bottomKey(db: Db, userId: string, stageId: string): Promise<string> {
  const [last] = await db
    .select({ position: application.position })
    .from(application)
    .where(and(eq(application.userId, userId), eq(application.stageId, stageId)))
    .orderBy(sql`${ORDER_KEY_SQL} desc`)
    .limit(1);
  return keyAfter(last?.position ?? null);
}

/**
 * Moves the user's non-archived application to `index` in the column of `stageId` (a non-archived
 * stage of the same user). A change of stage appends a transition in the same statement as the
 * update, so one never happens without the other; a reorder within the column records nothing.
 * A second statement in the same transaction then syncs the automatic follow-up reminder
 * (`syncFollowUpSql`): after a stage change the old one is closed and, in an active stage, a new
 * one starts; a reorder or a refused move writes no transition, so it changes no reminder.
 */
export async function moveApplication(
  db: Db,
  userId: string,
  id: string,
  input: { stageId: unknown; index: unknown },
): Promise<MoveApplicationResult> {
  const parsed = parseMoveInput({ applicationId: id, ...input });
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { stageId, index } = parsed.data;

  const position = keyForIndex(await columnKeys(db, userId, stageId, id), index);
  const [moved] = await runAtomic(db, [
    sql`
    with "current" as (
      select a."id", a."user_id", a."stage_id" from "application" a
      where a."id" = ${id} and a."user_id" = ${userId} and a."archived" = false
        and exists (
          select 1 from "stage" s where s."id" = ${stageId} and s."user_id" = ${userId} and s."archived" = false
        )
      for update of a
    ),
    "moved" as (
      update "application" a set "stage_id" = ${stageId}, "position" = ${position}, "updated_at" = now()
      from "current" c
      where a."id" = c."id" and a."user_id" = c."user_id"
      returning a."id", a."user_id", c."stage_id" as "from_stage_id", a."stage_id" as "to_stage_id"
    ),
    "logged" as (
      insert into "stage_transition" ("id", "user_id", "application_id", "from_stage_id", "to_stage_id")
      select gen_random_uuid()::text, m."user_id", m."id", m."from_stage_id", m."to_stage_id"
      from "moved" m where m."from_stage_id" <> m."to_stage_id"
      returning "id"
    )
    select "id" from "moved"
  `,
    syncFollowUpSql(userId, id),
  ]);
  if (moved.length > 0) return { ok: true };

  const [own] = await db
    .select({ id: application.id })
    .from(application)
    .where(and(eq(application.userId, userId), eq(application.id, id), eq(application.archived, false)))
    .limit(1);
  return { ok: false, reason: own ? "invalid" : "not_found" };
}


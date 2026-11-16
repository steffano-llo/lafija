import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { application, company, stage } from "@/db/schema";
import { parseApplicationInput, parseNotesInput, type FieldErrors } from "@/lib/validation/application";
import type { StageCategory } from "@/lib/validation/stage";
import { bottomKey, rowsOf } from "./board";
import { isId } from "./ids";
import { ensureDefaultStages } from "./stages";

/**
 * Any Drizzle Postgres database with the app schema: Neon HTTP in the app, PGlite in tests.
 * Neon HTTP has no interactive transactions, so no function here relies on one.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Company = { id: string; name: string };

const applicationColumns = {
  id: application.id,
  companyId: application.companyId,
  companyName: company.name,
  stageId: application.stageId,
  stageName: stage.name,
  stageCategory: stage.category,
  stageArchived: stage.archived,
  role: application.role,
  url: application.url,
  source: application.source,
  salaryRange: application.salaryRange,
  appliedAt: application.appliedAt,
  notes: application.notes,
  archived: application.archived,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
};

export type Application = {
  id: string;
  companyId: string;
  companyName: string;
  stageId: string;
  stageName: string;
  stageCategory: StageCategory;
  stageArchived: boolean;
  role: string;
  url: string | null;
  source: string | null;
  salaryRange: string | null;
  appliedAt: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ApplicationResult =
  | { ok: true; application: Application }
  | { ok: false; reason: "invalid"; fieldErrors: FieldErrors }
  | { ok: false; reason: "not_found" };

export type SetApplicationArchivedResult = ApplicationResult | { ok: false; reason: "stage_archived" };

const notFound = { ok: false, reason: "not_found" } as const;

// Every query below filters by `userId`: callers pass the id returned by `requireUser()`.

/** The user's companies, alphabetically. */
export async function listCompanies(db: Db, userId: string): Promise<Company[]> {
  return db
    .select({ id: company.id, name: company.name })
    .from(company)
    .where(eq(company.userId, userId))
    .orderBy(asc(sql`lower(${company.name})`));
}

/**
 * The user's company with this name, ignoring case; created when missing.
 * Insert-then-select instead of a transaction: a concurrent insert of the same name
 * hits the unique index, does nothing, and both callers read the same row.
 */
export async function findOrCreateCompany(db: Db, userId: string, name: string): Promise<Company> {
  const trimmed = name.trim();
  await db.insert(company).values({ userId, name: trimmed }).onConflictDoNothing();
  const [row] = await db
    .select({ id: company.id, name: company.name })
    .from(company)
    .where(and(eq(company.userId, userId), sql`lower(${company.name}) = lower(${trimmed})`))
    .limit(1);
  if (!row) throw new Error("Company could not be created");
  return row;
}

/** The user's applications, archived or not, by applied date (newest first, undated last). */
export async function listApplications(
  db: Db,
  userId: string,
  { archived = false }: { archived?: boolean } = {},
): Promise<Application[]> {
  return db
    .select(applicationColumns)
    .from(application)
    .innerJoin(company, eq(company.id, application.companyId))
    .innerJoin(stage, eq(stage.id, application.stageId))
    .where(and(eq(application.userId, userId), eq(application.archived, archived)))
    .orderBy(sql`${application.appliedAt} desc nulls last`, desc(application.createdAt));
}

/** The user's application with this id, or null when it does not exist or belongs to someone else. */
export async function getApplication(db: Db, userId: string, id: string): Promise<Application | null> {
  if (!isId(id)) return null;
  const [row] = await db
    .select(applicationColumns)
    .from(application)
    .innerJoin(company, eq(company.id, application.companyId))
    .innerJoin(stage, eq(stage.id, application.stageId))
    .where(and(eq(application.userId, userId), eq(application.id, id)))
    .limit(1);
  return row ?? null;
}

const invalidStage = (): ApplicationResult => ({
  ok: false,
  reason: "invalid",
  fieldErrors: { stageId: ["Choose a valid stage."] },
});

/**
 * The stage an application should be stored in, or null when the requested one is not allowed.
 * Allowed: one of the user's non-archived stages, or the application's current stage (kept on edit
 * even if it was archived since). No stage requested: the current one, else the first active stage.
 */
async function resolveStageId(
  db: Db,
  userId: string,
  requested: string | undefined,
  currentStageId?: string,
): Promise<string | null> {
  if (requested === undefined) {
    if (currentStageId) return currentStageId;
    await ensureDefaultStages(db, userId);
    const [first] = await db
      .select({ id: stage.id })
      .from(stage)
      .where(and(eq(stage.userId, userId), eq(stage.archived, false)))
      .orderBy(asc(stage.position), asc(stage.createdAt), asc(stage.id))
      .limit(1);
    if (!first) throw new Error("User has no active stage");
    return first.id;
  }
  if (requested === currentStageId) return requested;
  const [row] = await db
    .select({ id: stage.id })
    .from(stage)
    .where(and(eq(stage.userId, userId), eq(stage.id, requested), eq(stage.archived, false)))
    .limit(1);
  return row?.id ?? null;
}

async function loaded(db: Db, userId: string, id: string): Promise<ApplicationResult> {
  const row = await getApplication(db, userId, id);
  return row ? { ok: true, application: row } : notFound;
}

/**
 * Validates the input, finds or creates the company by name and stores a new application at the
 * bottom of its stage's column. The insert and its first transition (null → stage) are one statement.
 */
export async function createApplication(db: Db, userId: string, input: unknown): Promise<ApplicationResult> {
  const parsed = parseApplicationInput(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  const { companyName, stageId: requestedStageId, ...fields } = parsed.data;

  // Checked before the company is found or created, so a refused stage has no side effects.
  const stageId = await resolveStageId(db, userId, requestedStageId);
  if (!stageId) return invalidStage();
  const target = await findOrCreateCompany(db, userId, companyName);
  const id = crypto.randomUUID();
  const position = await bottomKey(db, userId, stageId);
  await db.execute(sql`
    with "created" as (
      insert into "application"
        ("id", "user_id", "company_id", "stage_id", "role", "url", "source", "salary_range", "applied_at", "position")
      values (${id}, ${userId}, ${target.id}, ${stageId}, ${fields.role}, ${fields.url}, ${fields.source},
        ${fields.salaryRange}, ${fields.appliedAt}::date, ${position})
      returning "id", "user_id", "stage_id", "created_at"
    )
    insert into "stage_transition" ("id", "user_id", "application_id", "from_stage_id", "to_stage_id", "at")
    select gen_random_uuid()::text, c."user_id", c."id", null, c."stage_id", c."created_at" from "created" c
  `);
  return loaded(db, userId, id);
}

/**
 * Replaces the editable fields of the user's application. Ownership is checked first,
 * so a foreign or unknown id never creates a company for the caller. A missing `stageId`
 * keeps the current stage. A new stage puts the application at the bottom of that column and
 * appends a transition in the same statement as the update. A new company unlinks the contacts of
 * the old one in that statement too.
 */
export async function updateApplication(
  db: Db,
  userId: string,
  id: string,
  input: unknown,
): Promise<ApplicationResult> {
  const current = await getApplication(db, userId, id);
  if (!current) return notFound;
  const parsed = parseApplicationInput(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  const { companyName, stageId: requestedStageId, ...fields } = parsed.data;

  const stageId = await resolveStageId(db, userId, requestedStageId, current.stageId);
  if (!stageId) return invalidStage();
  const target = await findOrCreateCompany(db, userId, companyName);
  // Used only if the stage changes; the statement keeps the current key otherwise.
  const position = await bottomKey(db, userId, stageId);
  const result = await db.execute(sql`
    with "current" as (
      select a."id", a."user_id", a."stage_id" from "application" a
      where a."id" = ${id} and a."user_id" = ${userId}
      for update of a
    ),
    "updated" as (
      update "application" a set
        "company_id" = ${target.id},
        "stage_id" = ${stageId},
        "role" = ${fields.role},
        "url" = ${fields.url},
        "source" = ${fields.source},
        "salary_range" = ${fields.salaryRange},
        "applied_at" = ${fields.appliedAt}::date,
        "position" = case when c."stage_id" = ${stageId} then a."position" else ${position} end,
        "updated_at" = now()
      from "current" c
      where a."id" = c."id" and a."user_id" = c."user_id"
      returning a."id", a."user_id", c."stage_id" as "from_stage_id", a."stage_id" as "to_stage_id"
    ),
    "logged" as (
      insert into "stage_transition" ("id", "user_id", "application_id", "from_stage_id", "to_stage_id")
      select gen_random_uuid()::text, u."user_id", u."id", u."from_stage_id", u."to_stage_id"
      from "updated" u where u."from_stage_id" <> u."to_stage_id"
      returning "id"
    ),
    -- Contacts belong to a company: a new company drops the links to the old company's contacts.
    -- Same statement, so the foreign keys (checked at its end) never see a link across companies.
    "unlinked" as (
      delete from "application_contact" ac using "updated" u
      where ac."application_id" = u."id" and ac."user_id" = u."user_id" and ac."company_id" <> ${target.id}
      returning ac."contact_id"
    )
    select "id" from "updated"
  `);
  if (rowsOf<{ id: string }>(result).length === 0) return notFound;
  return loaded(db, userId, id);
}

/**
 * Archives or restores the user's application. Restoring is refused (`stage_archived`) while its
 * stage is archived, so no active application ever sits in an archived stage: the user unarchives
 * the stage or edits the application into another stage first. The check is part of the update.
 */
export async function setApplicationArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean,
): Promise<SetApplicationArchivedResult> {
  const restoreGuard = sql`exists (
    select 1 from "stage" s
    where s."id" = ${application.stageId} and s."user_id" = ${application.userId} and s."archived" = false
  )`;
  const updated = await db
    .update(application)
    .set({ archived })
    .where(and(eq(application.userId, userId), eq(application.id, id), archived ? undefined : restoreGuard))
    .returning({ id: application.id });
  if (updated.length === 0) {
    const current = await getApplication(db, userId, id);
    return current ? { ok: false, reason: "stage_archived" } : notFound;
  }
  return loaded(db, userId, id);
}


export type NotesResult =
  | { ok: true; notes: string | null }
  | { ok: false; reason: "invalid"; fieldErrors: { notes?: string[] } }
  | { ok: false; reason: "not_found" };

/** Replaces the free notes of the user's application; blank clears them. */
export async function updateApplicationNotes(
  db: Db,
  userId: string,
  id: string,
  input: unknown,
): Promise<NotesResult> {
  if (!isId(id)) return notFound;
  const parsed = parseNotesInput(input);
  if (!parsed.success) {
    // Unknown or foreign ids stay not_found whatever the input.
    return (await getApplication(db, userId, id))
      ? { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors }
      : notFound;
  }
  const [row] = await db
    .update(application)
    .set({ notes: parsed.data.notes })
    .where(and(eq(application.userId, userId), eq(application.id, id)))
    .returning({ notes: application.notes });
  return row ? { ok: true, notes: row.notes } : notFound;
}

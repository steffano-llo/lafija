import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { application, company } from "@/db/schema";
import { parseApplicationInput, type FieldErrors } from "@/lib/validation/application";

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
  role: application.role,
  url: application.url,
  source: application.source,
  salaryRange: application.salaryRange,
  appliedAt: application.appliedAt,
  archived: application.archived,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
};

export type Application = {
  id: string;
  companyId: string;
  companyName: string;
  role: string;
  url: string | null;
  source: string | null;
  salaryRange: string | null;
  appliedAt: string | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ApplicationResult =
  | { ok: true; application: Application }
  | { ok: false; reason: "invalid"; fieldErrors: FieldErrors }
  | { ok: false; reason: "not_found" };

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
    .where(and(eq(application.userId, userId), eq(application.archived, archived)))
    .orderBy(sql`${application.appliedAt} desc nulls last`, desc(application.createdAt));
}

/** The user's application with this id, or null when it does not exist or belongs to someone else. */
export async function getApplication(db: Db, userId: string, id: string): Promise<Application | null> {
  const [row] = await db
    .select(applicationColumns)
    .from(application)
    .innerJoin(company, eq(company.id, application.companyId))
    .where(and(eq(application.userId, userId), eq(application.id, id)))
    .limit(1);
  return row ?? null;
}

async function loaded(db: Db, userId: string, id: string): Promise<ApplicationResult> {
  const row = await getApplication(db, userId, id);
  return row ? { ok: true, application: row } : notFound;
}

/** Validates the input, finds or creates the company by name and stores a new application. */
export async function createApplication(db: Db, userId: string, input: unknown): Promise<ApplicationResult> {
  const parsed = parseApplicationInput(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  const { companyName, ...fields } = parsed.data;

  const target = await findOrCreateCompany(db, userId, companyName);
  const [row] = await db
    .insert(application)
    .values({ ...fields, userId, companyId: target.id })
    .returning({ id: application.id });
  return loaded(db, userId, row.id);
}

/**
 * Replaces the editable fields of the user's application. Ownership is checked first,
 * so a foreign or unknown id never creates a company for the caller.
 */
export async function updateApplication(
  db: Db,
  userId: string,
  id: string,
  input: unknown,
): Promise<ApplicationResult> {
  if (!(await getApplication(db, userId, id))) return notFound;
  const parsed = parseApplicationInput(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors };
  const { companyName, ...fields } = parsed.data;

  const target = await findOrCreateCompany(db, userId, companyName);
  const updated = await db
    .update(application)
    .set({ ...fields, companyId: target.id })
    .where(and(eq(application.userId, userId), eq(application.id, id)))
    .returning({ id: application.id });
  if (updated.length === 0) return notFound;
  return loaded(db, userId, id);
}

/** Archives or restores the user's application. */
export async function setApplicationArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean,
): Promise<ApplicationResult> {
  const updated = await db
    .update(application)
    .set({ archived })
    .where(and(eq(application.userId, userId), eq(application.id, id)))
    .returning({ id: application.id });
  if (updated.length === 0) return notFound;
  return loaded(db, userId, id);
}

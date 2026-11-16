import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { application, interview } from "@/db/schema";
import {
  parseInterviewInput,
  parseInterviewOutcome,
  type InterviewFieldErrors,
  type InterviewOutcome,
  type InterviewType,
} from "@/lib/validation/interview";
import type { Db } from "./applications";
import { isId } from "./ids";

export type Interview = {
  id: string;
  applicationId: string;
  scheduledAt: Date;
  type: InterviewType;
  notes: string | null;
  outcome: InterviewOutcome;
  createdAt: Date;
  updatedAt: Date;
};

export type InterviewResult =
  | { ok: true; interview: Interview }
  | { ok: false; reason: "invalid"; fieldErrors: InterviewFieldErrors }
  | { ok: false; reason: "not_found" };

export type InterviewOutcomeResult =
  | { ok: true; interview: Interview }
  | { ok: false; reason: "invalid" | "not_found" };

const notFound = { ok: false, reason: "not_found" } as const;

const interviewColumns = {
  id: interview.id,
  applicationId: interview.applicationId,
  scheduledAt: interview.scheduledAt,
  type: interview.type,
  notes: interview.notes,
  outcome: interview.outcome,
  createdAt: interview.createdAt,
  updatedAt: interview.updatedAt,
};

// Every query below filters by `userId`: callers pass the id returned by `requireUser()`.

async function ownsApplication(db: Db, userId: string, applicationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: application.id })
    .from(application)
    .where(and(eq(application.userId, userId), eq(application.id, applicationId)))
    .limit(1);
  return Boolean(row);
}

async function ownsInterview(db: Db, userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: interview.id })
    .from(interview)
    .where(and(eq(interview.userId, userId), eq(interview.id, id)))
    .limit(1);
  return Boolean(row);
}

/** Interviews of the user's application by scheduled time; null when the application is not theirs. */
export async function listInterviews(db: Db, userId: string, applicationId: string): Promise<Interview[] | null> {
  if (!isId(applicationId) || !(await ownsApplication(db, userId, applicationId))) return null;
  return db
    .select(interviewColumns)
    .from(interview)
    .where(and(eq(interview.userId, userId), eq(interview.applicationId, applicationId)))
    .orderBy(asc(interview.scheduledAt), asc(interview.createdAt), asc(interview.id));
}

/** Adds an interview to the user's application. */
export async function createInterview(
  db: Db,
  userId: string,
  applicationId: string,
  input: unknown,
): Promise<InterviewResult> {
  if (!isId(applicationId)) return notFound;
  const parsed = parseInterviewInput(input);
  if (!parsed.success) {
    return (await ownsApplication(db, userId, applicationId))
      ? { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors }
      : notFound;
  }
  if (!(await ownsApplication(db, userId, applicationId))) return notFound;
  // The composite foreign key (application_id, user_id) also refuses another user's application.
  const [row] = await db
    .insert(interview)
    .values({ ...parsed.data, userId, applicationId })
    .returning(interviewColumns);
  return row ? { ok: true, interview: row } : notFound;
}

/** Replaces the date, type, outcome and notes of the user's interview. */
export async function updateInterview(db: Db, userId: string, id: string, input: unknown): Promise<InterviewResult> {
  if (!isId(id)) return notFound;
  const parsed = parseInterviewInput(input);
  if (!parsed.success) {
    return (await ownsInterview(db, userId, id))
      ? { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors }
      : notFound;
  }
  const [row] = await db
    .update(interview)
    .set(parsed.data)
    .where(and(eq(interview.userId, userId), eq(interview.id, id)))
    .returning(interviewColumns);
  return row ? { ok: true, interview: row } : notFound;
}

/** Sets only the outcome of the user's interview. */
export async function setInterviewOutcome(
  db: Db,
  userId: string,
  id: string,
  outcome: unknown,
): Promise<InterviewOutcomeResult> {
  if (!isId(id)) return notFound;
  const parsed = parseInterviewOutcome(outcome);
  if (!parsed) return (await ownsInterview(db, userId, id)) ? { ok: false, reason: "invalid" } : notFound;
  const [row] = await db
    .update(interview)
    .set({ outcome: parsed })
    .where(and(eq(interview.userId, userId), eq(interview.id, id)))
    .returning(interviewColumns);
  return row ? { ok: true, interview: row } : notFound;
}

export async function deleteInterview(db: Db, userId: string, id: string): Promise<{ ok: true } | typeof notFound> {
  if (!isId(id)) return notFound;
  const deleted = await db
    .delete(interview)
    .where(and(eq(interview.userId, userId), eq(interview.id, id)))
    .returning({ id: interview.id });
  return deleted.length > 0 ? { ok: true } : notFound;
}

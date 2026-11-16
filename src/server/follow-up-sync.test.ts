import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { application, reminder, stageTransition, user } from "@/db/schema";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { createApplication, updateApplication, setApplicationArchived } = await import("./applications");
const { listStages } = await import("./stages");
const { moveApplication, listStageTransitions } = await import("./board");
const { listApplicationReminders, setReminderDone, setFollowUpDays, updateReminder, createReminder, syncFollowUp } =
  await import("./reminders");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

let db: TestDb;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 30_000);

afterAll(async () => {
  await close();
});

const DAY = 24 * 60 * 60 * 1000;

async function newUser() {
  counter += 1;
  const id = `sync-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `sync${counter}@example.com` });
  return id;
}

async function stageNamed(userId: string, name: string) {
  const found = (await listStages(db, userId)).find((s) => s.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

async function newApplication(userId: string, role = "Engineer") {
  const result = await createApplication(db, userId, { companyName: "Acme", role });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

async function followUps(userId: string, applicationId: string) {
  const all = await listApplicationReminders(db, userId, applicationId);
  if (!all) throw new Error("not found");
  return all.filter((r) => r.kind === "follow_up");
}

/** Raw follow-up rows of the user (all columns), to prove repeat syncs change nothing. */
async function rawFollowUps(userId: string) {
  return JSON.stringify(await db.select().from(reminder).where(eq(reminder.userId, userId)).orderBy(reminder.id));
}

type Tx = Parameters<Parameters<TestDb["transaction"]>[0]>[0];

/**
 * What a statement (a) writes without its follow-up part: a new transition into `stageId` (at the
 * transaction's `now()`, the column default) and the application moved there. Run inside `inTx`
 * with the sync, like the writers' two-statement transaction.
 */
async function rawTransition(tx: Tx | TestDb, userId: string, applicationId: string, stageId: string) {
  const [current] = await tx
    .select({ stageId: application.stageId })
    .from(application)
    .where(and(eq(application.id, applicationId), eq(application.userId, userId)));
  const [row] = await tx
    .insert(stageTransition)
    .values({ userId, applicationId, fromStageId: current.stageId, toStageId: stageId })
    .returning();
  await tx
    .update(application)
    .set({ stageId })
    .where(and(eq(application.id, applicationId), eq(application.userId, userId)));
  return row;
}

/** One transaction, so `now()` is the same for every statement in `fn`. */
function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

async function latestTransition(userId: string, applicationId: string) {
  const all = (await listStageTransitions(db, userId)).filter((t) => t.applicationId === applicationId);
  return all[all.length - 1];
}

describe("syncFollowUp: one statement derives the follow-up state after this transaction's transition", () => {
  it("closes a stale follow-up of an earlier transition and creates the one of the latest, once", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    const [stale] = await followUps(userId, app.id);
    const t2 = await inTx(async (tx) => {
      const row = await rawTransition(tx, userId, app.id, screening.id);
      await syncFollowUp(tx, userId, app.id);
      await syncFollowUp(tx, userId, app.id); // idempotent within the transaction
      return row;
    });

    const after = await followUps(userId, app.id);
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === stale.id)?.doneAt).toBeInstanceOf(Date);
    expect(after.filter((r) => r.doneAt === null)).toEqual([
      expect.objectContaining({
        transitionId: t2.id,
        dueAt: new Date(t2.at.getTime() + 7 * DAY),
        message: "Follow up with Acme about Engineer",
        sentAt: null,
      }),
    ]);

    const once = await rawFollowUps(userId);
    await syncFollowUp(db, userId, app.id);
    expect(await rawFollowUps(userId)).toBe(once);
  });

  it("closes an open follow-up left in a non-active stage and creates none", async () => {
    const userId = await newUser();
    const offer = await stageNamed(userId, "Offer");
    const app = await newApplication(userId);
    await inTx(async (tx) => {
      await rawTransition(tx, userId, app.id, offer.id);
      await syncFollowUp(tx, userId, app.id);
    });

    const after = await followUps(userId, app.id);
    expect(after).toHaveLength(1);
    expect(after[0].doneAt).toBeInstanceOf(Date);
    const once = await rawFollowUps(userId);
    await syncFollowUp(db, userId, app.id);
    expect(await rawFollowUps(userId)).toBe(once);
  });

  it("closes the open follow-up of an archived application and creates none", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    await db.update(application).set({ archived: true }).where(eq(application.id, app.id));

    await syncFollowUp(db, userId, app.id, "archive");

    const after = await followUps(userId, app.id);
    expect(after).toHaveLength(1);
    expect(after[0].doneAt).toBeInstanceOf(Date);
  });

  it("changes nothing without a transition of this transaction or an archived application, whatever the setting", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const kept = await newApplication(userId, "Kept");
    await setFollowUpDays(db, userId, { followUpDays: "off" });
    const before = await rawFollowUps(userId);

    await syncFollowUp(db, userId, app.id);
    await syncFollowUp(db, userId, kept.id, "archive");

    expect(await rawFollowUps(userId)).toBe(before);
  });

  it("creates the missing follow-up of the latest transition with the user's days", async () => {
    const userId = await newUser();
    await setFollowUpDays(db, userId, { followUpDays: "off" });
    const app = await newApplication(userId);
    expect(await followUps(userId, app.id)).toEqual([]);
    await setFollowUpDays(db, userId, { followUpDays: "4" });
    const screening = await stageNamed(userId, "Screening");

    await inTx(async (tx) => {
      await rawTransition(tx, userId, app.id, screening.id);
      await syncFollowUp(tx, userId, app.id);
    });

    const latest = await latestTransition(userId, app.id);
    expect(await followUps(userId, app.id)).toEqual([
      expect.objectContaining({ transitionId: latest.id, dueAt: new Date(latest.at.getTime() + 4 * DAY), doneAt: null }),
    ]);
  });

  it("never reopens or duplicates a follow-up the user marked done", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);

    const doneId = await inTx(async (tx) => {
      const t = await rawTransition(tx, userId, app.id, screening.id);
      await syncFollowUp(tx, userId, app.id);
      const [open] = await tx
        .update(reminder)
        .set({ doneAt: sql`now()` })
        .where(and(eq(reminder.transitionId, t.id), eq(reminder.kind, "follow_up")))
        .returning({ id: reminder.id });
      const rows = () => tx.select().from(reminder).where(eq(reminder.userId, userId)).orderBy(reminder.id);
      const before = JSON.stringify(await rows());
      await syncFollowUp(tx, userId, app.id);
      await syncFollowUp(tx, userId, app.id);
      expect(JSON.stringify(await rows())).toBe(before);
      return open.id;
    });

    const after = await followUps(userId, app.id);
    expect(after.filter((r) => r.doneAt === null)).toEqual([]);
    expect(after.find((r) => r.id === doneId)?.doneAt).toBeInstanceOf(Date);
  });

  it("leaves manual reminders and other applications alone", async () => {
    const userId = await newUser();
    const other = await newUser();
    const app = await newApplication(userId);
    const manual = await createReminder(db, userId, app.id, { dueAt: "2030-01-01T10:00:00Z", message: "Call" });
    const foreign = await newApplication(other);
    await db.update(application).set({ archived: true }).where(eq(application.id, app.id));
    await db.update(application).set({ archived: true }).where(eq(application.id, foreign.id));
    const otherBefore = await rawFollowUps(other);

    await syncFollowUp(db, userId, app.id, "archive");
    // Another user's application through this user's id: nothing.
    await syncFollowUp(db, userId, foreign.id, "archive");

    const all = await listApplicationReminders(db, userId, app.id);
    expect(all?.find((r) => r.kind === "manual")).toEqual(
      expect.objectContaining({ id: manual.ok ? manual.reminder.id : "", doneAt: null }),
    );
    expect(await rawFollowUps(other)).toBe(otherBefore);
  });
});

/*
 * Real concurrency cannot happen on single-connection PGlite. These tests rebuild the states a
 * second writer could commit when its follow-up step read a snapshot from before the first
 * writer's commit (what T7's single-statement CTEs allowed), then prove the sync step, which now
 * runs as its own statement after the row lock and in B's transaction, ends in the one correct
 * state from them.
 */
describe("race outcomes: sync after the writer's statement repairs what a stale read would leave", () => {
  it("move A then move B to a non-active stage: A's follow-up ends closed, none open", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const offer = await stageNamed(userId, "Offer");
    const app = await newApplication(userId);
    expect(await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 })).toEqual({ ok: true });
    const afterA = (await followUps(userId, app.id)).find((r) => r.doneAt === null);
    expect(afterA).toBeDefined();

    await inTx(async (tx) => {
      await rawTransition(tx, userId, app.id, offer.id); // B's statement (a), blind to A's follow-up
      await syncFollowUp(tx, userId, app.id); // B's statement (b)
    });

    expect((await followUps(userId, app.id)).filter((r) => r.doneAt === null)).toEqual([]);
  });

  it("move A then move B to another active stage: A's closed, exactly one open for B (no 23505)", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const interviewStage = await stageNamed(userId, "Interview");
    const app = await newApplication(userId);
    await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 });

    const tB = await inTx(async (tx) => {
      const row = await rawTransition(tx, userId, app.id, interviewStage.id);
      await syncFollowUp(tx, userId, app.id);
      return row;
    });

    expect((await followUps(userId, app.id)).filter((r) => r.doneAt === null)).toEqual([
      expect.objectContaining({ transitionId: tB.id }),
    ]);
  });

  it("uses B's own transition even if B's start time is earlier than A's", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const interviewStage = await stageNamed(userId, "Interview");
    const app = await newApplication(userId);
    await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 });
    const tA = await latestTransition(userId, app.id);

    // B's transaction started before A's (now() is the start time) but took the lock after it:
    // A's time is pushed later instead, since B's now() cannot be set back.
    await db
      .update(stageTransition)
      .set({ at: new Date(Date.now() + 60_000) })
      .where(eq(stageTransition.id, tA.id));
    const tB = await inTx(async (tx) => {
      const row = await rawTransition(tx, userId, app.id, interviewStage.id);
      await syncFollowUp(tx, userId, app.id);
      return row;
    });

    expect((await followUps(userId, app.id)).filter((r) => r.doneAt === null)).toEqual([
      expect.objectContaining({ transitionId: tB.id }),
    ]);
  });

  it("move A then archive B: no open follow-up", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 });

    await inTx(async (tx) => {
      await tx.update(application).set({ archived: true }).where(eq(application.id, app.id));
      await syncFollowUp(tx, userId, app.id, "archive");
    });

    expect((await followUps(userId, app.id)).filter((r) => r.doneAt === null)).toEqual([]);
  });

  it("a reopen that slipped in before a move's sync is closed by it", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    const [first] = await followUps(userId, app.id);
    await setReminderDone(db, userId, first.id, true);

    const t2 = await inTx(async (tx) => {
      const row = await rawTransition(tx, userId, app.id, screening.id); // move (a)
      await tx.update(reminder).set({ doneAt: null }).where(eq(reminder.id, first.id)); // reopen committed first
      await syncFollowUp(tx, userId, app.id); // move (b)
      return row;
    });

    const after = await followUps(userId, app.id);
    expect(after.find((r) => r.id === first.id)?.doneAt).toBeInstanceOf(Date);
    expect(after.filter((r) => r.doneAt === null)).toEqual([expect.objectContaining({ transitionId: t2.id })]);
  });
});

describe("reopen and edit", () => {
  it("reopen returns closed instead of failing when another follow-up of the application is open", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    const [first] = await followUps(userId, app.id);
    await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 });
    const current = (await followUps(userId, app.id)).find((r) => r.doneAt === null);
    if (!current) throw new Error("no open follow-up");
    await setReminderDone(db, userId, current.id, true);
    // Inconsistent on purpose: an older follow-up open while the latest one is done.
    await db.update(reminder).set({ doneAt: null }).where(eq(reminder.id, first.id));
    const before = await rawFollowUps(userId);

    expect(await setReminderDone(db, userId, current.id, false)).toEqual({ ok: false, reason: "closed" });
    expect(await rawFollowUps(userId)).toBe(before);
  });

  it("keeps sent_at when only the message changes or the due time is the same minute, clears it otherwise", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const created = await createReminder(db, userId, app.id, { dueAt: "2030-05-01T10:00:00Z", message: "Call" });
    if (!created.ok) throw new Error("create failed");
    const id = created.reminder.id;
    // Stored with sub-minute precision, like an automatic follow-up (transition time + days).
    await db.execute(
      sql`update "reminder" set "due_at" = '2030-05-01T10:00:30.123456Z', "sent_at" = now() where "id" = ${id}`,
    );
    const storedDue = async () =>
      (
        await db.execute<{ due: string }>(
          sql`select to_char("due_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "due" from "reminder" where "id" = ${id}`,
        )
      ).rows[0].due;

    // The form submits the minute the user sees (datetime-local), converted to an ISO instant.
    const renamed = await updateReminder(db, userId, id, { dueAt: "2030-05-01T10:00:00.000Z", message: "Call Ana" });
    expect(renamed).toEqual({
      ok: true,
      reminder: expect.objectContaining({ message: "Call Ana", sentAt: expect.any(Date) }),
    });
    expect(await storedDue()).toBe("2030-05-01T10:00:30.123456");

    const exact = await updateReminder(db, userId, id, { dueAt: "2030-05-01T10:00:30.123Z", message: "Call Ana" });
    expect(exact.ok && exact.reminder.sentAt).toBeInstanceOf(Date);

    const moved = await updateReminder(db, userId, id, { dueAt: "2030-05-01T10:01:00Z", message: "Call Ana" });
    expect(moved).toEqual({
      ok: true,
      reminder: expect.objectContaining({ dueAt: new Date("2030-05-01T10:01:00Z"), sentAt: null }),
    });
  });
});

describe("writes that record no transition leave reminders alone, whatever the setting", () => {
  /** Every reminder row of every user, all columns: refusals must leave it byte-identical. */
  async function allReminders() {
    return JSON.stringify(await db.select().from(reminder).orderBy(reminder.id));
  }

  it("follow-ups off: a refused move to another user's stage and a reorder keep the open follow-up", async () => {
    const userId = await newUser();
    const other = await newUser();
    const foreignStage = await stageNamed(other, "Screening");
    const app = await newApplication(userId);
    await newApplication(userId, "Second");
    await setFollowUpDays(db, userId, { followUpDays: "off" });
    const before = await allReminders();

    expect(await moveApplication(db, userId, app.id, { stageId: foreignStage.id, index: 0 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await allReminders()).toBe(before);

    expect(await moveApplication(db, userId, app.id, { stageId: app.stageId, index: 1 })).toEqual({ ok: true });
    expect(await allReminders()).toBe(before);

    expect(await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II" })).toMatchObject({
      ok: true,
    });
    expect(await allReminders()).toBe(before);
    expect((await followUps(userId, app.id)).filter((r) => r.doneAt === null)).toHaveLength(1);
  });

  it("follow-ups turned back on: refused moves, reorders and same-stage edits create no follow-up", async () => {
    const userId = await newUser();
    const other = await newUser();
    const foreignStage = await stageNamed(other, "Screening");
    await setFollowUpDays(db, userId, { followUpDays: "off" });
    const app = await newApplication(userId);
    await newApplication(userId, "Second");
    await setFollowUpDays(db, userId, { followUpDays: "7" });
    const before = await allReminders();

    expect(await moveApplication(db, userId, app.id, { stageId: foreignStage.id, index: 0 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await moveApplication(db, userId, app.id, { stageId: app.stageId, index: 1 })).toEqual({ ok: true });
    expect(await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II" })).toMatchObject({
      ok: true,
    });
    expect(await setApplicationArchived(db, other, app.id, true)).toEqual({ ok: false, reason: "not_found" });

    expect(await allReminders()).toBe(before);
    expect(await followUps(userId, app.id)).toEqual([]);
  });

  it("follow-ups off: a stage change closes the open follow-up and creates none", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    await setFollowUpDays(db, userId, { followUpDays: "off" });

    expect(await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 })).toEqual({ ok: true });

    const after = await followUps(userId, app.id);
    expect(after).toHaveLength(1);
    expect(after[0].doneAt).toBeInstanceOf(Date);
  });
});

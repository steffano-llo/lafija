import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { application, company, stage, stageTransition, user } from "@/db/schema";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { listStages, setStageArchived, deleteStage } = await import("./stages");
const { createApplication, setApplicationArchived, updateApplication, getApplication } = await import("./applications");
const { listBoard, listStageTransitions, moveApplication } = await import("./board");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

let db: TestDb;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

async function newUser() {
  counter += 1;
  const id = `board-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `board${counter}@example.com` });
  return id;
}

/** Raw rows of every app table: refusals must leave them byte-identical. */
async function snapshot() {
  return JSON.stringify([
    await db.select().from(stage).orderBy(stage.id),
    await db.select().from(application).orderBy(application.id),
    await db.select().from(company).orderBy(company.id),
    await db.select().from(stageTransition).orderBy(stageTransition.id),
  ]);
}

async function stageNamed(userId: string, name: string) {
  const found = (await listStages(db, userId)).find((s) => s.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

async function newApplication(userId: string, role: string, stageId?: string) {
  const result = await createApplication(db, userId, { companyName: "Acme", role, stageId });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

/** Roles per column name, in board order. */
async function board(userId: string) {
  const { columns } = await listBoard(db, userId);
  return Object.fromEntries(columns.map((c) => [c.name, c.cards.map((card) => card.role)]));
}

/** Transitions as [from name, to name] pairs for one application, oldest first. */
async function history(userId: string, applicationId: string) {
  const stages = new Map((await listStages(db, userId)).map((s) => [s.id, s.name]));
  return (await listStageTransitions(db, userId))
    .filter((t) => t.applicationId === applicationId)
    .map((t) => [t.fromStageId ? stages.get(t.fromStageId) : null, stages.get(t.toStageId)]);
}

describe("listBoard", () => {
  it("has one column per active stage in order, with active applications as cards", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const offer = await stageNamed(userId, "Offer");
    await setStageArchived(db, userId, offer.id, true);
    const first = await newApplication(userId, "First");
    await newApplication(userId, "Second");
    const hidden = await newApplication(userId, "Hidden", screening.id);
    await setApplicationArchived(db, userId, hidden.id, true);
    await createApplication(db, userId, { companyName: "Globex", role: "Dated", appliedAt: "2024-05-01" });

    const { columns } = await listBoard(db, userId);

    expect(columns.map((c) => c.name)).toEqual(["Applied", "Screening", "Interview", "Rejected", "Accepted"]);
    expect(columns[0].cards).toEqual([
      { id: first.id, companyName: "Acme", role: "First", appliedAt: null },
      expect.objectContaining({ role: "Second" }),
      expect.objectContaining({ companyName: "Globex", role: "Dated", appliedAt: "2024-05-01" }),
    ]);
    expect(columns[1].cards).toEqual([]);
  });

  it("never shows another user's applications", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await newApplication(alice, "Secret");

    expect(Object.values(await board(bob)).flat()).toEqual([]);
  });
});

describe("stage transitions", () => {
  it("records null → stage when an application is created", async () => {
    const userId = await newUser();
    const interview = await stageNamed(userId, "Interview");

    const created = await newApplication(userId, "Engineer", interview.id);

    expect(await history(userId, created.id)).toEqual([[null, "Interview"]]);
    const [transition] = await listStageTransitions(db, userId);
    expect(transition.at).toEqual(created.createdAt);
  });

  it("records a stage change from the edit form, and nothing when the stage stays", async () => {
    const userId = await newUser();
    const offer = await stageNamed(userId, "Offer");
    const created = await newApplication(userId, "Engineer");

    await updateApplication(db, userId, created.id, { companyName: "Acme", role: "Lead" });
    await updateApplication(db, userId, created.id, { companyName: "Acme", role: "Lead", stageId: created.stageId });
    expect(await history(userId, created.id)).toEqual([[null, "Applied"]]);

    const updated = await updateApplication(db, userId, created.id, { companyName: "Acme", role: "Lead", stageId: offer.id });

    expect(updated).toMatchObject({ ok: true, application: { stageId: offer.id, role: "Lead" } });
    expect(await history(userId, created.id)).toEqual([
      [null, "Applied"],
      ["Applied", "Offer"],
    ]);
  });

  it("puts an application moved by the edit form at the bottom of its new column", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    await newApplication(userId, "Already there", screening.id);
    const moving = await newApplication(userId, "Moving");

    await updateApplication(db, userId, moving.id, { companyName: "Acme", role: "Moving", stageId: screening.id });

    expect((await board(userId)).Screening).toEqual(["Already there", "Moving"]);
  });

  it("refused edits record nothing", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const own = await newApplication(alice, "Engineer");
    const bobsStage = await stageNamed(bob, "Offer");
    const before = await snapshot();

    expect(await updateApplication(db, alice, own.id, { companyName: "Acme", role: "X", stageId: bobsStage.id })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(await updateApplication(db, bob, own.id, { companyName: "Acme", role: "X", stageId: bobsStage.id })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await snapshot()).toBe(before);
  });

  it("are deleted with their application's user", async () => {
    const userId = await newUser();
    await newApplication(userId, "Engineer");

    await db.delete(user).where(eq(user.id, userId));

    expect(await listStageTransitions(db, userId)).toEqual([]);
  });
});

describe("moveApplication", () => {
  it("reorders within a column (top, middle, bottom) without recording a transition", async () => {
    const userId = await newUser();
    const a = await newApplication(userId, "A");
    await newApplication(userId, "B");
    const c = await newApplication(userId, "C");
    const applied = a.stageId;
    const transitionsBefore = await listStageTransitions(db, userId);

    expect(await moveApplication(db, userId, c.id, { stageId: applied, index: 0 })).toEqual({ ok: true });
    expect((await board(userId)).Applied).toEqual(["C", "A", "B"]);

    expect(await moveApplication(db, userId, c.id, { stageId: applied, index: 1 })).toEqual({ ok: true });
    expect((await board(userId)).Applied).toEqual(["A", "C", "B"]);

    expect(await moveApplication(db, userId, a.id, { stageId: applied, index: 2 })).toEqual({ ok: true });
    expect((await board(userId)).Applied).toEqual(["C", "B", "A"]);

    expect(await listStageTransitions(db, userId)).toEqual(transitionsBefore);
  });

  it("moves between columns at the requested place and records one transition", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const x = await newApplication(userId, "X", screening.id);
    const y = await newApplication(userId, "Y", screening.id);
    const moving = await newApplication(userId, "Moving");

    expect(await moveApplication(db, userId, moving.id, { stageId: screening.id, index: 1 })).toEqual({ ok: true });

    expect(await board(userId)).toMatchObject({ Applied: [], Screening: ["X", "Moving", "Y"] });
    expect(await history(userId, moving.id)).toEqual([
      [null, "Applied"],
      ["Applied", "Screening"],
    ]);
    expect(await history(userId, x.id)).toEqual([[null, "Screening"]]);
    expect(await history(userId, y.id)).toEqual([[null, "Screening"]]);
    expect(await getApplication(db, userId, moving.id)).toMatchObject({ stageId: screening.id, stageName: "Screening" });

    const interview = await stageNamed(userId, "Interview");
    expect(await moveApplication(db, userId, moving.id, { stageId: interview.id, index: 0 })).toEqual({ ok: true });
    expect(await moveApplication(db, userId, x.id, { stageId: interview.id, index: 0 })).toEqual({ ok: true });
    expect(await moveApplication(db, userId, y.id, { stageId: interview.id, index: 2 })).toEqual({ ok: true });
    expect((await board(userId)).Interview).toEqual(["X", "Moving", "Y"]);
    expect(await history(userId, moving.id)).toEqual([
      [null, "Applied"],
      ["Applied", "Screening"],
      ["Screening", "Interview"],
    ]);
  });

  it("refuses an archived target stage, an unknown stage and an archived application with no change", async () => {
    const userId = await newUser();
    const offer = await stageNamed(userId, "Offer");
    await setStageArchived(db, userId, offer.id, true);
    const active = await newApplication(userId, "Active");
    const archived = await newApplication(userId, "Archived");
    await setApplicationArchived(db, userId, archived.id, true);
    const screening = await stageNamed(userId, "Screening");
    const before = await snapshot();

    expect(await moveApplication(db, userId, active.id, { stageId: offer.id, index: 0 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await moveApplication(db, userId, active.id, { stageId: "missing", index: 0 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await moveApplication(db, userId, archived.id, { stageId: screening.id, index: 0 })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await moveApplication(db, userId, "missing", { stageId: screening.id, index: 0 })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await snapshot()).toBe(before);
  });

  it("isolates users: another user's application or stage is refused with no change", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const alicesApp = await newApplication(alice, "Alice's");
    const bobsApp = await newApplication(bob, "Bob's");
    const alicesScreening = await stageNamed(alice, "Screening");
    const bobsScreening = await stageNamed(bob, "Screening");
    const before = await snapshot();

    expect(await moveApplication(db, bob, alicesApp.id, { stageId: bobsScreening.id, index: 0 })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await moveApplication(db, bob, alicesApp.id, { stageId: alicesScreening.id, index: 0 })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await moveApplication(db, bob, bobsApp.id, { stageId: alicesScreening.id, index: 0 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await snapshot()).toBe(before);
    expect(await listStageTransitions(db, bob)).toHaveLength(1);
    expect(await listStageTransitions(db, alice)).toHaveLength(1);
  });

  it("refuses an invalid index with no change", async () => {
    const userId = await newUser();
    const app = await newApplication(userId, "A");
    const before = await snapshot();

    for (const index of [-1, 1.5, Number.NaN]) {
      expect(await moveApplication(db, userId, app.id, { stageId: app.stageId, index })).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(await snapshot()).toBe(before);
  });
});

describe("unarchiving an application", () => {
  it("is refused while its stage is archived, with no change; works once the stage is active", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId, "Engineer", screening.id);
    await setApplicationArchived(db, userId, app.id, true);
    await setStageArchived(db, userId, screening.id, true);
    const before = await snapshot();

    expect(await setApplicationArchived(db, userId, app.id, false)).toEqual({ ok: false, reason: "stage_archived" });
    expect(await snapshot()).toBe(before);

    await setStageArchived(db, userId, screening.id, false);
    expect(await setApplicationArchived(db, userId, app.id, false)).toMatchObject({ ok: true, application: { archived: false } });
  });

  it("works after the application is edited into an active stage, which records the move", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const interview = await stageNamed(userId, "Interview");
    const app = await newApplication(userId, "Engineer", screening.id);
    await setApplicationArchived(db, userId, app.id, true);
    await setStageArchived(db, userId, screening.id, true);

    await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer", stageId: interview.id });

    expect(await setApplicationArchived(db, userId, app.id, false)).toMatchObject({
      ok: true,
      application: { archived: false, stageId: interview.id },
    });
    expect(await history(userId, app.id)).toEqual([
      [null, "Screening"],
      ["Screening", "Interview"],
    ]);
  });
});

describe("stage delete with history", () => {
  it("is refused (in_use) for a stage that only appears in an application's history", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const interview = await stageNamed(userId, "Interview");
    const app = await newApplication(userId, "Engineer", screening.id);
    await moveApplication(db, userId, app.id, { stageId: interview.id, index: 0 });
    await setStageArchived(db, userId, screening.id, true);
    const before = await snapshot();

    expect(await deleteStage(db, userId, screening.id)).toEqual({ ok: false, reason: "in_use" });
    expect(await snapshot()).toBe(before);
  });
});

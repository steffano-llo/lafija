import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { application, company, stage, user } from "@/db/schema";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const {
  DEFAULT_STAGES,
  createStage,
  deleteStage,
  ensureDefaultStages,
  getStage,
  listStages,
  moveStage,
  setStageArchived,
  updateStage,
} = await import("./stages");
const { createApplication, setApplicationArchived, updateApplication } = await import("./applications");

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
  const id = `stage-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `stage${counter}@example.com` });
  return id;
}

/** Raw rows of every stage, application and company: refusals must leave them byte-identical. */
async function snapshot() {
  return JSON.stringify([
    await db.select().from(stage).orderBy(stage.id),
    await db.select().from(application).orderBy(application.id),
    await db.select().from(company).orderBy(company.id),
  ]);
}

const names = (stages: { name: string }[]) => stages.map((s) => s.name);

async function stageNamed(userId: string, name: string) {
  const found = (await listStages(db, userId)).find((s) => s.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

async function newApplication(userId: string, stageId?: string) {
  const result = await createApplication(db, userId, { companyName: "Acme", role: "Engineer", stageId });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

describe("default stages", () => {
  it("seeds Applied → Screening → Interview → Offer → Rejected → Accepted with their categories", async () => {
    const userId = await newUser();

    await ensureDefaultStages(db, userId);

    const stages = await listStages(db, userId);
    expect(stages.map(({ name, category, archived }) => ({ name, category, archived }))).toEqual([
      { name: "Applied", category: "active", archived: false },
      { name: "Screening", category: "active", archived: false },
      { name: "Interview", category: "active", archived: false },
      { name: "Offer", category: "offer", archived: false },
      { name: "Rejected", category: "rejected", archived: false },
      { name: "Accepted", category: "accepted", archived: false },
    ]);
    expect(DEFAULT_STAGES.map((s) => s.name)).toEqual(names(stages));
    expect(stages.map((s) => s.position)).toEqual([...stages.map((s) => s.position)].sort((a, b) => a - b));
  });

  it("is idempotent and never seeds another user", async () => {
    const alice = await newUser();
    const bob = await newUser();

    await ensureDefaultStages(db, alice);
    const first = await db.select().from(stage).where(eq(stage.userId, alice)).orderBy(stage.id);
    await ensureDefaultStages(db, alice);

    expect(await db.select().from(stage).where(eq(stage.userId, alice)).orderBy(stage.id)).toEqual(first);
    expect(await db.select().from(stage).where(eq(stage.userId, bob))).toEqual([]);
  });

  it("produces exactly six stages under concurrent calls", async () => {
    const userId = await newUser();

    await Promise.all(Array.from({ length: 5 }, () => ensureDefaultStages(db, userId)));

    expect(await db.select().from(stage).where(eq(stage.userId, userId))).toHaveLength(6);
  });

  it("does not seed again once the user has any stage, archived included", async () => {
    const userId = await newUser();
    await ensureDefaultStages(db, userId);
    const applied = await stageNamed(userId, "Applied");
    expect(await updateStage(db, userId, applied.id, { name: "Sent", category: "active" })).toMatchObject({ ok: true });
    expect(await setStageArchived(db, userId, applied.id, true)).toMatchObject({ ok: true });

    await ensureDefaultStages(db, userId);

    expect(await db.select().from(stage).where(eq(stage.userId, userId))).toHaveLength(6);
    expect(names(await listStages(db, userId))).not.toContain("Applied");
  });

  it("is seeded by listStages for a new user", async () => {
    const userId = await newUser();
    expect(names(await listStages(db, userId))).toEqual(DEFAULT_STAGES.map((s) => s.name));
  });
});

describe("createStage", () => {
  it("appends a stage at the end", async () => {
    const userId = await newUser();

    const result = await createStage(db, userId, { name: " Take-home ", category: "active" });

    expect(result).toEqual({
      ok: true,
      stage: expect.objectContaining({ name: "Take-home", category: "active", archived: false }),
    });
    const stages = await listStages(db, userId);
    expect(names(stages)).toEqual([...DEFAULT_STAGES.map((s) => s.name), "Take-home"]);
    expect(result.ok && (await getStage(db, userId, result.stage.id))).toEqual(result.ok && result.stage);
  });

  it("rejects invalid input and duplicate names (any case) without storing anything", async () => {
    const userId = await newUser();
    await listStages(db, userId);
    const before = await snapshot();

    expect(await createStage(db, userId, { name: "", category: "nope" })).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { name: ["Name is required."], category: ["Choose a category."] },
    });
    expect(await createStage(db, userId, { name: " offer ", category: "offer" })).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { name: ["A stage with this name already exists."] },
    });
    expect(await snapshot()).toBe(before);
  });

  it("allows the same name for different users", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await createStage(db, alice, { name: "Take-home", category: "active" });

    expect(await createStage(db, bob, { name: "take-home", category: "active" })).toMatchObject({ ok: true });
  });
});

describe("updateStage", () => {
  it("renames and changes the category", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");

    const result = await updateStage(db, userId, screening.id, { name: "Phone screen", category: "withdrawn" });

    const expected = { ...screening, name: "Phone screen", category: "withdrawn", updatedAt: expect.any(Date) };
    expect(result).toEqual({ ok: true, stage: expected });
    expect(await getStage(db, userId, screening.id)).toEqual(expected);
  });

  it("keeps its own name with a different case", async () => {
    const userId = await newUser();
    const offer = await stageNamed(userId, "Offer");

    expect(await updateStage(db, userId, offer.id, { name: "OFFER", category: "offer" })).toMatchObject({
      ok: true,
      stage: { name: "OFFER" },
    });
  });

  it("refuses invalid input, a duplicate name and unknown ids with no change", async () => {
    const userId = await newUser();
    const offer = await stageNamed(userId, "Offer");
    const before = await snapshot();

    expect(await updateStage(db, userId, offer.id, { name: " ", category: "offer" })).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { name: ["Name is required."] },
    });
    expect(await updateStage(db, userId, offer.id, { name: "applied", category: "offer" })).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { name: ["A stage with this name already exists."] },
    });
    expect(await updateStage(db, userId, "missing", { name: "X", category: "offer" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await snapshot()).toBe(before);
  });
});

describe("moveStage", () => {
  it("moves a stage up and down", async () => {
    const userId = await newUser();
    const offer = await stageNamed(userId, "Offer");

    expect(await moveStage(db, userId, offer.id, "up")).toEqual({ ok: true });
    expect(names(await listStages(db, userId))).toEqual(["Applied", "Screening", "Offer", "Interview", "Rejected", "Accepted"]);

    expect(await moveStage(db, userId, offer.id, "down")).toEqual({ ok: true });
    expect(await moveStage(db, userId, offer.id, "down")).toEqual({ ok: true });
    expect(names(await listStages(db, userId))).toEqual(["Applied", "Screening", "Interview", "Rejected", "Offer", "Accepted"]);
  });

  it("leaves the order unchanged at either end", async () => {
    const userId = await newUser();
    const stages = await listStages(db, userId);
    const before = await snapshot();

    expect(await moveStage(db, userId, stages[0].id, "up")).toEqual({ ok: true });
    expect(await moveStage(db, userId, stages[5].id, "down")).toEqual({ ok: true });
    expect(await snapshot()).toBe(before);
  });

  it("returns not found for an unknown id", async () => {
    const userId = await newUser();
    await listStages(db, userId);
    const before = await snapshot();

    expect(await moveStage(db, userId, "missing", "up")).toEqual({ ok: false, reason: "not_found" });
    expect(await snapshot()).toBe(before);
  });
});

describe("setStageArchived", () => {
  it("archives and unarchives an unused stage", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");

    expect(await setStageArchived(db, userId, screening.id, true)).toEqual({
      ok: true,
      stage: { ...screening, archived: true, updatedAt: expect.any(Date) },
    });
    expect(await setStageArchived(db, userId, screening.id, false)).toMatchObject({ ok: true, stage: { archived: false } });
  });

  it("allows archiving a stage that only has archived applications", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId, screening.id);
    await setApplicationArchived(db, userId, app.id, true);

    expect(await setStageArchived(db, userId, screening.id, true)).toMatchObject({ ok: true, stage: { archived: true } });
  });

  it("refuses while active applications are in the stage", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    await newApplication(userId, screening.id);
    const before = await snapshot();

    expect(await setStageArchived(db, userId, screening.id, true)).toEqual({ ok: false, reason: "has_applications" });
    expect(await snapshot()).toBe(before);
  });

  it("refuses to archive the last active stage", async () => {
    const userId = await newUser();
    const stages = await listStages(db, userId);
    for (const s of stages.slice(1)) await setStageArchived(db, userId, s.id, true);
    const before = await snapshot();

    expect(await setStageArchived(db, userId, stages[0].id, true)).toEqual({ ok: false, reason: "last_stage" });
    expect(await snapshot()).toBe(before);
  });

  it("returns not found for an unknown id", async () => {
    const userId = await newUser();
    expect(await setStageArchived(db, userId, "missing", true)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("deleteStage", () => {
  it("deletes an unused stage, archived or not", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const offer = await stageNamed(userId, "Offer");
    await setStageArchived(db, userId, offer.id, true);

    expect(await deleteStage(db, userId, screening.id)).toEqual({ ok: true });
    expect(await deleteStage(db, userId, offer.id)).toEqual({ ok: true });
    expect(names(await listStages(db, userId))).toEqual(["Applied", "Interview", "Rejected", "Accepted"]);
    expect(await getStage(db, userId, screening.id)).toBeNull();
  });

  it("refuses when any application, archived or not, uses the stage", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const interview = await stageNamed(userId, "Interview");
    await newApplication(userId, screening.id);
    const archived = await newApplication(userId, interview.id);
    await setApplicationArchived(db, userId, archived.id, true);
    const before = await snapshot();

    expect(await deleteStage(db, userId, screening.id)).toEqual({ ok: false, reason: "in_use" });
    expect(await deleteStage(db, userId, interview.id)).toEqual({ ok: false, reason: "in_use" });
    expect(await snapshot()).toBe(before);
  });

  it("keeps the last active stage holding only an archived application: archive is last_stage, delete is in_use", async () => {
    const userId = await newUser();
    const stages = await listStages(db, userId);
    for (const s of stages.slice(1)) await deleteStage(db, userId, s.id);
    const app = await newApplication(userId, stages[0].id);
    await setApplicationArchived(db, userId, app.id, true);
    const before = await snapshot();

    expect(await setStageArchived(db, userId, stages[0].id, true)).toEqual({ ok: false, reason: "last_stage" });
    expect(await deleteStage(db, userId, stages[0].id)).toEqual({ ok: false, reason: "in_use" });
    expect(await snapshot()).toBe(before);
  });

  it("refuses to delete the last active stage", async () => {
    const userId = await newUser();
    const stages = await listStages(db, userId);
    for (const s of stages.slice(1)) await deleteStage(db, userId, s.id);
    const before = await snapshot();

    expect(await deleteStage(db, userId, stages[0].id)).toEqual({ ok: false, reason: "last_stage" });
    expect(await snapshot()).toBe(before);
  });

  it("returns not found for an unknown id", async () => {
    const userId = await newUser();
    expect(await deleteStage(db, userId, "missing")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("per-user isolation", () => {
  it("keeps every stage operation away from another user's stages", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const aliceStages = await listStages(db, alice);
    await listStages(db, bob);
    const target = aliceStages[1];
    const before = await snapshot();

    expect(await getStage(db, bob, target.id)).toBeNull();
    expect((await listStages(db, bob)).map((s) => s.id)).not.toContain(target.id);
    expect(await updateStage(db, bob, target.id, { name: "Hijacked", category: "offer" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await moveStage(db, bob, target.id, "up")).toEqual({ ok: false, reason: "not_found" });
    expect(await setStageArchived(db, bob, target.id, true)).toEqual({ ok: false, reason: "not_found" });
    expect(await deleteStage(db, bob, target.id)).toEqual({ ok: false, reason: "not_found" });

    expect(await snapshot()).toBe(before);
    expect(await listStages(db, alice)).toEqual(aliceStages);
  });

  it("deletes a user's stages with the user", async () => {
    const userId = await newUser();
    await newApplication(userId);

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(stage).where(eq(stage.userId, userId))).toEqual([]);
  });
});

describe("application stage assignment", () => {
  it("defaults a new application to the first active stage", async () => {
    const userId = await newUser();
    const stages = await listStages(db, userId);
    await setStageArchived(db, userId, stages[0].id, true);

    const created = await newApplication(userId);

    expect(created).toMatchObject({ stageId: stages[1].id, stageName: "Screening", stageCategory: "active" });
  });

  it("creates and updates with a chosen stage", async () => {
    const userId = await newUser();
    const interview = await stageNamed(userId, "Interview");
    const offer = await stageNamed(userId, "Offer");

    const created = await newApplication(userId, interview.id);
    expect(created).toMatchObject({ stageId: interview.id, stageName: "Interview" });

    const updated = await updateApplication(db, userId, created.id, {
      companyName: "Acme",
      role: "Engineer",
      stageId: offer.id,
    });
    expect(updated).toMatchObject({ ok: true, application: { stageId: offer.id, stageName: "Offer", stageCategory: "offer" } });
  });

  it("refuses another user's stage, an archived stage and an unknown stage with no change", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const own = await newApplication(alice);
    // A company name the refused calls would otherwise create.
    const companyName = "Brand New Co";
    const bobsStage = (await listStages(db, bob))[2];
    const archivedStage = await stageNamed(alice, "Rejected");
    await setStageArchived(db, alice, archivedStage.id, true);
    const before = await snapshot();

    for (const stageId of [bobsStage.id, archivedStage.id, "missing"]) {
      const invalid = { ok: false, reason: "invalid", fieldErrors: { stageId: ["Choose a valid stage."] } };
      expect(await updateApplication(db, alice, own.id, { companyName, role: "Engineer", stageId })).toEqual(invalid);
      expect(await createApplication(db, alice, { companyName, role: "Engineer", stageId })).toEqual(invalid);
    }
    expect(await snapshot()).toBe(before);
  });

  it("keeps an application's current archived stage on edit", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId, screening.id);
    await setApplicationArchived(db, userId, app.id, true);
    await setStageArchived(db, userId, screening.id, true);

    expect(
      await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Lead", stageId: screening.id }),
    ).toMatchObject({ ok: true, application: { role: "Lead", stageId: screening.id, stageArchived: true } });
  });

  it("database rejects an application pointing at another user's stage", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const own = await newApplication(alice);
    const bobsStage = (await listStages(db, bob))[0];

    await expect(db.update(application).set({ stageId: bobsStage.id }).where(eq(application.id, own.id))).rejects.toThrow();
    await expect(db.select().from(company).where(eq(company.userId, bob))).resolves.toEqual([]);
  });
});

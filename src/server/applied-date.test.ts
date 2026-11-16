import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { application, reminder, stageTransition, user, userSettings } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { localDateIn } from "./test-zones";

vi.mock("server-only", () => ({}));

const { createApplication, updateApplication, getApplication } = await import("./applications");
const { listStages, setStageArchived } = await import("./stages");
const { moveApplication, listStageTransitions } = await import("./board");
const { setTimeZone } = await import("./settings");

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
  const id = `applied-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `applied${counter}@example.com` });
  return id;
}

async function stageNamed(userId: string, name: string) {
  const found = (await listStages(db, userId)).find((s) => s.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

async function newApplication(userId: string, input: Record<string, unknown> = {}) {
  const result = await createApplication(db, userId, { companyName: "Acme", role: "Engineer", ...input });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

async function latestTransition(userId: string, applicationId: string) {
  const all = (await listStageTransitions(db, userId)).filter((t) => t.applicationId === applicationId);
  return all[all.length - 1];
}

async function appliedAt(userId: string, id: string) {
  return (await getApplication(db, userId, id))?.appliedAt;
}

async function snapshot() {
  return JSON.stringify([
    await db.select().from(application).orderBy(application.id),
    await db.select().from(stageTransition).orderBy(stageTransition.id),
    await db.select().from(reminder).orderBy(reminder.id),
    await db.select().from(userSettings).orderBy(userSettings.userId),
  ]);
}

describe("applied date autofill", () => {
  it("is not filled when created in the first stage", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    expect(app.appliedAt).toBeNull();
  });

  it("is filled with the transition's UTC date when created into a later stage and no zone is known", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId, { stageId: screening.id });
    const t = await latestTransition(userId, app.id);
    expect(app.appliedAt).toBe(localDateIn(t.at, "UTC"));
  });

  it("never overwrites a typed date, on create, move or edit", async () => {
    const userId = await newUser();
    const offer = await stageNamed(userId, "Offer");
    const interview = await stageNamed(userId, "Interview");
    const app = await newApplication(userId, { stageId: offer.id, appliedAt: "2024-05-01" });
    expect(app.appliedAt).toBe("2024-05-01");

    expect(await moveApplication(db, userId, app.id, { stageId: interview.id, index: 0 })).toEqual({ ok: true });
    expect(await appliedAt(userId, app.id)).toBe("2024-05-01");

    const edited = await updateApplication(db, userId, app.id, {
      companyName: "Acme",
      role: "Engineer",
      stageId: offer.id,
      appliedAt: "2024-06-02",
    });
    expect(edited).toEqual({ ok: true, application: expect.objectContaining({ appliedAt: "2024-06-02" }) });
  });

  it("is filled by a board move from the first stage to a later one", async () => {
    const userId = await newUser();
    const interview = await stageNamed(userId, "Interview");
    const app = await newApplication(userId);
    expect(await moveApplication(db, userId, app.id, { stageId: interview.id, index: 0 })).toEqual({ ok: true });
    const t = await latestTransition(userId, app.id);
    expect(await appliedAt(userId, app.id)).toBe(localDateIn(t.at, "UTC"));
  });

  it("is filled by an edit-form stage change to a later stage, but not by an edit that keeps the stage", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);

    const same = await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II" });
    expect(same).toEqual({ ok: true, application: expect.objectContaining({ appliedAt: null }) });

    const moved = await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II", stageId: screening.id });
    const t = await latestTransition(userId, app.id);
    expect(moved).toEqual({ ok: true, application: expect.objectContaining({ appliedAt: localDateIn(t.at, "UTC") }) });

    // Cleared by the user while staying in the stage: stays empty.
    const cleared = await updateApplication(db, userId, app.id, {
      companyName: "Acme",
      role: "Engineer II",
      stageId: screening.id,
      appliedAt: "",
    });
    expect(cleared).toEqual({ ok: true, application: expect.objectContaining({ appliedAt: null }) });

    // A move back into the first stage does not fill it either.
    const applied = await stageNamed(userId, "Applied");
    expect(await moveApplication(db, userId, app.id, { stageId: applied.id, index: 0 })).toEqual({ ok: true });
    expect(await appliedAt(userId, app.id)).toBeNull();
  });

  it("uses the local date of the transition in the user's zone", async () => {
    const east = await newUser();
    const west = await newUser();
    await setTimeZone(db, east, { timeZone: "Pacific/Kiritimati" }); // UTC+14
    await setTimeZone(db, west, { timeZone: "Pacific/Pago_Pago" }); // UTC-11
    const a = await newApplication(east, { stageId: (await stageNamed(east, "Screening")).id });
    const b = await newApplication(west, { stageId: (await stageNamed(west, "Screening")).id });
    const ta = await latestTransition(east, a.id);
    const tb = await latestTransition(west, b.id);
    expect(a.appliedAt).toBe(localDateIn(ta.at, "Pacific/Kiritimati"));
    expect(b.appliedAt).toBe(localDateIn(tb.at, "Pacific/Pago_Pago"));
    // 25 hours apart: the two local dates always differ.
    expect(a.appliedAt).not.toBe(b.appliedAt);
  });

  it("counts from the first non-archived stage", async () => {
    const userId = await newUser();
    const applied = await stageNamed(userId, "Applied");
    const screening = await stageNamed(userId, "Screening");
    expect(await setStageArchived(db, userId, applied.id, true)).toMatchObject({ ok: true });
    const app = await newApplication(userId, { stageId: screening.id });
    expect(app.appliedAt).toBeNull();
  });

  it("reorders and refused moves change nothing", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const first = await newApplication(userId, { role: "First" });
    await newApplication(userId, { role: "Second" });
    expect(await moveApplication(db, userId, first.id, { stageId: first.stageId, index: 1 })).toEqual({ ok: true });
    expect(await appliedAt(userId, first.id)).toBeNull();

    const other = await newUser();
    const before = await snapshot();
    expect(await moveApplication(db, other, first.id, { stageId: screening.id, index: 0 })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await updateApplication(db, other, first.id, { companyName: "Acme", role: "X", stageId: screening.id }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await snapshot()).toBe(before);
  });
});

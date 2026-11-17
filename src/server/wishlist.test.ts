import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { application, company, reminder, stage, stageTransition, user, userSettings } from "@/db/schema";
import type { StageCategory } from "@/lib/validation/stage";
import { createTestDb } from "@/test/db";
import { localDateIn } from "./test-zones";

vi.mock("server-only", () => ({}));

const { getStats, getResponseRate, getFunnel, getSourceStats, getWeeklyApplications } = await import("./stats");
const { createApplication, updateApplication, getApplication } = await import("./applications");
const { createStage, listStages, moveStage } = await import("./stages");
const { moveApplication, listStageTransitions } = await import("./board");
const { listApplicationReminders } = await import("./reminders");

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

async function newUser(prefix = "wish") {
  counter += 1;
  const id = `${prefix}-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `${prefix}${counter}@example.com` });
  return id;
}

// ---------------------------------------------------------------------------------------------
// Statistics (S21). Every expectation is computed by hand from the seeded rows.

const NOW = new Date("2026-03-18T12:00:00Z"); // Wednesday, UTC (no zone stored)

const STAGES: [string, StageCategory][] = [
  ["Wishlist", "wishlist"],
  ["Saved", "wishlist"],
  ["Applied", "active"],
  ["Screen", "active"],
  ["Interview", "active"],
  ["Offer", "offer"],
  ["Rejected", "rejected"],
  ["Accepted", "accepted"],
  ["Withdrawn", "withdrawn"],
];

type Seed = { source: string | null; appliedAt: string | null; createdAt: string; path: [string, string][] };

const APPS: Seed[] = [
  // w1: wishlist → Applied: applied (week of 03-02 by its first non-wishlist transition), no response.
  { source: "LinkedIn", appliedAt: null, createdAt: "2026-02-23T10:00:00Z", path: [["Wishlist", "2026-02-23T10:00:00Z"], ["Applied", "2026-03-04T10:00:00Z"]] },
  // w2: only ever in wishlist stages: not applied yet.
  { source: "LinkedIn", appliedAt: null, createdAt: "2026-03-10T10:00:00Z", path: [["Wishlist", "2026-03-10T10:00:00Z"], ["Saved", "2026-03-11T10:00:00Z"]] },
  // w3: Applied → Rejected: a response.
  { source: "Referral", appliedAt: "2026-03-09", createdAt: "2026-03-09T10:00:00Z", path: [["Applied", "2026-03-09T10:00:00Z"], ["Rejected", "2026-03-12T10:00:00Z"]] },
  // w4: Applied → Withdrawn: not a response.
  { source: "Referral", appliedAt: null, createdAt: "2026-03-16T10:00:00Z", path: [["Applied", "2026-03-16T10:00:00Z"], ["Withdrawn", "2026-03-17T10:00:00Z"]] },
  // w5: created directly in Interview: applied there, no later stage → no response.
  { source: null, appliedAt: "2026-02-16", createdAt: "2026-02-16T10:00:00Z", path: [["Interview", "2026-02-16T10:00:00Z"]] },
  // w6: created in Interview, then Offer and Accepted: response, offer, accepted.
  { source: "Indeed", appliedAt: null, createdAt: "2026-03-11T10:00:00Z", path: [["Interview", "2026-03-11T10:00:00Z"], ["Offer", "2026-03-12T10:00:00Z"], ["Accepted", "2026-03-13T10:00:00Z"]] },
  // w7: Applied → Screen → back to Applied: responded (ever).
  { source: "Indeed", appliedAt: "2026-03-02", createdAt: "2026-03-02T10:00:00Z", path: [["Applied", "2026-03-02T10:00:00Z"], ["Screen", "2026-03-03T10:00:00Z"], ["Applied", "2026-03-04T10:00:00Z"]] },
  // w8: wishlist only, with a typed applied date: still not applied, so not in the weekly chart.
  { source: "Indeed", appliedAt: "2026-03-03", createdAt: "2026-03-03T10:00:00Z", path: [["Saved", "2026-03-03T10:00:00Z"]] },
];

async function seed(userId: string, stages: [string, StageCategory][], apps: Seed[]) {
  const ids = new Map<string, string>();
  for (const [position, [name, category]] of stages.entries()) {
    const id = `${userId}-s${position}`;
    await db.insert(stage).values({ id, userId, name, category, position });
    ids.set(name, id);
  }
  for (const [i, a] of apps.entries()) {
    const appId = `${userId}-a${i + 1}`;
    await db.insert(company).values({ id: `${userId}-c${i}`, userId, name: `Co ${i}` });
    await db.insert(application).values({
      id: appId,
      userId,
      companyId: `${userId}-c${i}`,
      stageId: ids.get(a.path[a.path.length - 1][0])!,
      role: "Engineer",
      source: a.source,
      appliedAt: a.appliedAt,
      position: "a0",
      createdAt: new Date(a.createdAt),
    });
    let from: string | null = null;
    for (const [step, [name, at]] of a.path.entries()) {
      await db.insert(stageTransition).values({
        id: `${appId}-t${step}`,
        userId,
        applicationId: appId,
        fromStageId: from,
        toStageId: ids.get(name)!,
        at: new Date(at),
      });
      from = ids.get(name)!;
    }
  }
  return ids;
}

function weeks(last: string, counts: Record<string, number>) {
  const end = new Date(`${last}T00:00:00Z`);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - 7 * (11 - i));
    const weekStart = d.toISOString().slice(0, 10);
    return { weekStart, count: counts[weekStart] ?? 0 };
  });
}

describe("response rate with wishlist stages (S21)", () => {
  let userId: string;
  let ids: Map<string, string>;

  beforeAll(async () => {
    userId = await newUser("rr");
    ids = await seed(userId, STAGES, APPS);
    // Another user whose wishlist apps all moved on: never counted for userId.
    const other = await newUser("rr-other");
    await seed(other, STAGES, [{ source: "LinkedIn", appliedAt: null, createdAt: "2026-03-16T00:00:00Z", path: [["Wishlist", "2026-03-16T00:00:00Z"], ["Applied", "2026-03-16T01:00:00Z"], ["Offer", "2026-03-16T02:00:00Z"]] }]);
  });

  it("base = applied applications; response = a later non-withdrawn, non-wishlist stage", async () => {
    // Applied: w1, w3, w4, w5, w6, w7. Responded: w3 (rejected), w6 (offer), w7 (screen).
    expect(await getResponseRate(db, userId, { now: NOW })).toEqual({ total: 6, responded: 3, rate: 0.5 });
    expect(await getFunnel(db, userId, { now: NOW })).toEqual({ total: 6, responded: 3, offer: 1, accepted: 1 });
  });

  it("wishlist-only applications are left out of the base and counted separately", async () => {
    const stats = await getStats(db, userId, { now: NOW });
    expect(stats.notAppliedYet).toBe(2);
    expect(stats.totalApplications).toBe(8);
    expect(stats.responseRate).toEqual({ total: 6, responded: 3, rate: 0.5 });
  });

  it("per source: applied applications and their response rate", async () => {
    expect(await getSourceStats(db, userId, { now: NOW })).toEqual([
      { source: "Indeed", count: 2, responded: 2, rate: 1 },
      { source: "Referral", count: 2, responded: 1, rate: 0.5 },
      { source: "LinkedIn", count: 1, responded: 0, rate: 0 },
      { source: "Unknown", count: 1, responded: 0, rate: 0 },
    ]);
  });

  it("applications per week: applied only, by applied date else the first non-wishlist transition", async () => {
    expect(await getWeeklyApplications(db, userId, { now: NOW })).toEqual(
      weeks("2026-03-16", { "2026-02-16": 1, "2026-03-02": 2, "2026-03-09": 2, "2026-03-16": 1 }),
    );
  });

  it("other users are isolated", async () => {
    const other = `rr-other-user-${counter}`;
    expect(await getFunnel(db, other, { now: NOW })).toEqual({ total: 1, responded: 1, offer: 1, accepted: 0 });
    expect((await getStats(db, other, { now: NOW })).notAppliedYet).toBe(0);
  });

  it("positions are read at query time: moving Screen before Applied undoes w7's response", async () => {
    await db.update(stage).set({ position: 1 }).where(eq(stage.id, ids.get("Screen")!));
    await db.update(stage).set({ position: 3 }).where(eq(stage.id, ids.get("Saved")!));
    expect(await getResponseRate(db, userId, { now: NOW })).toEqual({ total: 6, responded: 2, rate: 2 / 6 });
    // Restore for any later reader.
    await db.update(stage).set({ position: 3 }).where(eq(stage.id, ids.get("Screen")!));
    await db.update(stage).set({ position: 1 }).where(eq(stage.id, ids.get("Saved")!));
  });
});

describe("a user with only wishlist applications", () => {
  it("has a 0-application base, no rate, and the wishlist count", async () => {
    const userId = await newUser("only");
    await seed(userId, STAGES, [APPS[1]]);
    const stats = await getStats(db, userId, { now: NOW });
    expect(stats.responseRate).toEqual({ total: 0, responded: 0, rate: null });
    expect(stats.notAppliedYet).toBe(1);
    expect(stats.totalApplications).toBe(1);
    expect(stats.sources).toEqual([]);
    expect(stats.weekly.every((w) => w.count === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Applied-date autofill (S13 as amended by S21) and follow-ups with wishlist stages.

async function stageNamed(userId: string, name: string) {
  const found = (await listStages(db, userId)).find((s) => s.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

/** A default user plus "Wishlist" and "Saved" (category wishlist) moved before Applied. */
async function userWithWishlist() {
  const userId = await newUser("auto");
  for (const name of ["Saved", "Wishlist"]) {
    const created = await createStage(db, userId, { name, category: "wishlist" });
    if (!created.ok) throw new Error("stage");
    for (let i = 0; i < 7; i += 1) await moveStage(db, userId, created.stage.id, "up");
  }
  expect((await listStages(db, userId)).map((s) => s.name).slice(0, 3)).toEqual(["Wishlist", "Saved", "Applied"]);
  return userId;
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

async function openFollowUps(userId: string, applicationId: string) {
  return ((await listApplicationReminders(db, userId, applicationId)) ?? []).filter((r) => r.kind === "follow_up" && !r.doneAt);
}

async function snapshot() {
  return JSON.stringify([
    await db.select().from(application).orderBy(application.id),
    await db.select().from(stageTransition).orderBy(stageTransition.id),
    await db.select().from(reminder).orderBy(reminder.id),
    await db.select().from(userSettings).orderBy(userSettings.userId),
  ]);
}

describe("applied date and follow-ups with wishlist stages", () => {
  it("creating or moving within wishlist stages fills no date and creates no follow-up", async () => {
    const userId = await userWithWishlist();
    const wishlist = await stageNamed(userId, "Wishlist");
    const saved = await stageNamed(userId, "Saved");
    const app = await newApplication(userId, { stageId: wishlist.id });
    expect(app.appliedAt).toBeNull();
    expect(await openFollowUps(userId, app.id)).toEqual([]);

    expect(await moveApplication(db, userId, app.id, { stageId: saved.id, index: 0 })).toEqual({ ok: true });
    expect((await getApplication(db, userId, app.id))?.appliedAt).toBeNull();
    expect(await openFollowUps(userId, app.id)).toEqual([]);
  });

  it("reaching the first non-wishlist stage fills the date and starts a follow-up", async () => {
    const userId = await userWithWishlist();
    const app = await newApplication(userId, { stageId: (await stageNamed(userId, "Wishlist")).id });
    const applied = await stageNamed(userId, "Applied");
    expect(await moveApplication(db, userId, app.id, { stageId: applied.id, index: 0 })).toEqual({ ok: true });
    const t = await latestTransition(userId, app.id);
    expect((await getApplication(db, userId, app.id))?.appliedAt).toBe(localDateIn(t.at, "UTC"));
    expect((await openFollowUps(userId, app.id)).map((r) => r.transitionId)).toEqual([t.id]);

    // Back to a wishlist stage: the follow-up closes, none starts, the date stays.
    const saved = await stageNamed(userId, "Saved");
    expect(await moveApplication(db, userId, app.id, { stageId: saved.id, index: 0 })).toEqual({ ok: true });
    expect(await openFollowUps(userId, app.id)).toEqual([]);
    expect((await getApplication(db, userId, app.id))?.appliedAt).toBe(localDateIn(t.at, "UTC"));
  });

  it("created directly in Applied (the first non-wishlist stage) gets today's date", async () => {
    const userId = await userWithWishlist();
    const app = await newApplication(userId, { stageId: (await stageNamed(userId, "Applied")).id });
    const t = await latestTransition(userId, app.id);
    expect(app.appliedAt).toBe(localDateIn(t.at, "UTC"));
  });

  it("an edit-form stage change out of the wishlist fills it; a typed date is never overwritten", async () => {
    const userId = await userWithWishlist();
    const app = await newApplication(userId, { stageId: (await stageNamed(userId, "Wishlist")).id });
    const kept = await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II" });
    expect(kept).toMatchObject({ ok: true, application: { appliedAt: null } });
    const toSaved = await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II", stageId: (await stageNamed(userId, "Saved")).id });
    expect(toSaved).toMatchObject({ ok: true, application: { appliedAt: null } });
    const moved = await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II", stageId: (await stageNamed(userId, "Screening")).id });
    const t = await latestTransition(userId, app.id);
    expect(moved).toMatchObject({ ok: true, application: { appliedAt: localDateIn(t.at, "UTC") } });

    const typed = await newApplication(userId, { stageId: (await stageNamed(userId, "Wishlist")).id, appliedAt: "2024-05-01" });
    expect(await moveApplication(db, userId, typed.id, { stageId: (await stageNamed(userId, "Applied")).id, index: 0 })).toEqual({ ok: true });
    expect((await getApplication(db, userId, typed.id))?.appliedAt).toBe("2024-05-01");
  });

  it("refused moves and edits change nothing (T7.1)", async () => {
    const userId = await userWithWishlist();
    const app = await newApplication(userId, { stageId: (await stageNamed(userId, "Wishlist")).id });
    const applied = await stageNamed(userId, "Applied");
    const stranger = await newUser("stranger");
    const before = await snapshot();
    expect(await moveApplication(db, stranger, app.id, { stageId: applied.id, index: 0 })).toEqual({ ok: false, reason: "not_found" });
    expect(await updateApplication(db, stranger, app.id, { companyName: "Acme", role: "X", stageId: applied.id })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await moveApplication(db, userId, app.id, { stageId: "no-such-stage", index: 0 })).toEqual({ ok: false, reason: "invalid" });
    expect(await snapshot()).toBe(before);
  });
});

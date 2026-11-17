import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { application, company, stage, stageTransition, user } from "@/db/schema";
import type { StageCategory } from "@/lib/validation/stage";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const {
  getStats,
  getStageTotals,
  getResponseRate,
  getFunnel,
  getAverageTimeInStage,
  getWeeklyApplications,
  getSourceStats,
} = await import("./stats");
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

// Every expectation below is computed by hand from the seeded rows (no copy of the SQL under test).

/** Wednesday; Los Angeles is on daylight time (UTC-7), Kiritimati is UTC+14. */
const NOW = new Date("2026-03-18T12:00:00Z");

type StageSeed = { name: string; category: StageCategory; archived?: boolean };
type AppSeed = {
  source?: string | null;
  appliedAt?: string | null;
  createdAt: string;
  archived?: boolean;
  /** Stage names in order; the first is where the application was created (from null). */
  path: [string, string][];
};

async function newUser(prefix = "stats") {
  counter += 1;
  const id = `${prefix}-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `${prefix}${counter}@example.com` });
  return id;
}

async function seedStages(userId: string, stages: StageSeed[]) {
  const ids = new Map<string, string>();
  for (const [position, s] of stages.entries()) {
    const id = `${userId}-stage-${position}`;
    await db.insert(stage).values({
      id,
      userId,
      name: s.name,
      category: s.category,
      position,
      archived: s.archived ?? false,
    });
    ids.set(s.name, id);
  }
  return ids;
}

/** Inserts an application in the last stage of its path and one transition per step, at the given times. */
async function seedApplication(userId: string, stages: Map<string, string>, seed: AppSeed, index: number) {
  const companyId = `${userId}-company-${index}`;
  await db.insert(company).values({ id: companyId, userId, name: `Company ${index}` });
  const id = `${userId}-app-${index}`;
  const stageId = (name: string) => {
    const found = stages.get(name);
    if (!found) throw new Error(`no stage ${name}`);
    return found;
  };
  const [lastName] = seed.path[seed.path.length - 1];
  await db.insert(application).values({
    id,
    userId,
    companyId,
    stageId: stageId(lastName),
    role: "Engineer",
    source: seed.source ?? null,
    appliedAt: seed.appliedAt ?? null,
    archived: seed.archived ?? false,
    position: "a0",
    createdAt: new Date(seed.createdAt),
  });
  let from: string | null = null;
  for (const [step, [name, at]] of seed.path.entries()) {
    await db.insert(stageTransition).values({
      id: `${id}-t${step}`,
      userId,
      applicationId: id,
      fromStageId: from,
      toStageId: stageId(name),
      at: new Date(at),
    });
    from = stageId(name);
  }
  return id;
}

const SCENARIO_STAGES: StageSeed[] = [
  // Position 0 but archived: the user's first stage is "Sent" (lowest non-archived position).
  { name: "Old inbox", category: "active", archived: true },
  { name: "Sent", category: "active" },
  { name: "Phone call", category: "active" },
  { name: "Tech round", category: "active" },
  { name: "Got offer", category: "offer" },
  { name: "Declined by them", category: "rejected" },
  { name: "Signed", category: "accepted" },
  { name: "Dropped", category: "withdrawn" },
];

const SCENARIO_APPS: AppSeed[] = [
  // a1: all the way to accepted through an offer; open in Signed since 03-08 10:00 (10 d 2 h until NOW).
  {
    source: "LinkedIn",
    appliedAt: "2026-03-02",
    createdAt: "2026-03-01T10:00:00Z",
    path: [
      ["Sent", "2026-03-01T10:00:00Z"],
      ["Phone call", "2026-03-03T10:00:00Z"],
      ["Tech round", "2026-03-05T10:00:00Z"],
      ["Got offer", "2026-03-06T10:00:00Z"],
      ["Signed", "2026-03-08T10:00:00Z"],
    ],
  },
  // a2: blank source, no applied date; created Sunday 03-15 12:00 UTC = Monday 03-16 02:00 in Kiritimati.
  {
    source: "  ",
    createdAt: "2026-03-15T12:00:00Z",
    path: [
      ["Sent", "2026-03-15T12:00:00Z"],
      ["Declined by them", "2026-03-17T12:00:00Z"],
    ],
  },
  // a3: no source, no applied date; Monday 03-09 05:00 UTC = Sunday 03-08 22:00 in Los Angeles. Never left Sent.
  {
    source: null,
    createdAt: "2026-03-09T05:00:00Z",
    path: [["Sent", "2026-03-09T05:00:00Z"]],
  },
  // a4 (archived): created directly in a later stage, then moved back to the first one.
  {
    source: "Referral",
    appliedAt: "2026-02-20",
    createdAt: "2026-03-01T00:00:00Z",
    archived: true,
    path: [
      ["Phone call", "2026-03-01T00:00:00Z"],
      ["Sent", "2026-03-02T00:00:00Z"],
    ],
  },
  // a5: created in the archived "Old inbox", reached an offer, moved back to Tech round; applied long ago.
  {
    source: "Referral",
    appliedAt: "2025-11-03",
    createdAt: "2026-03-10T00:00:00Z",
    path: [
      ["Old inbox", "2026-03-10T00:00:00Z"],
      ["Sent", "2026-03-11T00:00:00Z"],
      ["Got offer", "2026-03-12T00:00:00Z"],
      ["Tech round", "2026-03-14T00:00:00Z"],
    ],
  },
  // a6 (archived): accepted without an offer stage; 6 h in Sent.
  {
    source: "LinkedIn",
    appliedAt: "2026-03-18",
    createdAt: "2026-03-18T00:00:00Z",
    archived: true,
    path: [
      ["Sent", "2026-03-18T00:00:00Z"],
      ["Signed", "2026-03-18T06:00:00Z"],
    ],
  },
];

async function seedScenario(prefix = "stats") {
  const userId = await newUser(prefix);
  const stages = await seedStages(userId, SCENARIO_STAGES);
  for (const [index, seed] of SCENARIO_APPS.entries()) await seedApplication(userId, stages, seed, index + 1);
  return { userId, stages };
}

/** 12 Mondays ending with `last`, oldest first. */
function mondaysEndingWith(last: string): string[] {
  const end = new Date(`${last}T00:00:00Z`);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - 7 * (11 - i));
    return d.toISOString().slice(0, 10);
  });
}

function weeks(last: string, counts: Record<string, number>) {
  return mondaysEndingWith(last).map((weekStart) => ({ weekStart, count: counts[weekStart] ?? 0 }));
}

describe("statistics on a seeded scenario", () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    ({ userId } = await seedScenario());
    // Another user with the same stage names and many applications in later stages: never counted for userId.
    otherUserId = await newUser("other");
    const otherStages = await seedStages(otherUserId, [
      { name: "Sent", category: "active" },
      { name: "Got offer", category: "offer" },
      { name: "Signed", category: "accepted" },
    ]);
    for (let i = 1; i <= 3; i += 1) {
      await seedApplication(
        otherUserId,
        otherStages,
        {
          source: "LinkedIn",
          appliedAt: "2026-03-17",
          createdAt: "2026-03-16T00:00:00Z",
          path: [
            ["Sent", "2026-03-16T00:00:00Z"],
            ["Got offer", "2026-03-16T01:00:00Z"],
            ["Signed", "2026-03-16T02:00:00Z"],
          ],
        },
        i,
      );
    }
  });

  it("counts current non-archived applications per non-archived stage, in stage order", async () => {
    const totals = await getStageTotals(db, userId);
    expect(totals.map(({ name, category, count }) => ({ name, category, count }))).toEqual([
      { name: "Sent", category: "active", count: 1 },
      { name: "Phone call", category: "active", count: 0 },
      { name: "Tech round", category: "active", count: 1 },
      { name: "Got offer", category: "offer", count: 0 },
      { name: "Declined by them", category: "rejected", count: 1 },
      { name: "Signed", category: "accepted", count: 1 },
      { name: "Dropped", category: "withdrawn", count: 0 },
    ]);
  });

  it("response rate: share of applications that ever reached a stage after the first non-archived one", async () => {
    // a1, a2, a4 (created in a later stage), a5 (Old inbox is before the first stage, Got offer after), a6.
    expect(await getResponseRate(db, userId, { now: NOW })).toEqual({ total: 6, responded: 5, rate: 5 / 6 });
    expect(await getResponseRate(db, userId, { now: NOW, includeArchived: false })).toEqual({
      total: 4,
      responded: 3,
      rate: 0.75,
    });
  });

  it("funnel by category: every step is 'ever reached', so accepted can exceed offer", async () => {
    expect(await getFunnel(db, userId, { now: NOW })).toEqual({ total: 6, responded: 5, offer: 2, accepted: 2 });
    expect(await getFunnel(db, userId, { now: NOW, includeArchived: false })).toEqual({
      total: 4,
      responded: 3,
      offer: 2,
      accepted: 1,
    });
  });

  it("average time in stage: consecutive transitions, current stage until now, archived open stays excluded", async () => {
    const rows = await getAverageTimeInStage(db, userId, { now: NOW });
    expect(rows.map(({ name, averageDays, samples }) => ({ name, averageDays, samples }))).toEqual([
      { name: "Old inbox", averageDays: 1, samples: 1 },
      // 2 (a1) + 2 (a2) + 9 d 7 h (a3, open) + 1 (a5) + 0.25 (a6) = 14.5417 / 5
      { name: "Sent", averageDays: 2.9, samples: 5 },
      { name: "Phone call", averageDays: 1.5, samples: 2 },
      // (1 + 4.5) / 2 = 2.75, rounded half up
      { name: "Tech round", averageDays: 2.8, samples: 2 },
      { name: "Got offer", averageDays: 2, samples: 2 },
      { name: "Declined by them", averageDays: 1, samples: 1 },
      // 10 d 2 h, still open
      { name: "Signed", averageDays: 10.1, samples: 1 },
    ]);
    expect(rows.find((r) => r.name === "Old inbox")?.archived).toBe(true);

    const active = await getAverageTimeInStage(db, userId, { now: NOW, includeArchived: false });
    expect(active.map(({ name, averageDays, samples }) => ({ name, averageDays, samples }))).toEqual([
      { name: "Old inbox", averageDays: 1, samples: 1 },
      // (2 + 2 + 9.2917 + 1) / 4 = 3.5729
      { name: "Sent", averageDays: 3.6, samples: 4 },
      { name: "Phone call", averageDays: 2, samples: 1 },
      { name: "Tech round", averageDays: 2.8, samples: 2 },
      { name: "Got offer", averageDays: 2, samples: 2 },
      { name: "Declined by them", averageDays: 1, samples: 1 },
      { name: "Signed", averageDays: 10.1, samples: 1 },
    ]);
  });

  it("applications per week in UTC when no zone is stored: applied date, else created date, zero-filled", async () => {
    expect(await getWeeklyApplications(db, userId, { now: NOW })).toEqual(
      weeks("2026-03-16", { "2026-02-16": 1, "2026-03-02": 1, "2026-03-09": 2, "2026-03-16": 1 }),
    );
    expect(await getWeeklyApplications(db, userId, { now: NOW, includeArchived: false })).toEqual(
      weeks("2026-03-16", { "2026-03-02": 1, "2026-03-09": 2 }),
    );
  });

  it("per source: count and response rate, empty source grouped as Unknown", async () => {
    expect(await getSourceStats(db, userId, { now: NOW })).toEqual([
      { source: "LinkedIn", count: 2, responded: 2, rate: 1 },
      { source: "Referral", count: 2, responded: 2, rate: 1 },
      { source: "Unknown", count: 2, responded: 1, rate: 0.5 },
    ]);
    expect(await getSourceStats(db, userId, { now: NOW, includeArchived: false })).toEqual([
      { source: "Unknown", count: 2, responded: 1, rate: 0.5 },
      { source: "LinkedIn", count: 1, responded: 1, rate: 1 },
      { source: "Referral", count: 1, responded: 1, rate: 1 },
    ]);
  });

  it("getStats bundles every metric and defaults to including archived applications", async () => {
    const stats = await getStats(db, userId, { now: NOW });
    expect(stats.includeArchived).toBe(true);
    expect(stats.timeZone).toBe("UTC");
    expect(stats.totalApplications).toBe(6);
    expect(stats.responseRate).toEqual(await getResponseRate(db, userId, { now: NOW }));
    expect(stats.funnel).toEqual(await getFunnel(db, userId, { now: NOW }));
    expect(stats.stageTotals).toEqual(await getStageTotals(db, userId));
    expect(stats.averageTimeInStage).toEqual(await getAverageTimeInStage(db, userId, { now: NOW }));
    expect(stats.weekly).toEqual(await getWeeklyApplications(db, userId, { now: NOW }));
    expect(stats.sources).toEqual(await getSourceStats(db, userId, { now: NOW }));

    const excluded = await getStats(db, userId, { now: NOW, includeArchived: false });
    expect(excluded.includeArchived).toBe(false);
    expect(excluded.totalApplications).toBe(4);
    // Totals per stage never include archived applications, whatever the option.
    expect(excluded.stageTotals).toEqual(stats.stageTotals);
  });

  it("never counts another user's data, and the other user sees only their own", async () => {
    expect(await getFunnel(db, otherUserId, { now: NOW })).toEqual({ total: 3, responded: 3, offer: 3, accepted: 3 });
    expect((await getStageTotals(db, otherUserId)).map((t) => t.count)).toEqual([0, 0, 3]);
    expect(await getSourceStats(db, otherUserId, { now: NOW })).toEqual([
      { source: "LinkedIn", count: 3, responded: 3, rate: 1 },
    ]);
    expect(await getWeeklyApplications(db, otherUserId, { now: NOW })).toEqual(weeks("2026-03-16", { "2026-03-16": 3 }));
    const avg = await getAverageTimeInStage(db, otherUserId, { now: NOW });
    expect(avg.map((r) => [r.name, r.samples])).toEqual([
      ["Sent", 3],
      ["Got offer", 3],
      ["Signed", 3],
    ]);
  });
});

describe("applications per week in the user's time zone", () => {
  it("buckets by local Monday weeks: Kiritimati moves a Sunday-UTC creation into the next week", async () => {
    const { userId } = await seedScenario("kiri");
    expect((await setTimeZone(db, userId, { timeZone: "Pacific/Kiritimati" })).ok).toBe(true);
    expect(await getWeeklyApplications(db, userId, { now: NOW })).toEqual(
      weeks("2026-03-16", { "2026-02-16": 1, "2026-03-02": 1, "2026-03-09": 1, "2026-03-16": 2 }),
    );
    expect((await getStats(db, userId, { now: NOW })).timeZone).toBe("Pacific/Kiritimati");
  });

  it("Los Angeles moves a Monday-UTC creation back into the previous week", async () => {
    const { userId } = await seedScenario("la");
    expect((await setTimeZone(db, userId, { timeZone: "America/Los_Angeles" })).ok).toBe(true);
    expect(await getWeeklyApplications(db, userId, { now: NOW })).toEqual(
      weeks("2026-03-16", { "2026-02-16": 1, "2026-03-02": 2, "2026-03-09": 1, "2026-03-16": 1 }),
    );
  });

  it("the current week, and so the 12-week window, is the one of the user's local today", async () => {
    // Sunday 20:00 UTC is already Monday 10:00 in Kiritimati.
    const sundayEvening = new Date("2026-03-15T20:00:00Z");
    const utcUser = await newUser("window");
    const kiriUser = await newUser("window");
    for (const userId of [utcUser, kiriUser]) {
      const stages = await seedStages(userId, [{ name: "Sent", category: "active" }]);
      // First day of the UTC window (before the Kiritimati one), and the day before it.
      await seedApplication(userId, stages, { appliedAt: "2025-12-22", createdAt: "2026-03-15T19:00:00Z", path: [["Sent", "2026-03-15T19:00:00Z"]] }, 1);
      await seedApplication(userId, stages, { appliedAt: "2025-12-21", createdAt: "2026-03-15T19:00:00Z", path: [["Sent", "2026-03-15T19:00:00Z"]] }, 2);
      await seedApplication(userId, stages, { createdAt: "2026-03-15T19:00:00Z", path: [["Sent", "2026-03-15T19:00:00Z"]] }, 3);
    }
    expect((await setTimeZone(db, kiriUser, { timeZone: "Pacific/Kiritimati" })).ok).toBe(true);

    // UTC: window 2025-12-22 … 2026-03-09; 12-21 falls before it, the Sunday creation in the last week.
    expect(await getWeeklyApplications(db, utcUser, { now: sundayEvening })).toEqual(
      weeks("2026-03-09", { "2025-12-22": 1, "2026-03-09": 1 }),
    );
    // Kiritimati: window 2025-12-29 … 2026-03-16; the creation (Monday 09:00 local) is in the current week.
    expect(await getWeeklyApplications(db, kiriUser, { now: sundayEvening })).toEqual(weeks("2026-03-16", { "2026-03-16": 1 }));
  });

  it("counts the first week of the window and nothing before it", async () => {
    const userId = await newUser("edge");
    const stages = await seedStages(userId, [{ name: "Sent", category: "active" }]);
    await seedApplication(userId, stages, { appliedAt: "2025-12-29", createdAt: "2026-03-01T00:00:00Z", path: [["Sent", "2026-03-01T00:00:00Z"]] }, 1);
    await seedApplication(userId, stages, { appliedAt: "2026-01-04", createdAt: "2026-03-01T00:00:00Z", path: [["Sent", "2026-03-01T00:00:00Z"]] }, 2);
    await seedApplication(userId, stages, { appliedAt: "2025-12-28", createdAt: "2026-03-01T00:00:00Z", path: [["Sent", "2026-03-01T00:00:00Z"]] }, 3);
    // A future applied date is outside the window too.
    await seedApplication(userId, stages, { appliedAt: "2026-03-23", createdAt: "2026-03-01T00:00:00Z", path: [["Sent", "2026-03-01T00:00:00Z"]] }, 4);
    const result = await getWeeklyApplications(db, userId, { now: NOW });
    expect(result[0]).toEqual({ weekStart: "2025-12-29", count: 2 });
    expect(result.reduce((sum, w) => sum + w.count, 0)).toBe(2);
  });
});

describe("response rate edge cases", () => {
  it("uses the stage order at query time: reordering stages changes which applications responded", async () => {
    const userId = await newUser("reorder");
    const stages = await seedStages(userId, [
      { name: "X", category: "active" },
      { name: "Y", category: "active" },
    ]);
    await seedApplication(userId, stages, { source: "A", createdAt: "2026-03-01T00:00:00Z", path: [["X", "2026-03-01T00:00:00Z"]] }, 1);
    await seedApplication(userId, stages, { source: "B", createdAt: "2026-03-01T00:00:00Z", path: [["Y", "2026-03-01T00:00:00Z"]] }, 2);
    expect(await getResponseRate(db, userId, { now: NOW })).toEqual({ total: 2, responded: 1, rate: 0.5 });
    expect(await getSourceStats(db, userId, { now: NOW })).toEqual([
      { source: "A", count: 1, responded: 0, rate: 0 },
      { source: "B", count: 1, responded: 1, rate: 1 },
    ]);

    // Y becomes the first stage: the application only ever in Y no longer responded, the one in X now did.
    await db.update(stage).set({ position: 5 }).where(sqlStage(stages.get("X")!));
    expect(await getResponseRate(db, userId, { now: NOW })).toEqual({ total: 2, responded: 1, rate: 0.5 });
    expect(await getSourceStats(db, userId, { now: NOW })).toEqual([
      { source: "A", count: 1, responded: 1, rate: 1 },
      { source: "B", count: 1, responded: 0, rate: 0 },
    ]);
    expect((await getStageTotals(db, userId)).map((t) => t.name)).toEqual(["Y", "X"]);
  });

  it("an archived first stage hands 'first' to the next non-archived stage", async () => {
    const userId = await newUser("archfirst");
    const stages = await seedStages(userId, [
      { name: "Applied", category: "active" },
      { name: "Screen", category: "active" },
      { name: "Talks", category: "active" },
    ]);
    // Moved Applied → Screen: responded while Applied is the first stage.
    await seedApplication(
      userId,
      stages,
      { createdAt: "2026-03-01T00:00:00Z", path: [["Applied", "2026-03-01T00:00:00Z"], ["Screen", "2026-03-02T00:00:00Z"]] },
      1,
    );
    expect((await getResponseRate(db, userId, { now: NOW })).responded).toBe(1);
    // Archiving Applied makes Screen the first stage: reaching Screen is no longer a response.
    await db.update(stage).set({ archived: true }).where(sqlStage(stages.get("Applied")!));
    expect(await getResponseRate(db, userId, { now: NOW })).toEqual({ total: 1, responded: 0, rate: 0 });
  });
});

describe("a user with no applications", () => {
  it("returns zeros, empty lists, 12 empty weeks and no rate", async () => {
    const userId = await newUser("empty");
    await seedStages(userId, [
      { name: "Sent", category: "active" },
      { name: "Offer", category: "offer" },
    ]);
    const stats = await getStats(db, userId, { now: NOW });
    expect(stats.totalApplications).toBe(0);
    expect(stats.stageTotals.map((t) => [t.name, t.count])).toEqual([
      ["Sent", 0],
      ["Offer", 0],
    ]);
    expect(stats.responseRate).toEqual({ total: 0, responded: 0, rate: null });
    expect(stats.funnel).toEqual({ total: 0, responded: 0, offer: 0, accepted: 0 });
    expect(stats.averageTimeInStage).toEqual([]);
    expect(stats.weekly).toEqual(weeks("2026-03-16", {}));
    expect(stats.sources).toEqual([]);
  });

  it("works for a user with no stages at all", async () => {
    const userId = await newUser("nostages");
    const stats = await getStats(db, userId, { now: NOW });
    expect(stats.stageTotals).toEqual([]);
    expect(stats.totalApplications).toBe(0);
    expect(stats.weekly).toHaveLength(12);
  });
});

function sqlStage(id: string) {
  return eq(stage.id, id);
}

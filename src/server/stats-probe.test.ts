import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { application, company, stage, stageTransition, user } from "@/db/schema";
import type { StageCategory } from "@/lib/validation/stage";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const { getStats } = await import("./stats");
const { setTimeZone } = await import("./settings");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

// Expectations computed by hand by the T9 verifier (S5 definitions in L32); response rate and funnel
// updated for S21 (applied stage = first non-wishlist stage; a response is a later-positioned stage
// that is not withdrawn or wishlist), with the reason next to each changed number.
const NOW = new Date("2026-03-16T07:30:00Z"); // Mon 00:30 in LA (PDT), Mon 21:30 in Kiritimati
const STAGES: [string, StageCategory, number, boolean][] = [
  ["Inbox", "active", 0, true], // archived first stage
  ["Applied", "active", 1, false],
  ["Interview", "active", 2, false], // reordered before Screen
  ["Screen", "active", 3, false],
  ["Offer", "offer", 4, false],
  ["Rejected", "rejected", 5, false],
  ["Accepted", "accepted", 6, false],
  ["Withdrawn", "withdrawn", 7, false],
];
type Seed = { source: string | null; appliedAt: string | null; createdAt: string; archived?: boolean; path: [string, string][] };
const P_APPS: Seed[] = [
  {
    source: "LinkedIn",
    appliedAt: "2026-03-02",
    createdAt: "2026-03-01T00:00:00Z",
    path: [
      ["Applied", "2026-03-01T00:00:00Z"],
      ["Screen", "2026-03-03T00:00:00Z"],
      ["Applied", "2026-03-04T00:00:00Z"],
    ],
  },
  { source: " linkedin ", appliedAt: null, createdAt: "2026-03-16T06:59:00Z", path: [["Interview", "2026-03-16T06:59:00Z"]] },
  {
    source: "Referral",
    appliedAt: "2025-12-22",
    createdAt: "2025-12-22T12:00:00Z",
    path: [
      ["Applied", "2025-12-22T12:00:00Z"],
      ["Accepted", "2026-01-05T12:00:00Z"],
    ],
  },
  {
    source: "Referral",
    appliedAt: "2025-12-21",
    createdAt: "2025-12-21T12:00:00Z",
    archived: true,
    path: [
      ["Applied", "2025-12-21T12:00:00Z"],
      ["Offer", "2025-12-31T12:00:00Z"],
    ],
  },
  { source: null, appliedAt: null, createdAt: "2026-03-15T10:00:00Z", path: [["Applied", "2026-03-15T10:00:00Z"]] },
  {
    source: "",
    appliedAt: null,
    createdAt: "2026-03-15T09:59:00Z",
    path: [
      ["Applied", "2026-03-15T09:59:00Z"],
      ["Rejected", "2026-03-15T21:59:00Z"],
    ],
  },
  {
    source: "Referral ",
    appliedAt: "2026-02-02",
    createdAt: "2026-02-02T00:00:00Z",
    path: [
      ["Inbox", "2026-02-02T00:00:00Z"],
      ["Applied", "2026-02-04T00:00:00Z"],
      ["Screen", "2026-02-05T00:00:00Z"],
    ],
  },
];

async function seedUser(id: string, positions: (p: number) => number, apps: Seed[]) {
  await db.insert(user).values({ id, name: id, email: `${id}@example.com` });
  const ids = new Map<string, string>();
  for (const [name, category, position, archived] of STAGES) {
    const stageId = `stage-${id}-${position}`;
    await db.insert(stage).values({ id: stageId, userId: id, name, category, position: positions(position), archived });
    ids.set(name, stageId);
  }
  for (const [i, a] of apps.entries()) {
    const appId = `app-${i}-${id}`;
    await db.insert(company).values({ id: `co-${i}-${id}`, userId: id, name: `Acme ${i}` });
    await db.insert(application).values({
      id: appId,
      userId: id,
      companyId: `co-${i}-${id}`,
      stageId: ids.get(a.path[a.path.length - 1][0])!,
      role: "Engineer",
      source: a.source,
      appliedAt: a.appliedAt,
      archived: a.archived ?? false,
      position: "a0",
      createdAt: new Date(a.createdAt),
    });
    let from: string | null = null;
    for (const [step, [name, at]] of a.path.entries()) {
      await db.insert(stageTransition).values({
        id: `t-${step}-${appId}`,
        userId: id,
        applicationId: appId,
        fromStageId: from,
        toStageId: ids.get(name)!,
        at: new Date(at),
      });
      from = ids.get(name)!;
    }
  }
}

const weeks = (counts: Record<string, number>, first: string) =>
  Array.from({ length: 12 }, (_, i) => {
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7 * i);
    const key = d.toISOString().slice(0, 10);
    return { weekStart: key, count: counts[key] ?? 0 };
  });

describe("stats computed by hand (verifier probe)", () => {
  let before: unknown;
  beforeAll(async () => {
    await seedUser("p", (x) => x, P_APPS);
    expect((await setTimeZone(db, "p", { timeZone: "America/Los_Angeles" })).ok).toBe(true);
    before = await getStats(db, "p", { now: NOW });
    // Second user: same names, same id patterns, interleaved times, everything accepted, Kiritimati.
    await seedUser(
      "q",
      (x) => (x === 0 ? 9 : x),
      P_APPS.map((a) => ({
        ...a,
        archived: false,
        path: [...a.path, ["Offer", "2026-03-16T07:00:00Z"], ["Accepted", "2026-03-16T07:10:00Z"]] as [string, string][],
      })),
    );
    expect((await setTimeZone(db, "q", { timeZone: "Pacific/Kiritimati" })).ok).toBe(true);
  });

  it("isolation: p unchanged after q is seeded", async () => {
    expect(await getStats(db, "p", { now: NOW })).toEqual(before);
    const q = await getStats(db, "q", { now: NOW });
    // S21: q's "Referral " app was applied in the archived Inbox, positioned last (9) for q, so no
    // stage is after its applied stage: 6 responses, not 7.
    expect(q.funnel).toEqual({ total: 7, responded: 6, offer: 7, accepted: 7 });
    expect(q.timeZone).toBe("Pacific/Kiritimati");
  });

  it("include archived (default)", async () => {
    const s = await getStats(db, "p", { now: NOW });
    expect(s.stageTotals.map((t) => [t.name, t.count])).toEqual([
      ["Applied", 2],
      ["Interview", 1],
      ["Screen", 1],
      ["Offer", 0],
      ["Rejected", 1],
      ["Accepted", 1],
      ["Withdrawn", 0],
    ]);
    // S21: " linkedin " was created directly in Interview (its applied stage) and never moved on: no response.
    expect(s.funnel).toEqual({ total: 7, responded: 5, offer: 1, accepted: 1 });
    expect(s.responseRate).toEqual({ total: 7, responded: 5, rate: 5 / 7 });
    expect(s.averageTimeInStage.map((d) => [d.name, d.averageDays, d.samples, d.archived])).toEqual([
      ["Inbox", 2, 1, true],
      ["Applied", 5.8, 7, false],
      ["Interview", 0, 1, false],
      ["Screen", 20.2, 2, false],
      ["Rejected", 0.4, 1, false],
      ["Accepted", 69.8, 1, false],
    ]);
    expect(s.sources.map((x) => [x.source, x.count, x.responded])).toEqual([
      ["Referral", 3, 3],
      ["Unknown", 2, 1],
      ["LinkedIn", 1, 1],
      ["linkedin", 1, 0], // S21: created in Interview, no later stage
    ]);
    expect(s.weekly).toEqual(weeks({ "2026-02-02": 1, "2026-03-02": 1, "2026-03-09": 3 }, "2025-12-29"));
  });

  it("exclude archived", async () => {
    const s = await getStats(db, "p", { now: NOW, includeArchived: false });
    expect(s.funnel).toEqual({ total: 6, responded: 4, offer: 0, accepted: 1 }); // S21: " linkedin " as above
    expect(s.averageTimeInStage.find((d) => d.name === "Applied")).toMatchObject({ averageDays: 5.1, samples: 6 });
    expect(s.sources.map((x) => [x.source, x.count])).toEqual([
      ["Referral", 2],
      ["Unknown", 2],
      ["LinkedIn", 1],
      ["linkedin", 1],
    ]);
    expect(s.stageTotals.find((t) => t.name === "Offer")!.count).toBe(0);
  });

  it("Kiritimati week boundary around Monday 00:00", async () => {
    expect((await setTimeZone(db, "p", { timeZone: "Pacific/Kiritimati" })).ok).toBe(true);
    const s = await getStats(db, "p", { now: NOW });
    expect(s.weekly).toEqual(weeks({ "2026-02-02": 1, "2026-03-02": 1, "2026-03-09": 1, "2026-03-16": 2 }, "2025-12-29"));
  });

  it("LA: when it is still Sunday locally, the window ends on the previous week", async () => {
    expect((await setTimeZone(db, "p", { timeZone: "America/Los_Angeles" })).ok).toBe(true);
    const s = await getStats(db, "p", { now: new Date("2026-03-16T06:59:59Z") });
    expect(s.weekly).toEqual(weeks({ "2025-12-22": 1, "2026-02-02": 1, "2026-03-02": 1, "2026-03-09": 3 }, "2025-12-22"));
  });
});

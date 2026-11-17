import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { application, reminder, stage, user } from "@/db/schema";
import type { StageCategory } from "@/lib/validation/stage";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const { getStats } = await import("./stats");
const { createApplication, updateApplication } = await import("./applications");
const { moveApplication } = await import("./board");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

const today = () => new Date().toISOString().slice(0, 10); // no zone stored → UTC
const STAGES: [string, StageCategory][] = [
  ["Wish", "wishlist"],
  ["Wish2", "wishlist"],
  ["Applied", "active"],
  ["Screening", "active"],
  ["Interview", "active"],
  ["Offer", "offer"],
  ["Rejected", "rejected"],
  ["Accepted", "accepted"],
  ["Withdrawn", "withdrawn"],
];

async function setup(id: string) {
  await db.insert(user).values({ id, name: id, email: `${id}@example.com` });
  const ids = new Map<string, string>();
  for (const [position, [name, category]] of STAGES.entries()) {
    await db.insert(stage).values({ id: `${id}-${name}`, userId: id, name, category, position });
    ids.set(name, `${id}-${name}`);
  }
  return ids;
}

async function create(userId: string, stageId: string, extra: Record<string, string> = {}) {
  const result = await createApplication(db, userId, { companyName: "Acme", role: "Dev", stageId, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.application;
}

const move = (userId: string, appId: string, stageId: string) => moveApplication(db, userId, appId, { stageId, index: 0 });
const openFollowUps = async (appId: string) =>
  (
    await db
      .select()
      .from(reminder)
      .where(and(eq(reminder.applicationId, appId), eq(reminder.kind, "follow_up"), isNull(reminder.doneAt)))
  ).length;
const appliedAtOf = async (appId: string) => (await db.select().from(application).where(eq(application.id, appId)))[0].appliedAt;

describe("T9.1 verifier: S21 + S13/S4 through the real write paths", () => {
  it("counts, autofill and follow-ups per S21; other users never leak in", async () => {
    const s = await setup("vp");
    const a = await create("vp", s.get("Wish")!, { source: "LinkedIn" });
    expect(a.appliedAt).toBeNull();
    expect(await openFollowUps(a.id)).toBe(0);
    expect(await move("vp", a.id, s.get("Wish2")!)).toEqual({ ok: true });
    expect(await appliedAtOf(a.id)).toBeNull();
    expect(await openFollowUps(a.id)).toBe(0);
    expect(await move("vp", a.id, s.get("Applied")!)).toEqual({ ok: true });
    expect(await appliedAtOf(a.id)).toBe(today());
    expect(await openFollowUps(a.id)).toBe(1);

    const b = await create("vp", s.get("Applied")!, { source: " linkedin " });
    expect(b.appliedAt).toBe(today());
    expect(b.source).toBe("LinkedIn");
    await move("vp", b.id, s.get("Rejected")!);

    const c = await create("vp", s.get("Applied")!, { source: "referido" });
    expect(c.source).toBe("Referido");
    await move("vp", c.id, s.get("Withdrawn")!);

    await create("vp", s.get("Interview")!, { source: "Referido" });

    const e = await create("vp", s.get("Applied")!);
    await move("vp", e.id, s.get("Screening")!);
    await move("vp", e.id, s.get("Applied")!);

    const g = await create("vp", s.get("Applied")!, { source: "My  Board" });
    expect(g.source).toBe("My Board");
    await move("vp", g.id, s.get("Offer")!);
    await move("vp", g.id, s.get("Accepted")!);

    const f = await create("vp", s.get("Wish")!, { appliedAt: "2020-01-06" });
    await create("vp", s.get("Wish2")!);
    const before = await getStats(db, "vp");

    const q = await setup("vq");
    const qa = await create("vq", q.get("Wish")!, { source: "LINKEDIN" });
    expect(qa.source).toBe("LinkedIn");
    await move("vq", qa.id, q.get("Applied")!);
    await move("vq", qa.id, q.get("Offer")!);

    const st = await getStats(db, "vp");
    expect(st).toEqual(before);
    expect(st.responseRate).toEqual({ total: 6, responded: 3, rate: 0.5 });
    expect(st.funnel).toEqual({ total: 6, responded: 3, offer: 1, accepted: 1 });
    expect(st.notAppliedYet).toBe(2);
    expect(st.totalApplications).toBe(8);
    expect(st.weekly.reduce((n, w) => n + w.count, 0)).toBe(6);
    expect(st.sources.map((x) => [x.source, x.count, x.responded])).toEqual([
      ["LinkedIn", 2, 1],
      ["Referido", 2, 0],
      ["My Board", 1, 1],
      ["Unknown", 1, 1],
    ]);
    expect(await appliedAtOf(f.id)).toBe("2020-01-06");
  });

  it("the only row with a source can change its own case", async () => {
    await setup("ve");
    const applied = (await db.select().from(stage).where(eq(stage.userId, "ve"))).find((x) => x.name === "Applied")!.id;
    const a = await create("ve", applied, { source: "foo", appliedAt: "2024-01-02" });
    expect(await updateApplication(db, "ve", a.id, { companyName: "Acme", role: "Dev", source: "FOO" })).toMatchObject({
      ok: true,
      application: { source: "FOO" },
    });
  });
});

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
function migrationsUpTo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vp-mig-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag.startsWith(prefix)) + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("T9.1 verifier: migration 0010 (S20)", () => {
  it("per-user canonical forms; byte-order tie without preset; most frequent beats preset; nulls", async () => {
    const client = new PGlite();
    const d = drizzle({ client });
    const dirs = [migrationsUpTo("0008"), migrationsUpTo("0010")];
    try {
      await migrate(d, { migrationsFolder: dirs[0] });
      const rows: [string, string, string | null][] = [
        ["x1", "ux", "Get  on board"],
        ["x2", "ux", "get on Board"],
        ["y1", "uy", "linkedin"],
        ["y2", "uy", "linkedin"],
        ["y3", "uy", "LinkedIn"],
        ["z1", "uz", "Indeed"],
        ["z2", "uz", null],
        ["z3", "uz", "   "],
      ];
      const users = ["ux", "uy", "uz"];
      await client.exec(`
        insert into "user" (id,name,email) values ${users.map((u) => `('${u}','${u}','${u}@e.com')`).join(",")};
        insert into company (id,user_id,name) values ${users.map((u) => `('c-${u}','${u}','A')`).join(",")};
        insert into stage (id,user_id,name,category,position) values ${users.map((u) => `('s-${u}','${u}','Applied','active',0)`).join(",")};`);
      for (const [i, [id, u, src]] of rows.entries()) {
        await client.query(
          `insert into application (id,user_id,company_id,stage_id,role,source,position) values ($1,$2,$3,$4,'R',$5,$6)`,
          [id, u, `c-${u}`, `s-${u}`, src, `a${i}`],
        );
      }
      await migrate(d, { migrationsFolder: dirs[1] });
      const after = Object.fromEntries(
        (await client.query<{ id: string; source: string | null }>(`select id, source from application`)).rows.map((r) => [
          r.id,
          r.source,
        ]),
      );
      expect(after).toEqual({
        x1: "Get on board",
        x2: "Get on board",
        y1: "linkedin",
        y2: "linkedin",
        y3: "linkedin",
        z1: "Indeed",
        z2: null,
        z3: null,
      });
    } finally {
      await client.close();
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });
});

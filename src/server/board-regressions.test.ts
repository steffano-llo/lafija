import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { generateKeyBetween } from "fractional-indexing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { application, company, stage, stageTransition, user } from "@/db/schema";
import { compareKeys, keyForIndex } from "./ordering";

vi.mock("server-only", () => ({}));
const { listStages, setStageArchived } = await import("./stages");
const { createApplication, updateApplication, setApplicationArchived } = await import("./applications");
const { listBoard, listStageTransitions, moveApplication } = await import("./board");

const folder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const tempDirs: string[] = [];

/** Copy of the migrations folder whose journal stops at the migration tagged `prefix`. */
function upTo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), "board-mig-"));
  tempDirs.push(dir);
  cpSync(folder, dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
  const end = journal.entries.findIndex((entry: { tag: string }) => entry.tag.startsWith(prefix));
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migration 0003 on a populated database", () => {
  it("orders keys by created_at per stage, logs one created transition each and uses collation C", async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: upTo("0001") });
    await client.exec(`insert into "user"(id,name,email) values ('u1','1','1@x'),('u2','2','2@x');
      insert into company(id,user_id,name) values ('c1','u1','A'),('c2','u2','B');`);
    await migrate(db, { migrationsFolder: upTo("0002") });
    const stageId = async (userId: string, name: string) =>
      (await client.query<{ id: string }>(`select id from stage where user_id=$1 and name=$2`, [userId, name])).rows[0].id;
    const u1Applied = await stageId("u1", "Applied");
    const u1Interview = await stageId("u1", "Interview");
    const u2Offer = await stageId("u2", "Offer");
    await client.query(`update stage set archived=true where id=$1`, [u2Offer]);
    const rows: string[] = [];
    for (let i = 0; i < 130; i++) {
      const at = new Date(Date.UTC(2024, 0, 1) + Math.floor((130 - i) / 2) * 1000).toISOString();
      rows.push(`('x${String(i).padStart(3, "0")}','u1','c1','${u1Applied}','R',${i % 7 === 0},'${at}')`);
    }
    rows.push(`('i1','u1','c1','${u1Interview}','R',false,'2024-05-01Z')`, `('i0','u1','c1','${u1Interview}','R',false,'2024-04-01Z')`);
    rows.push(`('o1','u2','c2','${u2Offer}','R',true,'2024-05-01Z')`);
    await client.exec(`insert into application(id,user_id,company_id,stage_id,role,archived,created_at) values ${rows.join(",")};`);
    await migrate(db, { migrationsFolder: folder });

    const collation = await client.query<{ collation_name: string }>(
      `select collation_name from information_schema.columns where table_name='application' and column_name='position'`,
    );
    expect(collation.rows[0].collation_name).toBe("C");
    for (const id of [u1Applied, u1Interview, u2Offer]) {
      const byKey = (
        await client.query<{ id: string; position: string }>(`select id, position from application where stage_id=$1 order by position`, [id])
      ).rows;
      const byCreated = (await client.query<{ id: string }>(`select id from application where stage_id=$1 order by created_at, id`, [id])).rows;
      expect(byKey.map((row) => row.id)).toEqual(byCreated.map((row) => row.id));
      const keys = byKey.map((row) => row.position);
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys].sort(compareKeys)).toEqual(keys);
      for (let i = 0; i + 1 < keys.length; i++) expect(() => generateKeyBetween(keys[i], keys[i + 1])).not.toThrow();
      expect(() => generateKeyBetween(null, keys[0])).not.toThrow();
      expect(() => generateKeyBetween(keys.at(-1)!, null)).not.toThrow();
    }
    const transitions = await client.query<{ n: number; bad: number }>(`select count(*)::int n,
      count(*) filter (where t.from_stage_id is not null or t.to_stage_id<>a.stage_id or t.at<>a.created_at or t.user_id<>a.user_id)::int bad
      from stage_transition t join application a on a.id=t.application_id`);
    expect(transitions.rows[0]).toEqual({ n: 133, bad: 0 });
    expect((await client.query(`select application_id from stage_transition group by 1 having count(*)<>1`)).rows).toEqual([]);
    await client.close();
  });
});

describe("board moves", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: folder });
    await db.insert(user).values([
      { id: "a", name: "a", email: "a@x" },
      { id: "b", name: "b", email: "b@x" },
    ]);
  });
  afterAll(() => client.close());

  const snapshot = async () =>
    JSON.stringify([
      await db.select().from(stage).orderBy(stage.id),
      await db.select().from(application).orderBy(application.id),
      await db.select().from(company).orderBy(company.id),
      await db.select().from(stageTransition).orderBy(stageTransition.id),
    ]);
  const named = async (userId: string, name: string) => (await listStages(db as never, userId)).find((s) => s.name === name)!;
  const make = async (userId: string, role: string, stageId?: string) => {
    const result = await createApplication(db as never, userId, { companyName: "Acme", role, stageId });
    if (!result.ok) throw new Error("create failed");
    return result.application;
  };
  const roles = async (userId: string, name: string) =>
    (await listBoard(db as never, userId)).columns.find((column) => column.name === name)!.cards.map((card) => card.role);

  it("refuses hostile moves with every table byte-identical", async () => {
    const x = await make("a", "X");
    const bApp = await make("b", "B");
    const bScreening = await named("b", "Screening");
    const aOffer = await named("a", "Offer");
    await setStageArchived(db as never, "a", aOffer.id, true);
    const before = await snapshot();
    const hostile: [string, unknown, unknown][] = [
      [bApp.id, x.stageId, 0],
      [x.id, bScreening.id, 0],
      [x.id, aOffer.id, 0],
      [x.id, x.stageId, -1],
      [x.id, x.stageId, 1_000_001],
      [x.id, x.stageId, "0"],
      [x.id, x.stageId, Infinity],
      [x.id, null, 0],
      [x.id, "' or 1=1 --", 0],
      [x.id, "s".repeat(101), 0],
      ["", x.stageId, 0],
    ];
    for (const [id, stageId, index] of hostile) {
      const result = await moveApplication(db as never, "a", id, { stageId, index });
      expect(result.ok, JSON.stringify([id, stageId, index])).toBe(false);
    }
    expect(await snapshot()).toBe(before);
  });

  it("moves to top, middle and bottom across columns and logs exactly the stage changes", async () => {
    const applied = await named("a", "Applied");
    const screening = await named("a", "Screening");
    const s1 = await make("a", "S1", screening.id);
    const s2 = await make("a", "S2", screening.id);
    const s3 = await make("a", "S3", screening.id);
    const m = await make("a", "M", applied.id);

    expect(await moveApplication(db as never, "a", m.id, { stageId: screening.id, index: 1 })).toEqual({ ok: true });
    expect(await roles("a", "Screening")).toEqual(["S1", "M", "S2", "S3"]);
    expect(await moveApplication(db as never, "a", m.id, { stageId: screening.id, index: 0 })).toEqual({ ok: true });
    expect(await roles("a", "Screening")).toEqual(["M", "S1", "S2", "S3"]);
    expect(await moveApplication(db as never, "a", m.id, { stageId: screening.id, index: 1_000_000 })).toEqual({ ok: true });
    expect(await roles("a", "Screening")).toEqual(["S1", "S2", "S3", "M"]);
    expect(await moveApplication(db as never, "a", m.id, { stageId: applied.id, index: 0 })).toEqual({ ok: true });
    const log = (await listStageTransitions(db as never, "a")).filter((t) => t.applicationId === m.id);
    expect(log.map((t) => [t.fromStageId, t.toStageId])).toEqual([
      [null, applied.id],
      [applied.id, screening.id],
      [screening.id, applied.id],
    ]);

    await setApplicationArchived(db as never, "a", s2.id, true);
    expect(await moveApplication(db as never, "a", s3.id, { stageId: screening.id, index: 1 })).toEqual({ ok: true });
    expect(await roles("a", "Screening")).toEqual(["S1", "S3"]);
    const updated = await updateApplication(db as never, "a", s1.id, { companyName: "Acme", role: "S1", stageId: applied.id });
    expect(updated.ok).toBe(true);
    const s1Log = (await listStageTransitions(db as never, "a")).filter((t) => t.applicationId === s1.id);
    expect(s1Log.map((t) => t.fromStageId)).toEqual([null, screening.id]);
  });

  it("finds a key between neighbours even with duplicate keys", () => {
    const key = keyForIndex(["a0", "a1", "a1", "a2"], 2);
    expect(compareKeys(key, "a1") > 0 && compareKeys(key, "a2") < 0).toBe(true);
    expect(() => keyForIndex(["a1", "a1"], 1)).not.toThrow();
  });
});

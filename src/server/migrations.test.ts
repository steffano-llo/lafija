import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { compareKeys } from "./ordering";

// Regression tests for the hand-written backfills in migrations 0002 and 0003, run the way
// `drizzle-kit migrate` runs them: every pending migration inside one transaction.

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const scratch: string[] = [];
const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Journal = { entries: { tag: string }[] };

function readJournal(dir: string): Journal {
  return JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;
}

/** A temp copy of the migrations folder whose journal stops at `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lafija-migrations-"));
  scratch.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journal = readJournal(dir);
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (end < 0) throw new Error(`unknown migration ${lastTag}`);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

const tags = readJournal(migrationsFolder).entries.map((entry) => entry.tag);
const tagStartingWith = (prefix: string) => {
  const tag = tags.find((t) => t.startsWith(prefix));
  if (!tag) throw new Error(`no migration ${prefix}`);
  return tag;
};

async function databaseAt(lastTag: string) {
  const client = new PGlite();
  clients.push(client);
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: migrationsUpTo(lastTag) });
  return { client, db };
}

/**
 * Users before stages existed: u1 has active and archived applications, u2 has companies named
 * like stages, u3 has no application at all.
 */
const PRE_STAGE_DATA = `
  insert into "user" (id, name, email) values
    ('u1', 'One', 'one@example.com'), ('u2', 'Two', 'two@example.com'), ('u3', 'Three', 'three@example.com');
  insert into company (id, user_id, name) values
    ('c1', 'u1', 'Acme'), ('c2', 'u2', 'Applied'), ('c3', 'u2', 'Offer');
  insert into application (id, user_id, company_id, role, archived, created_at) values
    ('a1', 'u1', 'c1', 'Frontend', false, '2024-01-03T00:00:00Z'),
    ('a2', 'u1', 'c1', 'Backend', true, '2024-01-01T00:00:00Z'),
    ('a3', 'u1', 'c1', 'Data', false, '2024-01-02T00:00:00Z'),
    ('a4', 'u2', 'c2', 'Ops', false, '2024-02-01T00:00:00Z'),
    ('a5', 'u2', 'c3', 'QA', true, '2024-02-02T00:00:00Z');
`;

describe("migration 0002 on a populated database", () => {
  it("seeds stages for every user and puts each application in its own user's Applied stage", async () => {
    const { client, db } = await databaseAt(tagStartingWith("0001"));
    await client.exec(PRE_STAGE_DATA);

    await migrate(db, { migrationsFolder: migrationsUpTo(tagStartingWith("0002")) });

    const counts = await client.query<{ user_id: string; n: number }>(
      `select user_id, count(*)::int as n from stage group by user_id order by user_id`,
    );
    expect(counts.rows).toEqual([
      { user_id: "u1", n: 6 },
      { user_id: "u2", n: 6 },
      { user_id: "u3", n: 6 },
    ]);
    const placed = await client.query<{ id: string; stage_user: string; stage_name: string; archived: boolean }>(
      `select a.id, s.user_id as stage_user, s.name as stage_name, a.archived
         from application a join stage s on s.id = a.stage_id order by a.id`,
    );
    expect(placed.rows).toEqual([
      { id: "a1", stage_user: "u1", stage_name: "Applied", archived: false },
      { id: "a2", stage_user: "u1", stage_name: "Applied", archived: true },
      { id: "a3", stage_user: "u1", stage_name: "Applied", archived: false },
      { id: "a4", stage_user: "u2", stage_name: "Applied", archived: false },
      { id: "a5", stage_user: "u2", stage_name: "Applied", archived: true },
    ]);
    // Companies are untouched, whatever their names.
    const companies = await client.query<{ id: string; name: string }>(`select id, name from company order by id`);
    expect(companies.rows.map((row) => row.name)).toEqual(["Acme", "Applied", "Offer"]);
  });
});

describe("migration 0003 (board) on a populated database", () => {
  it("backfills one created transition per application and ordering keys by created_at", async () => {
    const { client, db } = await databaseAt(tagStartingWith("0001"));
    await client.exec(PRE_STAGE_DATA);
    await migrate(db, { migrationsFolder: migrationsUpTo(tagStartingWith("0002")) });

    await migrate(db, { migrationsFolder });

    const transitions = await client.query<{
      application_id: string;
      user_id: string;
      from_stage_id: string | null;
      to_name: string;
      to_user: string;
      at: Date;
      created_at: Date;
    }>(
      `select t.application_id, t.user_id, t.from_stage_id, s.name as to_name, s.user_id as to_user, t.at, a.created_at
         from stage_transition t
         join stage s on s.id = t.to_stage_id
         join application a on a.id = t.application_id
        order by t.application_id`,
    );
    expect(transitions.rows.map((row) => [row.application_id, row.user_id, row.from_stage_id, row.to_name, row.to_user])).toEqual([
      ["a1", "u1", null, "Applied", "u1"],
      ["a2", "u1", null, "Applied", "u1"],
      ["a3", "u1", null, "Applied", "u1"],
      ["a4", "u2", null, "Applied", "u2"],
      ["a5", "u2", null, "Applied", "u2"],
    ]);
    for (const row of transitions.rows) expect(row.at).toEqual(row.created_at);

    const keys = await client.query<{ id: string; user_id: string; position: string }>(
      `select id, user_id, position from application order by user_id, position collate "C"`,
    );
    // Oldest first within each user's column, archived applications included.
    expect(keys.rows.map((row) => row.id)).toEqual(["a2", "a3", "a1", "a4", "a5"]);
    const u1 = keys.rows.filter((row) => row.user_id === "u1").map((row) => row.position);
    expect([...u1].sort(compareKeys)).toEqual(u1);
    expect(new Set(u1).size).toBe(3);

    // The new constraints hold: required key, transitions tied to their owner's application and stages.
    await expect(
      client.query(`insert into application (id, user_id, company_id, stage_id, role) select 'a9', 'u1', 'c1', stage_id, 'X' from application where id = 'a1'`),
    ).rejects.toThrow();
    const u2Stage = await client.query<{ id: string }>(`select id from stage where user_id = 'u2' limit 1`);
    await expect(
      client.query(
        `insert into stage_transition (id, user_id, application_id, to_stage_id) values ('t9', 'u1', 'a1', $1)`,
        [u2Stage.rows[0].id],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `insert into stage_transition (id, user_id, application_id, to_stage_id) values ('t9', 'u2', 'a1', $1)`,
        [u2Stage.rows[0].id],
      ),
    ).rejects.toThrow();
  });
});

describe("migrations are atomic", () => {
  it("a failing statement in 0003 leaves no partial schema or data, and the real migration then succeeds", async () => {
    const { client, db } = await databaseAt(tagStartingWith("0001"));
    await client.exec(PRE_STAGE_DATA);
    await migrate(db, { migrationsFolder: migrationsUpTo(tagStartingWith("0002")) });
    const applied = async () =>
      (await client.query<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0].n;
    const before = await applied();
    const dataBefore = JSON.stringify((await client.query(`select * from application order by id`)).rows);

    // Broken copy: the failure comes after the table, columns and backfills were created.
    const broken = migrationsUpTo(tagStartingWith("0003"));
    const file = join(broken, `${tagStartingWith("0003")}.sql`);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n--> statement-breakpoint\nSELECT 1 / 0;`);

    await expect(migrate(db, { migrationsFolder: broken })).rejects.toThrow();

    expect(await applied()).toBe(before);
    expect((await client.query<{ t: string | null }>(`select to_regclass('public.stage_transition')::text as t`)).rows).toEqual([
      { t: null },
    ]);
    const positionColumn = await client.query(
      `select 1 from information_schema.columns where table_name = 'application' and column_name = 'position'`,
    );
    expect(positionColumn.rows).toEqual([]);
    expect(JSON.stringify((await client.query(`select * from application order by id`)).rows)).toBe(dataBefore);

    await migrate(db, { migrationsFolder });

    expect(await applied()).toBe(tags.length);
    expect((await client.query<{ n: number }>(`select count(*)::int as n from stage_transition`)).rows).toEqual([{ n: 5 }]);
  });
});

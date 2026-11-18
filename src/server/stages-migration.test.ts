import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const scratch: string[] = [];
const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp copy of the migrations folder whose journal stops at `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lafija-migrations-"));
  scratch.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (end < 0) throw new Error(`unknown migration ${lastTag}`);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("stage migration on a database with existing data", () => {
  it("seeds default stages for every user and moves existing applications to Applied", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: migrationsUpTo("0001_companies_and_applications") });

    await client.exec(`
      insert into "user" (id, name, email) values
        ('u1', 'One', 'one@example.com'), ('u2', 'Two', 'two@example.com'), ('u3', 'Three', 'three@example.com');
      insert into company (id, user_id, name) values ('c1', 'u1', 'Acme'), ('c2', 'u2', 'Globex');
      insert into application (id, user_id, company_id, role, archived) values
        ('a1', 'u1', 'c1', 'Frontend', false), ('a2', 'u1', 'c1', 'Backend', true), ('a3', 'u2', 'c2', 'Data', false);
    `);

    await migrate(db, { migrationsFolder });

    const stages = await client.query<{ user_id: string; name: string; category: string; archived: boolean }>(
      `select user_id, name, category, archived from stage order by user_id, position`,
    );
    const expected = [
      ["Applied", "active"],
      ["Screening", "active"],
      ["Interview", "active"],
      ["Offer", "offer"],
      ["Rejected", "rejected"],
      ["Accepted", "accepted"],
    ];
    for (const userId of ["u1", "u2", "u3"]) {
      expect(
        stages.rows.filter((row) => row.user_id === userId).map((row) => [row.name, row.category, row.archived]),
      ).toEqual(expected.map(([name, category]) => [name, category, false]));
    }

    const applications = await client.query<{ id: string; user_id: string; stage_user: string; stage_name: string }>(
      `select a.id, a.user_id, s.user_id as stage_user, s.name as stage_name
         from application a join stage s on s.id = a.stage_id order by a.id`,
    );
    expect(applications.rows).toEqual([
      { id: "a1", user_id: "u1", stage_user: "u1", stage_name: "Applied" },
      { id: "a2", user_id: "u1", stage_user: "u1", stage_name: "Applied" },
      { id: "a3", user_id: "u2", stage_user: "u2", stage_name: "Applied" },
    ]);

    // The column is now required and must reference a stage of the same user.
    await expect(
      client.query(`insert into application (id, user_id, company_id, role) values ('a4', 'u1', 'c1', 'X')`),
    ).rejects.toThrow();
    const foreign = await client.query<{ id: string }>(`select id from stage where user_id = 'u2' limit 1`);
    await expect(client.query(`update application set stage_id = $1 where id = 'a1'`, [foreign.rows[0].id])).rejects.toThrow();
  });
});

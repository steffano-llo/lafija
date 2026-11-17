import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";

// Migrations 0009 (wishlist category) and 0010 (unify sources, S20) run the way `drizzle-kit migrate`
// runs them: pending migrations in one transaction, on a database populated through 0008.

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const scratch: string[] = [];
const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Journal = { entries: { tag: string }[] };

function migrationsUpTo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lafija-migrations-"));
  scratch.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  const last = journal.entries.findIndex((entry) => entry.tag.startsWith(prefix));
  if (last < 0) throw new Error(`no migration ${prefix}`);
  journal.entries = journal.entries.slice(0, last + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const without = (row: Record<string, unknown>, ...columns: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));

/** [application id, user, stored source] seeded before the migration. */
const SEEDED: [string, string, string | null][] = [
  // u1: LinkedIn spellings, most frequent " linkedin " → normalized "linkedin" (2) beats "LinkedIn" (1) and "LINKEDIN" (1).
  ["a01", "u1", "LinkedIn"],
  ["a02", "u1", " linkedin "],
  ["a03", "u1", "linkedin"],
  ["a04", "u1", "LINKEDIN"],
  // u1: non-preset tie 1-1 → alphabetical (collate "C": uppercase first).
  ["a05", "u1", "acme  jobs"],
  ["a06", "u1", "Acme Jobs"],
  // u1: null, empty and whitespace-only stay / become null.
  ["a07", "u1", null],
  ["a08", "u1", ""],
  ["a09", "u1", " \t "],
  // u2: every LinkedIn form ties → the preset spelling wins.
  ["b01", "u2", "LINKEDIN"],
  ["b02", "u2", "linkedin"],
  ["b03", "u2", "LinkedIn"],
  // u2: preset absent among tied forms → alphabetical.
  ["b04", "u2", "INDEED"],
  ["b05", "u2", "indeed"],
  // u3: one row each, untouched apart from whitespace.
  ["c01", "u3", "LINKEDIN"],
  ["c02", "u3", "Get  on   Board"],
];

const EXPECTED: Record<string, string | null> = {
  a01: "linkedin",
  a02: "linkedin",
  a03: "linkedin",
  a04: "linkedin",
  a05: "Acme Jobs",
  a06: "Acme Jobs",
  a07: null,
  a08: null,
  a09: null,
  b01: "LinkedIn",
  b02: "LinkedIn",
  b03: "LinkedIn",
  b04: "INDEED",
  b05: "INDEED",
  c01: "LINKEDIN",
  c02: "Get on Board",
};

describe("migrations 0009 and 0010 on a populated database", () => {
  it("unifies each user's sources to their most frequent form, per user, and adds the wishlist category", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: migrationsUpTo("0008") });
    const users = ["u1", "u2", "u3"];
    await client.exec(`
      insert into "user" (id, name, email) values ${users.map((u) => `('${u}', '${u}', '${u}@example.com')`).join(", ")};
      insert into company (id, user_id, name) values ${users.map((u) => `('co-${u}', '${u}', 'Acme')`).join(", ")};
      insert into stage (id, user_id, name, category, position) values ${users.map((u) => `('s-${u}', '${u}', 'Applied', 'active', 0)`).join(", ")};
    `);
    for (const [i, [id, userId, source]] of SEEDED.entries()) {
      await client.query(
        `insert into application (id, user_id, company_id, stage_id, role, source, position, updated_at)
         values ($1, $2, $3, $4, 'Engineer', $5, $6, '2026-01-01T00:00:00Z')`,
        [id, userId, `co-${userId}`, `s-${userId}`, source, `a${i}`],
      );
    }
    const before = (await client.query<Record<string, unknown>>(`select * from application order by id`)).rows;

    await migrate(db, { migrationsFolder: migrationsUpTo("0010") });

    const after = (await client.query<Record<string, unknown>>(`select * from application order by id`)).rows;
    expect(Object.fromEntries(after.map((a) => [a.id, a.source]))).toEqual(EXPECTED);
    // Every other column (updated_at included) is unchanged.
    expect(after.map((a) => without(a, "source"))).toEqual(before.map((a) => without(a, "source")));

    // The new category is usable, listed before `active`.
    const labels = (await client.query<{ v: string }>(`select unnest(enum_range(null::stage_category))::text as v`)).rows;
    expect(labels.map((r) => r.v)).toEqual(["wishlist", "active", "offer", "rejected", "accepted", "withdrawn"]);
    await expect(
      client.query(`insert into stage (id, user_id, name, category, position) values ('w', 'u1', 'Wishlist', 'wishlist', 1)`),
    ).resolves.toBeTruthy();
  });

  it("is a no-op on a database without applications", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: migrationsUpTo("0010") });
    expect((await client.query(`select count(*)::int as n from application`)).rows).toEqual([{ n: 0 }]);
  });
});

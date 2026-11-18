import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";

// Migration 0007 (email switch) on a database populated through 0006.

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const scratch: string[] = [];
const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function migrationsUpTo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lafija-migrations-"));
  scratch.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag.startsWith(prefix));
  if (last < 0) throw new Error(`no migration ${prefix}`);
  journal.entries = journal.entries.slice(0, last + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("migration 0007 (email reminders switch)", () => {
  it("turns email on for existing settings rows and changes nothing else", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: migrationsUpTo("0006") });
    await client.exec(`
      insert into "user" (id, name, email) values ('u1', 'One', 'one@example.com'), ('u2', 'Two', 'two@example.com');
      insert into user_settings (user_id, follow_up_days, time_zone, default_currency) values
        ('u1', 3, 'Asia/Tokyo', 'EUR'), ('u2', null, null, 'USD');
    `);
    const before = (await client.query<Record<string, unknown>>(`select * from user_settings order by user_id`)).rows;

    await migrate(db, { migrationsFolder: migrationsUpTo("0007") });

    const after = (await client.query<Record<string, unknown>>(`select * from user_settings order by user_id`)).rows;
    expect(after.map((row) => row.email_reminders)).toEqual([true, true]);
    const withoutSwitch = (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).filter(([column]) => column !== "email_reminders"));
    expect(after.map(withoutSwitch)).toEqual(before);
    await client.exec(`insert into "user" (id, name, email) values ('u3', 'Three', 'three@example.com')`);
    await client.exec(`insert into user_settings (user_id) values ('u3')`);
    const [inserted] = (
      await client.query<{ email_reminders: boolean }>(`select email_reminders from user_settings where user_id = 'u3'`)
    ).rows;
    expect(inserted.email_reminders).toBe(true);
    await expect(client.query(`update user_settings set email_reminders = null where user_id = 'u1'`)).rejects.toThrow();
  });
});

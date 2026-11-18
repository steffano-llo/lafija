import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";

// Migration 0008 (claim lease, verification cooldown) on a database populated through 0007.

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

describe("migration 0008 (claim lease)", () => {
  it("adds empty claim and cooldown columns and leaves every existing reminder and setting unchanged", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: migrationsUpTo("0007") });
    await client.exec(`
      insert into "user" (id, name, email, email_verified) values
        ('u1', 'One', 'one@example.com', true), ('u2', 'Two', 'two@example.com', false);
      insert into user_settings (user_id, follow_up_days, time_zone, default_currency, email_reminders) values
        ('u1', 3, 'Asia/Tokyo', 'EUR', false), ('u2', null, null, 'USD', true);
      insert into company (id, user_id, name) values ('c1', 'u1', 'Acme'), ('c2', 'u2', 'Globex');
      insert into stage (id, user_id, name, category, position) values
        ('s1', 'u1', 'Applied', 'active', 0), ('s2', 'u2', 'Applied', 'active', 0);
      insert into application (id, user_id, company_id, stage_id, role, position) values
        ('a1', 'u1', 'c1', 's1', 'Dev', 'a0'), ('a2', 'u2', 'c2', 's2', 'QA', 'a0');
      insert into reminder (id, user_id, application_id, kind, due_at, message, sent_at, done_at) values
        ('r1', 'u1', 'a1', 'manual', '2026-01-01T09:00:00Z', 'Sent one', '2026-01-01T09:15:00.123456Z', null),
        ('r2', 'u1', 'a1', 'manual', '2026-02-01T09:00:00Z', 'Unsent one', null, null),
        ('r3', 'u2', 'a2', 'manual', '2026-03-01T09:00:00Z', 'Done one', '2026-03-01T09:15:00Z', '2026-03-02T00:00:00Z');
    `);
    const reminders = `select * from reminder order by id`;
    const settings = `select * from user_settings order by user_id`;
    const beforeReminders = (await client.query<Record<string, unknown>>(reminders)).rows;
    const beforeSettings = (await client.query<Record<string, unknown>>(settings)).rows;

    await migrate(db, { migrationsFolder: migrationsUpTo("0008") });

    const afterReminders = (await client.query<Record<string, unknown>>(reminders)).rows;
    const afterSettings = (await client.query<Record<string, unknown>>(settings)).rows;
    const without = (column: string) => (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== column));
    expect(afterReminders.map((row) => row.email_claimed_at)).toEqual([null, null, null]);
    expect(afterReminders.map(without("email_claimed_at"))).toEqual(beforeReminders);
    expect(afterSettings.map((row) => row.verification_email_sent_at)).toEqual([null, null]);
    expect(afterSettings.map(without("verification_email_sent_at"))).toEqual(beforeSettings);
  });
});

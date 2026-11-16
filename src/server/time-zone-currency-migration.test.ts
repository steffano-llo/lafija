import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";

// Migration 0006 (time zone, currency, customized due times) run the way `drizzle-kit migrate`
// runs it: pending migrations in one transaction, on a database populated through 0005.

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const scratch: string[] = [];
const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The row without the named columns (the ones the migration adds). */
const without = (row: Record<string, unknown>, ...columns: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));

type Journal = { entries: { tag: string }[] };

const readJournal = (dir: string): Journal =>
  JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;

function migrationsUpTo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lafija-migrations-"));
  scratch.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journal = readJournal(dir);
  const last = journal.entries.findIndex((entry) => entry.tag.startsWith(prefix));
  if (last < 0) throw new Error(`no migration ${prefix}`);
  journal.entries = journal.entries.slice(0, last + 1);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

/**
 * u1 (no settings row = 7 days): a1 with salary, open follow-up due exactly 7 days after its
 * transition (r1); a2 without salary, open follow-up snoozed (r2); a3 with salary, done follow-up
 * with another due (r3) and a manual reminder (r4). u2 (follow_up_days 3): b1 with a salary, open
 * follow-up due 3 days after (r5) and one due 7 days after (r6, edited).
 * u3 turned follow-ups off (null): c1 open follow-up due 7 days after (r7).
 */
const POPULATED = `
  insert into "user" (id, name, email) values
    ('u1', 'One', 'one@example.com'), ('u2', 'Two', 'two@example.com'), ('u3', 'Three', 'three@example.com');
  insert into user_settings (user_id, follow_up_days) values ('u2', 3), ('u3', null);
  insert into company (id, user_id, name) values ('c1', 'u1', 'Acme'), ('c2', 'u2', 'Globex'), ('c3', 'u3', 'Initech');
  insert into stage (id, user_id, name, category, position) values
    ('s1', 'u1', 'Applied', 'active', 0), ('s2', 'u2', 'Applied', 'active', 0), ('s3', 'u3', 'Applied', 'active', 0);
  insert into application (id, user_id, company_id, stage_id, role, salary_range, position) values
    ('a1', 'u1', 'c1', 's1', 'Frontend', '50k-60k', 'a0'),
    ('a2', 'u1', 'c1', 's1', 'Backend', null, 'a1'),
    ('a3', 'u1', 'c1', 's1', 'Data', '$90k', 'a2'),
    ('b1', 'u2', 'c2', 's2', 'QA', '1M ARS', 'a0'),
    ('b2', 'u2', 'c2', 's2', 'SRE', null, 'a1'),
    ('c1', 'u3', 'c3', 's3', 'Ops', null, 'a0');
  insert into stage_transition (id, user_id, application_id, from_stage_id, to_stage_id, at) values
    ('t1', 'u1', 'a1', null, 's1', '2026-11-16T00:52:00Z'),
    ('t2', 'u1', 'a2', null, 's1', '2026-11-01T10:00:00Z'),
    ('t3', 'u1', 'a3', null, 's1', '2026-11-02T10:00:00Z'),
    ('t5', 'u2', 'b1', null, 's2', '2026-11-03T10:00:00Z'),
    ('t6', 'u2', 'b2', null, 's2', '2026-11-04T10:00:00Z'),
    ('t7', 'u3', 'c1', null, 's3', '2026-11-05T10:00:00Z');
  insert into reminder (id, user_id, application_id, kind, due_at, message, transition_id, done_at) values
    ('r1', 'u1', 'a1', 'follow_up', '2026-11-23T00:52:00Z', 'Follow up', 't1', null),
    ('r2', 'u1', 'a2', 'follow_up', '2026-11-20T08:00:00Z', 'Follow up', 't2', null),
    ('r3', 'u1', 'a3', 'follow_up', '2026-11-30T10:00:00Z', 'Follow up', 't3', '2026-11-03T00:00:00Z'),
    ('r4', 'u1', 'a3', 'manual', '2026-12-01T10:00:00Z', 'Call', null, null),
    ('r5', 'u2', 'b1', 'follow_up', '2026-11-06T10:00:00Z', 'Follow up', 't5', null),
    ('r6', 'u2', 'b2', 'follow_up', '2026-11-11T10:00:00Z', 'Follow up', 't6', null),
    ('r7', 'u3', 'c1', 'follow_up', '2026-11-12T10:00:00Z', 'Follow up', 't7', null);
`;

describe("migration 0006 on a populated database", () => {
  it("adds the columns, gives existing salaries USD and flags customized open follow-ups, nothing else", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: migrationsUpTo("0005") });
    await client.exec(POPULATED);
    const appsBefore = (await client.query<Record<string, unknown>>(`select * from application order by id`)).rows;
    const remindersBefore = (await client.query<Record<string, unknown>>(`select * from reminder order by id`)).rows;
    const settingsBefore = (await client.query<Record<string, unknown>>(`select * from user_settings order by user_id`)).rows;

    await migrate(db, { migrationsFolder });

    const apps = (await client.query<Record<string, unknown>>(`select * from application order by id`)).rows;
    expect(apps.map((a) => [a.id, a.salary_currency])).toEqual([
      ["a1", "USD"],
      ["a2", null],
      ["a3", "USD"],
      ["b1", "USD"],
      ["b2", null],
      ["c1", null],
    ]);
    // Every other column is unchanged.
    expect(apps.map((a) => without(a, "salary_currency"))).toEqual(appsBefore);

    const reminders = (await client.query<Record<string, unknown>>(`select * from reminder order by id`)).rows;
    expect(reminders.map((r) => [r.id, r.due_customized])).toEqual([
      ["r1", false], // exactly 7 days after its transition
      ["r2", true], // snoozed or edited
      ["r3", false], // done: not an open follow-up
      ["r4", false], // manual
      ["r5", false], // exactly the user's 3 days
      ["r6", true], // 7 days for a 3-day user: edited
      ["r7", false], // follow-ups off: compared with 7 days
    ]);
    expect(reminders.map((r) => without(r, "due_customized"))).toEqual(remindersBefore);

    const settings = (await client.query<Record<string, unknown>>(`select * from user_settings order by user_id`)).rows;
    expect(settings.map((s) => [s.user_id, s.time_zone, s.default_currency])).toEqual([
      ["u2", null, "USD"],
      ["u3", null, "USD"],
    ]);
    expect(settings.map((s) => without(s, "time_zone", "default_currency"))).toEqual(settingsBefore);

    // The new constraints hold.
    await expect(client.query(`update application set salary_currency = null where id = 'a1'`)).rejects.toThrow();
    await expect(client.query(`update application set salary_currency = 'EUR' where id = 'a2'`)).rejects.toThrow();
    await expect(client.query(`update application set salary_currency = 'eur' where id = 'a1'`)).rejects.toThrow();
    await expect(client.query(`update user_settings set default_currency = 'us' where user_id = 'u2'`)).rejects.toThrow();
    await expect(client.query(`insert into user_settings (user_id) values ('u1')`)).resolves.toBeTruthy();
    expect(
      (await client.query(`select time_zone, default_currency, follow_up_days from user_settings where user_id = 'u1'`)).rows,
    ).toEqual([{ time_zone: null, default_currency: "USD", follow_up_days: 7 }]);
  });
});

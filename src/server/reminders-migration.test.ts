import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";

// Regression tests for the follow-up backfill in migration 0005, run the way `drizzle-kit migrate`
// runs it: pending migrations inside one transaction, on a database that already holds data.

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const scratch: string[] = [];
const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Journal = { entries: { tag: string }[] };

const readJournal = (dir: string): Journal =>
  JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;

const tags = readJournal(migrationsFolder).entries.map((entry) => entry.tag);
const tagStartingWith = (prefix: string) => {
  const tag = tags.find((t) => t.startsWith(prefix));
  if (!tag) throw new Error(`no migration ${prefix}`);
  return tag;
};

/** A temp copy of the migrations folder whose journal stops at `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lafija-migrations-"));
  scratch.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journal = readJournal(dir);
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag === lastTag) + 1);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

/**
 * Two users with stages of every category. u1: a1 created in Applied then moved to Screening
 * (latest transition wins), a2 in Offer, a3 archived in Applied, a4 moved back from Offer to
 * Interview. u2: b1 in Applied, b2 in Rejected. u3 has nothing.
 */
const POPULATED = `
  insert into "user" (id, name, email) values
    ('u1', 'One', 'one@example.com'), ('u2', 'Two', 'two@example.com'), ('u3', 'Three', 'three@example.com');
  insert into company (id, user_id, name) values ('c1', 'u1', 'Acme'), ('c2', 'u2', 'Globex');
  insert into stage (id, user_id, name, category, position) values
    ('s1a', 'u1', 'Applied', 'active', 0), ('s1s', 'u1', 'Screening', 'active', 1),
    ('s1i', 'u1', 'Interview', 'active', 2), ('s1o', 'u1', 'Offer', 'offer', 3),
    ('s2a', 'u2', 'Applied', 'active', 0), ('s2r', 'u2', 'Rejected', 'rejected', 1);
  insert into application (id, user_id, company_id, stage_id, role, archived, position) values
    ('a1', 'u1', 'c1', 's1s', 'Frontend', false, 'a0'),
    ('a2', 'u1', 'c1', 's1o', 'Backend', false, 'a0'),
    ('a3', 'u1', 'c1', 's1a', 'Data', true, 'a0'),
    ('a4', 'u1', 'c1', 's1i', 'Ops', false, 'a0'),
    ('b1', 'u2', 'c2', 's2a', 'QA', false, 'a0'),
    ('b2', 'u2', 'c2', 's2r', 'SRE', false, 'a0');
  insert into stage_transition (id, user_id, application_id, from_stage_id, to_stage_id, at) values
    ('t1', 'u1', 'a1', null, 's1a', '2024-01-01T00:00:00Z'),
    ('t2', 'u1', 'a1', 's1a', 's1s', '2024-01-05T10:00:00Z'),
    ('t3', 'u1', 'a2', null, 's1o', '2024-01-02T00:00:00Z'),
    ('t4', 'u1', 'a3', null, 's1a', '2024-01-03T00:00:00Z'),
    ('t5', 'u1', 'a4', null, 's1o', '2024-01-04T00:00:00Z'),
    ('t6', 'u1', 'a4', 's1o', 's1i', '2024-02-01T08:30:00Z'),
    ('t7', 'u2', 'b1', null, 's2a', '2024-03-01T00:00:00Z'),
    ('t8', 'u2', 'b2', null, 's2a', '2024-03-02T00:00:00Z'),
    ('t9', 'u2', 'b2', 's2a', 's2r', '2024-03-03T00:00:00Z');
`;

describe("migration 0005 (reminders) on a populated database", () => {
  it("backfills one open follow-up per non-archived application in an active stage, from its latest transition", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: migrationsUpTo(tagStartingWith("0004")) });
    await client.exec(POPULATED);
    const before = JSON.stringify((await client.query(`select * from application order by id`)).rows);

    await migrate(db, { migrationsFolder });

    const rows = await client.query<{
      user_id: string;
      application_id: string;
      kind: string;
      due_at: Date;
      message: string;
      transition_id: string;
      sent_at: Date | null;
      done_at: Date | null;
    }>(
      `select user_id, application_id, kind, due_at, message, transition_id, sent_at, done_at
         from reminder order by application_id`,
    );
    expect(rows.rows).toEqual([
      {
        user_id: "u1",
        application_id: "a1",
        kind: "follow_up",
        due_at: new Date("2024-01-12T10:00:00Z"),
        message: "Follow up with Acme about Frontend",
        transition_id: "t2",
        sent_at: null,
        done_at: null,
      },
      {
        user_id: "u1",
        application_id: "a4",
        kind: "follow_up",
        due_at: new Date("2024-02-08T08:30:00Z"),
        message: "Follow up with Acme about Ops",
        transition_id: "t6",
        sent_at: null,
        done_at: null,
      },
      {
        user_id: "u2",
        application_id: "b1",
        kind: "follow_up",
        due_at: new Date("2024-03-08T00:00:00Z"),
        message: "Follow up with Globex about QA",
        transition_id: "t7",
        sent_at: null,
        done_at: null,
      },
    ]);
    // Existing rows are untouched and nobody gets a settings row (missing means the default).
    expect(JSON.stringify((await client.query(`select * from application order by id`)).rows)).toBe(before);
    expect((await client.query(`select * from user_settings`)).rows).toEqual([]);

    // The new constraints hold: one open follow-up per application, follow-ups tied to their owner's transition.
    await expect(
      client.query(
        `insert into reminder (id, user_id, application_id, kind, due_at, message, transition_id)
         values ('r9', 'u1', 'a1', 'follow_up', now(), 'x', 't1')`,
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `insert into reminder (id, user_id, application_id, kind, due_at, message, transition_id)
         values ('r9', 'u1', 'a2', 'follow_up', now(), 'x', 't7')`,
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `insert into reminder (id, user_id, application_id, kind, due_at, message) values ('r9', 'u1', 'b1', 'manual', now(), 'x')`,
      ),
    ).rejects.toThrow();
    await expect(
      client.query(`insert into user_settings (user_id, follow_up_days) values ('u3', 61)`),
    ).rejects.toThrow();
  });
});

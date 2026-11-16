import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";

vi.mock("server-only", () => ({}));

const { runAtomic } = await import("./atomic");
const { neon, neonConfig } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");

// A bare in-memory database (no migrations): the helper only needs a table of its own.
const client = new PGlite();
const db = drizzlePglite({ client, schema });

beforeAll(async () => {
  await db.execute(sql`create table "atomic_probe" ("n" int primary key)`);
}, 30_000);

afterAll(async () => {
  await client.close();
});

describe("runAtomic on PGlite (db.transaction)", () => {
  it("runs the statements in order and returns the rows of each", async () => {
    const results = await runAtomic(db, [
      sql`insert into "atomic_probe" ("n") values (1) returning "n"`,
      sql`select count(*)::int as "count" from "atomic_probe"`,
    ]);
    expect(results).toEqual([[{ n: 1 }], [{ count: 1 }]]);
  });

  it("rolls the first statement back when a later one fails", async () => {
    await expect(
      runAtomic(db, [sql`insert into "atomic_probe" ("n") values (2)`, sql`insert into "atomic_probe" ("n") values (1)`]),
    ).rejects.toThrow();
    const { rows } = await db.execute<{ n: number }>(sql`select "n" from "atomic_probe" order by "n"`);
    expect(rows).toEqual([{ n: 1 }]);
  });
});

describe("runAtomic on Neon HTTP (db.batch)", () => {
  const original = neonConfig.fetchFunction;

  afterEach(() => {
    neonConfig.fetchFunction = original;
  });

  it("sends every statement in one HTTP transaction request, in order, and maps each result", async () => {
    const requests: { body: unknown; headers: Record<string, string> }[] = [];
    neonConfig.fetchFunction = async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      requests.push({ body: JSON.parse(init.body), headers: init.headers });
      return new Response(
        JSON.stringify({
          results: [
            { fields: [{ name: "n", dataTypeID: 23 }], rows: [["1"]], command: "INSERT", rowCount: 1 },
            { fields: [{ name: "count", dataTypeID: 23 }], rows: [["1"]], command: "SELECT", rowCount: 1 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const neonDb = drizzle({ client: neon("postgresql://u:p@ep-test.example.neon.tech/db") });

    const results = await runAtomic(neonDb as never, [
      sql`insert into "atomic_probe" ("n") values (${1}) returning "n"`,
      sql`select count(*)::int as "count" from "atomic_probe"`,
    ]);

    expect(results).toEqual([[{ n: 1 }], [{ count: 1 }]]);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      queries: [
        { query: 'insert into "atomic_probe" ("n") values ($1) returning "n"', params: ["1"] },
        { query: 'select count(*)::int as "count" from "atomic_probe"', params: [] },
      ],
    });
  });
});

import "server-only";

import type { SQL } from "drizzle-orm";
import type { Db } from "./applications";
import { rowsOf } from "./board";

/** Drizzle's Neon HTTP database: `batch` sends its queries as one non-interactive transaction. */
type BatchDb = { batch(queries: readonly unknown[]): Promise<unknown[]> };

function canBatch(db: Db): db is Db & BatchDb {
  return typeof (db as Partial<BatchDb>).batch === "function";
}

/**
 * Runs the statements in order in one transaction and returns the rows of each. Same SQL on both
 * drivers: Neon HTTP (no interactive transactions) sends them in one `db.batch` request, which
 * `@neondatabase/serverless` runs as a single transaction; PGlite (tests) uses `db.transaction`.
 * Isolation is the server default, READ COMMITTED, so each statement reads a fresh snapshot: a
 * statement that follows a row lock sees everything committed before the lock was granted.
 * If any statement fails, none of them takes effect.
 */
export async function runAtomic(db: Db, statements: readonly [SQL, ...SQL[]]): Promise<unknown[][]> {
  if (canBatch(db)) {
    const results = await db.batch(statements.map((statement) => db.execute(statement)));
    return results.map((result) => rowsOf<unknown>(result));
  }
  return db.transaction(async (tx) => {
    const results: unknown[][] = [];
    for (const statement of statements) results.push(rowsOf<unknown>(await tx.execute(statement)));
    return results;
  });
}

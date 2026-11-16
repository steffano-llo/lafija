import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";

// Resolved from this file, so tests work from any working directory.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Fresh in-memory Postgres with every migration applied: isolated state per test file. */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

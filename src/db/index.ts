import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

function createDb() {
  return drizzle({ client: neon(getEnv().DATABASE_URL), schema });
}

export type Database = ReturnType<typeof createDb>;

let db: Database | undefined;

/** Lazily created Neon HTTP client; the connection string is validated on first use. */
export function getDb(): Database {
  db ??= createDb();
  return db;
}

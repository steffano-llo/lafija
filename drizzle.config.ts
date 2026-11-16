import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Same local file Next.js reads, so one place holds the connection string.
config({ path: ".env.local", quiet: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});

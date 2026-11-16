import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
// Relative import: drizzle-kit loads this file without the `@/` path alias.
import { STAGE_CATEGORIES } from "../lib/validation/stage";

// Better Auth core tables (better-auth 1.7). Model keys must stay
// `user`, `session`, `account` and `verification` for the Drizzle adapter.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// laFija domain tables. Every row belongs to one user and is deleted with that user.

export const company = pgTable(
  "company",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    website: text("website"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One company per name and user, ignoring case: "Acme" and "ACME" are the same company.
    uniqueIndex("company_user_id_name_idx").on(table.userId, sql`lower(${table.name})`),
    // Target of the composite foreign key below.
    unique("company_id_user_id_unique").on(table.id, table.userId),
  ],
);

export const stageCategory = pgEnum("stage_category", STAGE_CATEGORIES);

export const stage = pgTable(
  "stage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: stageCategory("category").notNull(),
    // Display order within the user's stages, ascending.
    position: integer("position").notNull(),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One stage per name and user, ignoring case.
    uniqueIndex("stage_user_id_name_idx").on(table.userId, sql`lower(${table.name})`),
    // Target of the composite foreign key from application.
    unique("stage_id_user_id_unique").on(table.id, table.userId),
  ],
);

export const application = pgTable(
  "application",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    companyId: text("company_id").notNull(),
    stageId: text("stage_id").notNull(),
    role: text("role").notNull(),
    url: text("url"),
    source: text("source"),
    salaryRange: text("salary_range"),
    appliedAt: date("applied_at", { mode: "string" }),
    archived: boolean("archived").notNull().default(false),
    // Board order within the stage: a fractional-indexing key compared with collate "C"
    // (the migration declares the column that way; queries also say it explicitly).
    position: text("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("application_user_id_idx").on(table.userId),
    // Target of the composite foreign key from stage_transition.
    unique("application_id_user_id_unique").on(table.id, table.userId),
    // The company must belong to the same user as the application.
    foreignKey({
      name: "application_company_id_user_id_fk",
      columns: [table.companyId, table.userId],
      foreignColumns: [company.id, company.userId],
    }),
    // The stage must belong to the same user; a used stage cannot be deleted.
    foreignKey({
      name: "application_stage_id_user_id_fk",
      columns: [table.stageId, table.userId],
      foreignColumns: [stage.id, stage.userId],
    }),
    index("application_stage_id_idx").on(table.stageId),
  ],
);

/**
 * Append-only history of stage changes: one row when an application is created (from null)
 * and one per change of stage. App code only inserts; statistics are computed from it.
 */
export const stageTransition = pgTable(
  "stage_transition",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    applicationId: text("application_id").notNull(),
    // Null for the transition recorded when the application was created.
    fromStageId: text("from_stage_id"),
    toStageId: text("to_stage_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every reference must belong to the same user as the transition.
    foreignKey({
      name: "stage_transition_application_id_user_id_fk",
      columns: [table.applicationId, table.userId],
      foreignColumns: [application.id, application.userId],
    }).onDelete("cascade"),
    // A stage in any history cannot be deleted, only archived.
    foreignKey({
      name: "stage_transition_from_stage_id_user_id_fk",
      columns: [table.fromStageId, table.userId],
      foreignColumns: [stage.id, stage.userId],
    }),
    foreignKey({
      name: "stage_transition_to_stage_id_user_id_fk",
      columns: [table.toStageId, table.userId],
      foreignColumns: [stage.id, stage.userId],
    }),
    // Per-user statistics over time, per-application history, and the stage "in use" checks.
    index("stage_transition_user_id_at_idx").on(table.userId, table.at),
    index("stage_transition_application_id_idx").on(table.applicationId, table.at),
    index("stage_transition_from_stage_id_idx").on(table.fromStageId),
    index("stage_transition_to_stage_id_idx").on(table.toStageId),
  ],
);

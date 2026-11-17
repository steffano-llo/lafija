import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
// Relative import: drizzle-kit loads this file without the `@/` path alias.
import { INTERVIEW_OUTCOMES, INTERVIEW_TYPES } from "../lib/validation/interview";
import { FOLLOW_UP_DAYS_DEFAULT, FOLLOW_UP_DAYS_MAX, FOLLOW_UP_DAYS_MIN, REMINDER_KINDS } from "../lib/validation/reminder";
import { DEFAULT_CURRENCY } from "../lib/validation/settings";
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
    // ISO 4217 code of the salary; set exactly when there is a salary.
    salaryCurrency: text("salary_currency"),
    appliedAt: date("applied_at", { mode: "string" }),
    // Free notes shown and edited on the detail page.
    notes: text("notes"),
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
    // Target of the composite foreign key from application_contact (same company and user).
    unique("application_id_company_id_user_id_unique").on(table.id, table.companyId, table.userId),
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
    check("application_salary_currency_check", sql`${table.salaryCurrency} is null or ${table.salaryCurrency} ~ '^[A-Z]{3}$'`),
    check(
      "application_salary_currency_required_check",
      sql`(${table.salaryRange} is null) = (${table.salaryCurrency} is null)`,
    ),
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
    // Target of the composite foreign key from reminder.
    unique("stage_transition_id_user_id_unique").on(table.id, table.userId),
  ],
);

export const interviewType = pgEnum("interview_type", INTERVIEW_TYPES);
export const interviewOutcome = pgEnum("interview_outcome", INTERVIEW_OUTCOMES);

/** An interview of one application; deleted with it. */
export const interview = pgTable(
  "interview",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    applicationId: text("application_id").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    type: interviewType("type").notNull(),
    notes: text("notes"),
    outcome: interviewOutcome("outcome").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The application must belong to the same user as the interview.
    foreignKey({
      name: "interview_application_id_user_id_fk",
      columns: [table.applicationId, table.userId],
      foreignColumns: [application.id, application.userId],
    }).onDelete("cascade"),
    index("interview_application_id_scheduled_at_idx").on(table.applicationId, table.scheduledAt),
    index("interview_user_id_idx").on(table.userId),
  ],
);

/** A person at a company; linked to any of that company's applications. Deleted with the company. */
export const contact = pgTable(
  "contact",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    role: text("role"),
    email: text("email"),
    linkedin: text("linkedin"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The company must belong to the same user as the contact.
    foreignKey({
      name: "contact_company_id_user_id_fk",
      columns: [table.companyId, table.userId],
      foreignColumns: [company.id, company.userId],
    }).onDelete("cascade"),
    // Target of the composite foreign key from application_contact (same company and user).
    unique("contact_id_company_id_user_id_unique").on(table.id, table.companyId, table.userId),
    index("contact_company_id_idx").on(table.companyId),
    index("contact_user_id_idx").on(table.userId),
  ],
);

/**
 * Which contacts are linked to which applications. Both foreign keys include `company_id` and
 * `user_id`, so the database itself only accepts a contact and an application of the same company
 * and user. Deleting either side removes the link.
 */
export const applicationContact = pgTable(
  "application_contact",
  {
    applicationId: text("application_id").notNull(),
    contactId: text("contact_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    companyId: text("company_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "application_contact_pk", columns: [table.applicationId, table.contactId] }),
    foreignKey({
      name: "application_contact_application_fk",
      columns: [table.applicationId, table.companyId, table.userId],
      foreignColumns: [application.id, application.companyId, application.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "application_contact_contact_fk",
      columns: [table.contactId, table.companyId, table.userId],
      foreignColumns: [contact.id, contact.companyId, contact.userId],
    }).onDelete("cascade"),
    index("application_contact_contact_id_idx").on(table.contactId),
  ],
);

export const reminderKind = pgEnum("reminder_kind", REMINDER_KINDS);

/**
 * A reminder about one application, deleted with it. `manual` ones are written by the user;
 * `follow_up` ones are created in the same transaction as a transition into an active-category
 * stage (one per transition, see `syncFollowUpSql`) and closed (`done_at`) by the next transition
 * or by archiving.
 * The email job (`src/server/reminder-emails.ts`) leases a reminder by setting `email_claimed_at`
 * (a lease expires after 30 minutes, so a crash mid-send never loses it), then sets `sent_at` and
 * clears the lease once the email is accepted, or only clears the lease if it fails.
 */
export const reminder = pgTable(
  "reminder",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    applicationId: text("application_id").notNull(),
    kind: reminderKind("kind").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    message: text("message").notNull(),
    // The transition a follow-up reminder was created for; null for manual reminders.
    transitionId: text("transition_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Lease of a running email job; cleared on success, failure, snooze or a new due time.
    emailClaimedAt: timestamp("email_claimed_at", { withTimezone: true }),
    // Set when the user edits the due time or snoozes: a time zone change then leaves it alone.
    dueCustomized: boolean("due_customized").notNull().default(false),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      name: "reminder_application_id_user_id_fk",
      columns: [table.applicationId, table.userId],
      foreignColumns: [application.id, application.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "reminder_transition_id_user_id_fk",
      columns: [table.transitionId, table.userId],
      foreignColumns: [stageTransition.id, stageTransition.userId],
    }).onDelete("cascade"),
    // Follow-ups always point at their transition; manual reminders never do.
    check("reminder_kind_transition_check", sql`(${table.kind} = 'follow_up') = (${table.transitionId} is not null)`),
    check("reminder_message_length_check", sql`char_length(${table.message}) between 1 and 500`),
    // One follow-up per transition, and at most one open follow-up per application.
    uniqueIndex("reminder_follow_up_transition_idx").on(table.transitionId).where(sql`${table.kind} = 'follow_up'`),
    uniqueIndex("reminder_open_follow_up_idx")
      .on(table.applicationId)
      .where(sql`${table.kind} = 'follow_up' and ${table.doneAt} is null`),
    // Due and not done, per user (in-app notifications and the reminders page).
    index("reminder_user_id_due_at_open_idx").on(table.userId, table.dueAt).where(sql`${table.doneAt} is null`),
    // Due and not yet sent (the email scheduler).
    index("reminder_due_at_unsent_idx").on(table.dueAt).where(sql`${table.sentAt} is null and ${table.doneAt} is null`),
    index("reminder_application_id_idx").on(table.applicationId),
    index("reminder_user_id_done_at_idx").on(table.userId, table.doneAt),
  ],
);

/** Per-user preferences; a missing row means the defaults. */
export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    // Days after a move into an active stage before the follow-up is due; null turns them off.
    followUpDays: integer("follow_up_days").default(FOLLOW_UP_DAYS_DEFAULT),
    // IANA zone detected from the browser or chosen in Settings; null = not detected yet (UTC).
    timeZone: text("time_zone"),
    // ISO 4217 code preselected for new salaries.
    defaultCurrency: text("default_currency").notNull().default(DEFAULT_CURRENCY),
    // Due reminders are emailed (digest) when on, the address is verified and allowed; in-app either way.
    emailReminders: boolean("email_reminders").notNull().default(true),
    // Last verification email sent to this user: on-demand resends wait 60 seconds after it.
    verificationEmailSentAt: timestamp("verification_email_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "user_settings_follow_up_days_check",
      sql`${table.followUpDays} is null or ${table.followUpDays} between ${sql.raw(String(FOLLOW_UP_DAYS_MIN))} and ${sql.raw(String(FOLLOW_UP_DAYS_MAX))}`,
    ),
    check("user_settings_default_currency_check", sql`${table.defaultCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

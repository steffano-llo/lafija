-- Time zone and default currency per user, salary currency per application, and a flag for
-- follow-ups whose due time the user changed. Hand-edited: existing salaries get USD (L24) before
-- the currency checks are added, and open follow-ups whose due time is not exactly the user's
-- follow-up days (7 when unset or off) after their transition are marked customized, so a later
-- time zone change leaves them alone. Every other row and column is unchanged.
ALTER TABLE "application" ADD COLUMN "salary_currency" text;--> statement-breakpoint
ALTER TABLE "reminder" ADD COLUMN "due_customized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
UPDATE "application" SET "salary_currency" = 'USD' WHERE "salary_range" IS NOT NULL;--> statement-breakpoint
UPDATE "reminder" r SET "due_customized" = true
FROM "stage_transition" st
WHERE st."id" = r."transition_id" AND st."user_id" = r."user_id"
  AND r."kind" = 'follow_up' AND r."done_at" IS NULL
  AND r."due_at" <> st."at" + make_interval(days => coalesce(
    (SELECT us."follow_up_days" FROM "user_settings" us WHERE us."user_id" = r."user_id"), 7
  ));--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_salary_currency_check" CHECK ("application"."salary_currency" is null or "application"."salary_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_salary_currency_required_check" CHECK (("application"."salary_range" is null) = ("application"."salary_currency" is null));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_default_currency_check" CHECK ("user_settings"."default_currency" ~ '^[A-Z]{3}$');

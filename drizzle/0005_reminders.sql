-- Reminders (manual and automatic follow-ups) and per-user settings. Hand-edited: the
-- stage_transition unique constraint is created before the foreign key that references it, and the
-- backfill at the end gives every non-archived application in an active-category stage one open
-- follow-up reminder, due 7 days (the default) after its latest transition and linked to it.
CREATE TYPE "public"."reminder_kind" AS ENUM('manual', 'follow_up');--> statement-breakpoint
CREATE TABLE "reminder" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"message" text NOT NULL,
	"transition_id" text,
	"sent_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_kind_transition_check" CHECK (("reminder"."kind" = 'follow_up') = ("reminder"."transition_id" is not null)),
	CONSTRAINT "reminder_message_length_check" CHECK (char_length("reminder"."message") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"follow_up_days" integer DEFAULT 7,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_follow_up_days_check" CHECK ("user_settings"."follow_up_days" is null or "user_settings"."follow_up_days" between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "stage_transition" ADD CONSTRAINT "stage_transition_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_application_id_user_id_fk" FOREIGN KEY ("application_id","user_id") REFERENCES "public"."application"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_transition_id_user_id_fk" FOREIGN KEY ("transition_id","user_id") REFERENCES "public"."stage_transition"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_follow_up_transition_idx" ON "reminder" USING btree ("transition_id") WHERE "reminder"."kind" = 'follow_up';--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_open_follow_up_idx" ON "reminder" USING btree ("application_id") WHERE "reminder"."kind" = 'follow_up' and "reminder"."done_at" is null;--> statement-breakpoint
CREATE INDEX "reminder_user_id_due_at_open_idx" ON "reminder" USING btree ("user_id","due_at") WHERE "reminder"."done_at" is null;--> statement-breakpoint
CREATE INDEX "reminder_due_at_unsent_idx" ON "reminder" USING btree ("due_at") WHERE "reminder"."sent_at" is null and "reminder"."done_at" is null;--> statement-breakpoint
CREATE INDEX "reminder_application_id_idx" ON "reminder" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "reminder_user_id_done_at_idx" ON "reminder" USING btree ("user_id","done_at");
--> statement-breakpoint
INSERT INTO "reminder" ("id", "user_id", "application_id", "kind", "due_at", "message", "transition_id")
SELECT gen_random_uuid()::text, a."user_id", a."id", 'follow_up', t."at" + interval '7 days',
  left('Follow up with ' || c."name" || ' about ' || a."role", 500), t."id"
FROM "application" a
JOIN "stage" s ON s."id" = a."stage_id" AND s."user_id" = a."user_id"
JOIN "company" c ON c."id" = a."company_id" AND c."user_id" = a."user_id"
JOIN LATERAL (
  SELECT st."id", st."at" FROM "stage_transition" st
  WHERE st."application_id" = a."id" AND st."user_id" = a."user_id"
  ORDER BY st."at" DESC, (st."from_stage_id" IS NOT NULL) DESC, st."id" DESC
  LIMIT 1
) t ON true
WHERE a."archived" = false AND s."category" = 'active';
-- Board order key per application (hand-edited: collate "C", backfill before NOT NULL).
-- Keys are fractional-indexing strings and must sort by code unit, whatever the database locale.
ALTER TABLE "application" ADD COLUMN "position" text COLLATE "C";--> statement-breakpoint
-- Existing applications get integer keys "c000", "c001", ... per user and stage, oldest first
-- (archived ones included, so they keep a place if restored). Three base-62 digits allow
-- 238,328 applications per stage; src/server/ordering.ts accepts these keys.
UPDATE "application" SET "position" = k."key"
FROM (
	SELECT r."id",
		'c'
		|| substr(d."digits", (r."n" / 3844)::int + 1, 1)
		|| substr(d."digits", ((r."n" / 62) % 62)::int + 1, 1)
		|| substr(d."digits", (r."n" % 62)::int + 1, 1) AS "key"
	FROM (
		SELECT "id", row_number() OVER (PARTITION BY "user_id", "stage_id" ORDER BY "created_at", "id") - 1 AS "n"
		FROM "application"
	) AS r
	CROSS JOIN (SELECT '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'::text AS "digits") AS d
) AS k
WHERE "application"."id" = k."id";--> statement-breakpoint
ALTER TABLE "application" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TABLE "stage_transition" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"from_stage_id" text,
	"to_stage_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stage_transition" ADD CONSTRAINT "stage_transition_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transition" ADD CONSTRAINT "stage_transition_application_id_user_id_fk" FOREIGN KEY ("application_id","user_id") REFERENCES "public"."application"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transition" ADD CONSTRAINT "stage_transition_from_stage_id_user_id_fk" FOREIGN KEY ("from_stage_id","user_id") REFERENCES "public"."stage"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transition" ADD CONSTRAINT "stage_transition_to_stage_id_user_id_fk" FOREIGN KEY ("to_stage_id","user_id") REFERENCES "public"."stage"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stage_transition_user_id_at_idx" ON "stage_transition" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "stage_transition_application_id_idx" ON "stage_transition" USING btree ("application_id","at");--> statement-breakpoint
CREATE INDEX "stage_transition_from_stage_id_idx" ON "stage_transition" USING btree ("from_stage_id");--> statement-breakpoint
CREATE INDEX "stage_transition_to_stage_id_idx" ON "stage_transition" USING btree ("to_stage_id");--> statement-breakpoint
-- Starting point for statistics: every existing application was "created" into its current stage
-- at its creation time (its earlier moves, if any, were never recorded).
INSERT INTO "stage_transition" ("id", "user_id", "application_id", "from_stage_id", "to_stage_id", "at")
SELECT gen_random_uuid()::text, "user_id", "id", NULL, "stage_id", "created_at"
FROM "application";

CREATE TYPE "public"."stage_category" AS ENUM('active', 'offer', 'rejected', 'accepted', 'withdrawn');--> statement-breakpoint
CREATE TABLE "stage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"category" "stage_category" NOT NULL,
	"position" integer NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_id_user_id_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_user_id_name_idx" ON "stage" USING btree ("user_id",lower("name"));--> statement-breakpoint
-- Backfill for databases that already have users and applications (hand-written, not generated).
-- Default stages for every existing user; must match DEFAULT_STAGES in src/server/stages.ts.
INSERT INTO "stage" ("id", "user_id", "name", "category", "position")
SELECT gen_random_uuid()::text, "user"."id", d."name", d."category"::"stage_category", d."position"
FROM "user"
CROSS JOIN (VALUES
	('Applied', 'active', 0),
	('Screening', 'active', 1),
	('Interview', 'active', 2),
	('Offer', 'offer', 3),
	('Rejected', 'rejected', 4),
	('Accepted', 'accepted', 5)
) AS d("name", "category", "position")
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "stage_id" text;--> statement-breakpoint
UPDATE "application" SET "stage_id" = "stage"."id"
FROM "stage"
WHERE "stage"."user_id" = "application"."user_id" AND "stage"."name" = 'Applied';--> statement-breakpoint
ALTER TABLE "application" ALTER COLUMN "stage_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_stage_id_user_id_fk" FOREIGN KEY ("stage_id","user_id") REFERENCES "public"."stage"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_stage_id_idx" ON "application" USING btree ("stage_id");

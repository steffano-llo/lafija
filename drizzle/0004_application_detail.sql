-- Interviews, contacts, application-contact links and application notes. New tables and a nullable
-- column only, no backfill. Hand-edited: the application unique constraint is created before the
-- foreign key that references it.
CREATE TYPE "public"."interview_outcome" AS ENUM('pending', 'passed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."interview_type" AS ENUM('phone', 'video', 'onsite', 'technical', 'other');--> statement-breakpoint
CREATE TABLE "application_contact" (
	"application_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contact_pk" PRIMARY KEY("application_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"linkedin" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_id_company_id_user_id_unique" UNIQUE("id","company_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "interview" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"type" "interview_type" NOT NULL,
	"notes" text,
	"outcome" "interview_outcome" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_id_company_id_user_id_unique" UNIQUE("id","company_id","user_id");--> statement-breakpoint
ALTER TABLE "application_contact" ADD CONSTRAINT "application_contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_contact" ADD CONSTRAINT "application_contact_application_fk" FOREIGN KEY ("application_id","company_id","user_id") REFERENCES "public"."application"("id","company_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_contact" ADD CONSTRAINT "application_contact_contact_fk" FOREIGN KEY ("contact_id","company_id","user_id") REFERENCES "public"."contact"("id","company_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_company_id_user_id_fk" FOREIGN KEY ("company_id","user_id") REFERENCES "public"."company"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview" ADD CONSTRAINT "interview_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview" ADD CONSTRAINT "interview_application_id_user_id_fk" FOREIGN KEY ("application_id","user_id") REFERENCES "public"."application"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_contact_contact_id_idx" ON "application_contact" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_company_id_idx" ON "contact" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contact_user_id_idx" ON "contact" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "interview_application_id_scheduled_at_idx" ON "interview" USING btree ("application_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "interview_user_id_idx" ON "interview" USING btree ("user_id");
-- T10 (S6, S23): demo accounts. The unique (id, email) on "user" must exist before the composite
-- foreign key that references it, so it comes first (drizzle-kit emitted it last).
ALTER TABLE "user" ADD CONSTRAINT "user_id_email_unique" UNIQUE("id","email");--> statement-breakpoint
CREATE TABLE "demo_account" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT (now() + interval '24 hours') NOT NULL,
	CONSTRAINT "demo_account_email_check" CHECK ("demo_account"."email" like '%@demo.lafija.invalid'),
	CONSTRAINT "demo_account_lifetime_check" CHECK ("demo_account"."expires_at" = "demo_account"."created_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "demo_account" ADD CONSTRAINT "demo_account_user_id_email_fk" FOREIGN KEY ("user_id","email") REFERENCES "public"."user"("id","email") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "demo_account_expires_at_idx" ON "demo_account" USING btree ("expires_at");

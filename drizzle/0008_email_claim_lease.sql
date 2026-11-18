ALTER TABLE "reminder" ADD COLUMN "email_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "verification_email_sent_at" timestamp with time zone;
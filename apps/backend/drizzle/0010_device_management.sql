ALTER TABLE "devices" ADD COLUMN "registration_id" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "platform" "device_platform";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_seen_at" timestamp;

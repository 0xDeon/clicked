CREATE TYPE "public"."content_type" AS ENUM('text', 'file', 'image', 'video', 'audio', 'system');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_type" "content_type" NOT NULL DEFAULT 'text';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_device_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sequence_number" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_id_user_devices_id_fk" FOREIGN KEY ("sender_device_id") REFERENCES "public"."user_devices"("id") ON DELETE cascade ON UPDATE no action;

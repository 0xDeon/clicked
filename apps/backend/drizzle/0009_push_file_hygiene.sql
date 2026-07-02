-- #231: files table for tracking S3 storage objects with soft/hard delete
CREATE TABLE IF NOT EXISTS "files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "storage_key" text NOT NULL,
  "deleted_at" timestamp,
  "hard_deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key");--> statement-breakpoint

-- #231: link messages to their S3 file object
ALTER TABLE "messages" ADD COLUMN "file_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- #237: push subscription hygiene columns
ALTER TABLE "push_subscriptions" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "disabled_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_device_active_idx" ON "push_subscriptions" ("device_id") WHERE "disabled_at" IS NULL;

CREATE TYPE "public"."file_content_type" AS ENUM('file', 'image', 'video', 'audio');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"size" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" "file_content_type" DEFAULT 'file' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

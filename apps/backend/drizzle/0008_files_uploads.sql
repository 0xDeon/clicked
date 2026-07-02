-- Issue #228: file status enum + files table (base, from PR #256)
DO $$ BEGIN
  CREATE TYPE "file_status" AS ENUM('pending', 'ready', 'deleted');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Issue #228: message content type enum (from PR #256)
DO $$ BEGIN
  CREATE TYPE "message_content_type" AS ENUM('text', 'file', 'image', 'video', 'audio');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Issue #226/#230: create files table with size/mimeType/sha256/storageKey/isThumbnail
CREATE TABLE IF NOT EXISTS "files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "uploader_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "status" "file_status" NOT NULL DEFAULT 'pending',
  "size" integer NOT NULL,
  "mime_type" text NOT NULL,
  "sha256" text NOT NULL,
  "storage_key" text NOT NULL,
  "is_thumbnail" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Issue #228: add contentType + fileId columns to messages
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "content_type" "message_content_type" NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS "file_id" uuid REFERENCES "files"("id") ON DELETE SET NULL;

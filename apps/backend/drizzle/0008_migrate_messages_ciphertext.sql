-- Drop the full-text search index that relied on the plaintext content column.
DROP INDEX IF EXISTS "messages_content_search_idx";--> statement-breakpoint

-- Add the new nullable ciphertext column for single-blob E2EE messages.
ALTER TABLE "messages" ADD COLUMN "ciphertext" text;--> statement-breakpoint

-- Migrate existing plaintext content into ciphertext so no data is lost.
UPDATE "messages" SET "ciphertext" = "content" WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Drop the old plaintext content column.
ALTER TABLE "messages" DROP COLUMN "content";

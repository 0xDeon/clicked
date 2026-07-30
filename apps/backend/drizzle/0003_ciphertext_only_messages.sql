-- One-time migration: drop plaintext `messages.content`, reset to the
-- ciphertext-only model.
--
-- Policy (documented in full at docs/message-encryption-migration.md):
-- ARCHIVE THEN PURGE. Any existing plaintext row is copied into
-- `message_content_archive` — a table with no read path through the app's
-- API — before the column is dropped from `messages`. This keeps `messages`
-- fully ciphertext-shaped going forward (so `serializeMessage()` never has a
-- plaintext branch to accidentally serve) while preserving a compliance/
-- audit copy of pre-E2EE history on its own retention schedule, instead of
-- silently destroying it or leaving a tombstone column on `messages` forever.
--
-- Safe to run on a DB that never had a `content` column (this repo's own
-- migration history: 0000 already created `messages` in its ciphertext
-- shape) — the archive step is a no-op guarded by an information_schema
-- check, and every DDL statement below uses IF EXISTS/IF NOT EXISTS so
-- nothing errors either way. See docs/message-encryption-migration.md for
-- the full rollback plan and its limitations.

CREATE TABLE IF NOT EXISTS "message_content_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Intentionally not a foreign key: this archive must outlive the
	-- `messages` row it was copied from (e.g. hard-deletion by the message
	-- GC path must not cascade-delete the compliance copy).
	"original_message_id" uuid NOT NULL,
	"conversation_id" uuid,
	"sender_id" uuid,
	"content" text NOT NULL,
	"original_created_at" timestamp,
	"archived_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_content_archive_original_message_idx" ON "message_content_archive" USING btree ("original_message_id");
--> statement-breakpoint

-- Archive any existing plaintext before the column is dropped. Dynamic SQL
-- is required here (unlike the DROP statements below) because a plain
-- top-level statement referencing `messages.content` would fail to parse on
-- a database where that column never existed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'content'
  ) THEN
    EXECUTE '
      INSERT INTO message_content_archive
        (original_message_id, conversation_id, sender_id, content, original_created_at)
      SELECT id, conversation_id, sender_id, content, created_at
      FROM messages
      WHERE content IS NOT NULL
    ';
  END IF;
END $$;
--> statement-breakpoint

-- Drop the plaintext column's GIN index. The exact index name from
-- pre-squash history is not recoverable, so every plausible historical name
-- is dropped defensively — DROP INDEX IF EXISTS is a no-op for names that
-- don't exist, so this is safe regardless of which (if any) actually match.
DROP INDEX IF EXISTS "messages_content_gin_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "messages_content_search_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "messages_content_tsv_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "messages_content_idx";
--> statement-breakpoint

ALTER TABLE "messages" DROP COLUMN IF EXISTS "content";
--> statement-breakpoint

-- Defensively ensure the ciphertext-model columns/tables this migration's
-- companion schema overhaul introduced are present, for any database whose
-- migration history predates the 0000 squash and therefore skipped them.
-- A no-op everywhere this repo's own 0000 migration already ran.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "ciphertext" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sender_device_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "file_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "edits_message_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
--> statement-breakpoint

-- Note: this fallback intentionally omits FK constraints — on every database
-- that already ran this repo's 0000 migration (the only realistic case),
-- the table already exists with its constraints and this is a pure no-op.
-- A database old enough to hit this branch predates the squash entirely and
-- needs a manually-reviewed reconciliation, not a silent constraint add.
CREATE TABLE IF NOT EXISTS "message_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"recipient_device_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"delivered_at" timestamp,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Rollback for 0003_ciphertext_only_messages.sql.
--
-- drizzle-kit has no built-in "down" migration runner — this script is
-- invoked manually (e.g. `psql "$DATABASE_URL" -f drizzle/rollback/0003_ciphertext_only_messages.down.sql`)
-- and is NOT part of the drizzle migration journal, so it is never applied
-- automatically by `db:migrate`.
--
-- LIMITATIONS (see docs/message-encryption-migration.md for full detail):
--   * Only rows present in `message_content_archive` get their plaintext
--     restored. Any message sent after the forward migration ran was only
--     ever stored as ciphertext — there is no plaintext to bring back for it.
--   * The recreated GIN index is a reasonable equivalent (full-text search
--     over `content`), not necessarily byte-identical to whatever indexdef
--     existed pre-squash — that definition was not recoverable (see the
--     forward migration's comment on why several index names are dropped
--     defensively rather than one exact name).
--   * This script does NOT drop the ciphertext/envelope/device-capability/
--     GC columns and tables added by this migration set. Rolling those back
--     would remove the entire E2EE data model, not just this one migration's
--     change — treat that as a separate, deliberate decision, not a side
--     effect of undoing the content-column drop.
--   * `message_content_archive` is left in place after restoring so no data
--     is destroyed by running this script; drop it manually once satisfied.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "content" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "messages_content_gin_idx" ON "messages" USING gin (to_tsvector('english', "content"));
--> statement-breakpoint

UPDATE "messages" m
SET "content" = a."content"
FROM "message_content_archive" a
WHERE a."original_message_id" = m."id"
  AND m."content" IS NULL;

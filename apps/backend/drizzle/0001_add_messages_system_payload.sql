ALTER TABLE "messages" ADD COLUMN "system_payload" jsonb;--> statement-breakpoint
-- Backfill: legacy system messages stored `JSON.stringify({ userId, change })`
-- directly in `ciphertext`. Move that structured metadata into the new
-- dedicated column and null out `ciphertext` so the check constraint below can
-- be applied to pre-existing rows. Ciphertext that is not parseable JSON is
-- preserved verbatim under `legacyCiphertext` rather than dropped.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT "id", "ciphertext" FROM "messages" WHERE "content_type" = 'system' LOOP
    BEGIN
      UPDATE "messages"
      SET "system_payload" = COALESCE(r."ciphertext"::jsonb, '{}'::jsonb),
          "ciphertext" = NULL
      WHERE "id" = r."id";
    EXCEPTION
      WHEN others THEN
        UPDATE "messages"
        SET "system_payload" = jsonb_build_object('legacyCiphertext', r."ciphertext"),
            "ciphertext" = NULL
        WHERE "id" = r."id";
    END;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_system_payload_check" CHECK ("messages"."content_type" <> 'system' OR ("messages"."ciphertext" IS NULL AND "messages"."system_payload" IS NOT NULL));
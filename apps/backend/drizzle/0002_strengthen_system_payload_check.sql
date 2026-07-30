-- Backfill: #398 added `system_payload` but no producer ever wrote to it, so
-- every pre-existing system row still has its {userId, change} JSON sitting in
-- `ciphertext` with `system_payload` NULL. The stricter constraint below would
-- reject those rows outright, so move the data across first. Unparseable
-- values are preserved under a `legacyCiphertext` key rather than dropped.
DO $$
DECLARE
  row RECORD;
BEGIN
  FOR row IN
    SELECT id, ciphertext FROM "messages"
    WHERE content_type = 'system' AND system_payload IS NULL
  LOOP
    BEGIN
      UPDATE "messages"
      SET system_payload = row.ciphertext::jsonb,
          ciphertext = NULL
      WHERE id = row.id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE "messages"
      SET system_payload = jsonb_build_object('legacyCiphertext', row.ciphertext),
          ciphertext = NULL
      WHERE id = row.id;
    END;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_system_payload_only_on_system_type";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_system_payload_check" CHECK ("messages"."content_type" <> 'system' OR ("messages"."ciphertext" IS NULL AND "messages"."system_payload" IS NOT NULL));

-- Per-envelope E2EE protocol (#364).
--
-- `message_envelopes.protocol` is added NOT NULL DEFAULT 'sealed_box', which
-- backfills every existing row to the Phase-1 sealed box in the same
-- statement. That is the no-history-loss guarantee: envelopes written before a
-- device pair cut over are labelled with the construction that actually
-- encrypted them, so they keep decrypting on the Phase-1 path even after that
-- pair's `devices.capabilities` has moved on.
--
-- Values mirror KNOWN_PROTOCOLS in src/lib/capabilities.ts. No column is added
-- to `devices`: capability advertisement already lives in `devices.capabilities`
-- (0002_device_capabilities.sql).
CREATE TYPE "public"."e2ee_protocol" AS ENUM('sealed_box', 'signal', 'mls');--> statement-breakpoint
ALTER TABLE "message_envelopes" ADD COLUMN "protocol" "e2ee_protocol" DEFAULT 'sealed_box' NOT NULL;

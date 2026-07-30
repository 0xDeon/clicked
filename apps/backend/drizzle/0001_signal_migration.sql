-- Phase-1 -> Signal migration (#364).
--
-- `message_envelopes.protocol` is added NOT NULL DEFAULT 'sealed_box', which
-- backfills every existing row to the Phase-1 sealed box in the same statement.
-- That is the no-history-loss guarantee: envelopes written before the cutover
-- are labelled with the construction that actually encrypted them and keep
-- decrypting on the Phase-1 path.
--
-- `devices.supports_signal` defaults to false, so every already-registered
-- device starts as Phase-1 only and conversations stay on sealed box until
-- each device explicitly advertises Signal support.
CREATE TYPE "public"."e2ee_protocol" AS ENUM('sealed_box', 'signal');--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "supports_signal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_envelopes" ADD COLUMN "protocol" "e2ee_protocol" DEFAULT 'sealed_box' NOT NULL;

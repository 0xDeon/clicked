-- Device capability/version negotiation (#180-follow-on).
--
-- Advertises supported protocols/ciphersuites/file-transfer versions per
-- device so senders can pick an encryption path both sides support. Rows
-- written before this migration default to the sealed_box-only baseline —
-- the protocol every device in this codebase already implements — so
-- existing devices negotiate correctly without any backfill.
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "capabilities" jsonb DEFAULT '{"protocols":["sealed_box"],"ciphersuites":[],"fileTransfer":[]}'::jsonb NOT NULL;

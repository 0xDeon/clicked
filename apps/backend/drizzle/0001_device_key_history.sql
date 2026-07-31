-- #379: Key-transparency / device-key-change detection
-- Append-only log of identity-key changes per device. Immutable — rows are
-- never deleted so clients can detect silent key swaps.

CREATE TABLE "device_key_history" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id"     uuid NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "previous_key"  text,
  "new_key"       text NOT NULL,
  "change_reason" text,
  "recorded_at"   timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "device_key_history_device_idx"
  ON "device_key_history" ("device_id", "recorded_at");

CREATE INDEX "device_key_history_user_idx"
  ON "device_key_history" ("user_id", "recorded_at");

-- Background GC jobs (prekey/envelope/file/device cleanup) — schema support.
--
-- Adds:
--   * mls_key_packages — one-time MLS KeyPackages per device, mirroring
--     device_prekeys' consumed-flag model so issuance stays auditable.
--   * devices.stale_flagged_at — informational marker set by the device-GC
--     job once a revoked device ages past retention. Never deletes the row.
CREATE TABLE "mls_key_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"key_package" text NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mls_key_packages" ADD CONSTRAINT "mls_key_packages_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mls_key_packages_device_available_idx" ON "mls_key_packages" USING btree ("device_id") WHERE "mls_key_packages"."consumed" = false;
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "stale_flagged_at" timestamp;

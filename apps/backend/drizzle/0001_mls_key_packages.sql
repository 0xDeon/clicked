CREATE TABLE "mls_key_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"cipher_suite" integer NOT NULL,
	"key_package" text NOT NULL,
	"package_hash" text NOT NULL,
	"expires_at" timestamp,
	"consumed" boolean DEFAULT false NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mls_key_packages" ADD CONSTRAINT "mls_key_packages_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mls_key_packages_device_hash_idx" ON "mls_key_packages" USING btree ("device_id","package_hash");--> statement-breakpoint
CREATE INDEX "mls_key_packages_available_idx" ON "mls_key_packages" USING btree ("device_id","cipher_suite","created_at") WHERE "mls_key_packages"."consumed" = false;
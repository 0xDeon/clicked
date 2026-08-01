CREATE TABLE "mls_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mls_group_id" uuid NOT NULL,
	"epoch" bigint NOT NULL,
	"committer_device_id" uuid,
	"commit" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mls_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mls_group_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at_epoch" bigint NOT NULL,
	"removed_at_epoch" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mls_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"group_id" text NOT NULL,
	"cipher_suite" integer NOT NULL,
	"current_epoch" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mls_welcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mls_group_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"epoch" bigint NOT NULL,
	"welcome" text NOT NULL,
	"claimed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "mls_epoch" bigint;--> statement-breakpoint
ALTER TABLE "mls_commits" ADD CONSTRAINT "mls_commits_mls_group_id_mls_groups_id_fk" FOREIGN KEY ("mls_group_id") REFERENCES "public"."mls_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_commits" ADD CONSTRAINT "mls_commits_committer_device_id_devices_id_fk" FOREIGN KEY ("committer_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_mls_group_id_mls_groups_id_fk" FOREIGN KEY ("mls_group_id") REFERENCES "public"."mls_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_groups" ADD CONSTRAINT "mls_groups_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_welcomes" ADD CONSTRAINT "mls_welcomes_mls_group_id_mls_groups_id_fk" FOREIGN KEY ("mls_group_id") REFERENCES "public"."mls_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_welcomes" ADD CONSTRAINT "mls_welcomes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mls_commits_group_epoch_idx" ON "mls_commits" USING btree ("mls_group_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_group_members_active_idx" ON "mls_group_members" USING btree ("mls_group_id","device_id") WHERE "mls_group_members"."removed_at_epoch" IS NULL;--> statement-breakpoint
CREATE INDEX "mls_group_members_device_idx" ON "mls_group_members" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_groups_conversation_idx" ON "mls_groups" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_groups_group_id_idx" ON "mls_groups" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_welcomes_group_device_epoch_idx" ON "mls_welcomes" USING btree ("mls_group_id","device_id","epoch");--> statement-breakpoint
CREATE INDEX "mls_welcomes_pending_idx" ON "mls_welcomes" USING btree ("device_id") WHERE "mls_welcomes"."claimed_at" IS NULL;
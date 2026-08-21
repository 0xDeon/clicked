CREATE TYPE "public"."audit_action" AS ENUM('device_linked', 'device_revoked', 'logout_everywhere', 'key_bundle_drained', 'auth_failed', 'file_access_denied', 'group_member_added', 'group_member_removed');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('text', 'file', 'image', 'video', 'audio', 'system');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('dm', 'group');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('web', 'ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."e2ee_protocol" AS ENUM('sealed_box', 'signal', 'mls');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('pending', 'ready', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."group_control_event_type" AS ENUM('member_added', 'member_removed', 'member_left', 'commit');--> statement-breakpoint
CREATE TYPE "public"."prekey_type" AS ENUM('signed', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."proposal_vote_type" AS ENUM('approve', 'reject');--> statement-breakpoint
CREATE TYPE "public"."treasury_proposal_status" AS ENUM('active', 'approved', 'rejected', 'executed', 'expired');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor_user_id" uuid,
	"actor_device_id" uuid,
	"subject_user_id" uuid,
	"target_type" text,
	"target_id" text,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_message_id" uuid,
	"is_muted" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "conversation_type" DEFAULT 'dm' NOT NULL,
	"name" text,
	"avatar_url" text,
	"epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_key_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"previous_key" text,
	"new_key" text NOT NULL,
	"change_reason" text,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_prekeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"key_type" "prekey_type" NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"signature" text,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_prekeys_signed_requires_signature" CHECK ("device_prekeys"."key_type" <> 'signed' OR "device_prekeys"."signature" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_public_key" text NOT NULL,
	"registration_id" integer,
	"device_name" text,
	"platform" "device_platform",
	"last_seen_at" timestamp,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp,
	"stale_flagged_at" timestamp,
	"capabilities" jsonb DEFAULT '{"protocols":["sealed_box"],"ciphersuites":[],"fileTransfer":[]}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" "file_status" DEFAULT 'pending' NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"is_thumbnail" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"hard_deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "group_control_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"epoch" integer NOT NULL,
	"event_type" "group_control_event_type" NOT NULL,
	"actor_user_id" uuid,
	"target_user_id" uuid,
	"message_id" uuid,
	"payload" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"recipient_device_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"protocol" "e2ee_protocol" DEFAULT 'sealed_box' NOT NULL,
	"delivered_at" timestamp,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_device_id" uuid,
	"content_type" text DEFAULT 'text' NOT NULL,
	"ciphertext" text,
	"system_payload" jsonb,
	"file_id" uuid,
	"edits_message_id" uuid,
	"mls_epoch" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "messages_system_payload_check" CHECK ("messages"."content_type" <> 'system' OR ("messages"."ciphertext" IS NULL AND "messages"."system_payload" IS NOT NULL))
);
--> statement-breakpoint
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
CREATE TABLE "proposal_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"vote" "proposal_vote_type" NOT NULL,
	"signature" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"last_used_at" timestamp,
	"disabled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "token_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_address" text NOT NULL,
	"amount" text NOT NULL,
	"token_contract_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"memo" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "token_transfers_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
CREATE TABLE "treasury_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"conversation_id" uuid,
	"status" "treasury_proposal_status" DEFAULT 'active' NOT NULL,
	"approvals_count" integer DEFAULT 0 NOT NULL,
	"rejections_count" integer DEFAULT 0 NOT NULL,
	"recipient" text,
	"amount" text,
	"token" text,
	"threshold" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text,
	"avatar_url" text,
	"presence_visible" boolean DEFAULT false NOT NULL,
	"last_seen_visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"send_read_receipts" boolean DEFAULT false NOT NULL,
	"allow_direct_messages" boolean DEFAULT true NOT NULL,
	"allow_group_invites" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_address_unique" UNIQUE("address")
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_last_read_message_id_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_key_history" ADD CONSTRAINT "device_key_history_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_key_history" ADD CONSTRAINT "device_key_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_prekeys" ADD CONSTRAINT "device_prekeys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_envelopes" ADD CONSTRAINT "message_envelopes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_envelopes" ADD CONSTRAINT "message_envelopes_recipient_device_id_devices_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_envelopes" ADD CONSTRAINT "message_envelopes_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_id_devices_id_fk" FOREIGN KEY ("sender_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_edits_message_id_messages_id_fk" FOREIGN KEY ("edits_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_commits" ADD CONSTRAINT "mls_commits_mls_group_id_mls_groups_id_fk" FOREIGN KEY ("mls_group_id") REFERENCES "public"."mls_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_commits" ADD CONSTRAINT "mls_commits_committer_device_id_devices_id_fk" FOREIGN KEY ("committer_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_mls_group_id_mls_groups_id_fk" FOREIGN KEY ("mls_group_id") REFERENCES "public"."mls_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_groups" ADD CONSTRAINT "mls_groups_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_key_packages" ADD CONSTRAINT "mls_key_packages_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_welcomes" ADD CONSTRAINT "mls_welcomes_mls_group_id_mls_groups_id_fk" FOREIGN KEY ("mls_group_id") REFERENCES "public"."mls_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_welcomes" ADD CONSTRAINT "mls_welcomes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_votes" ADD CONSTRAINT "proposal_votes_treasury_proposal_id_treasury_proposals_id_fk" FOREIGN KEY ("treasury_proposal_id") REFERENCES "public"."treasury_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_votes" ADD CONSTRAINT "proposal_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_transfers" ADD CONSTRAINT "token_transfers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_transfers" ADD CONSTRAINT "token_transfers_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_proposals" ADD CONSTRAINT "treasury_proposals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_subject_created_idx" ON "audit_logs" USING btree ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_created_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "device_key_history_device_idx" ON "device_key_history" USING btree ("device_id","recorded_at");--> statement-breakpoint
CREATE INDEX "device_key_history_user_idx" ON "device_key_history" USING btree ("user_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_prekeys_device_type_keyid_idx" ON "device_prekeys" USING btree ("device_id","key_type","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_prekeys_signed_device_idx" ON "device_prekeys" USING btree ("device_id") WHERE "device_prekeys"."key_type" = 'signed';--> statement-breakpoint
CREATE INDEX "device_prekeys_one_time_available_idx" ON "device_prekeys" USING btree ("device_id") WHERE "device_prekeys"."key_type" = 'one_time' AND "device_prekeys"."consumed" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_identity_idx" ON "devices" USING btree ("user_id","identity_public_key");--> statement-breakpoint
CREATE INDEX "devices_user_id_active_idx" ON "devices" USING btree ("user_id") WHERE "devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "group_control_conversation_sequence_idx" ON "group_control_events" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "me_recipient_device_created_idx" ON "message_envelopes" USING btree ("recipient_device_id","created_at");--> statement-breakpoint
CREATE INDEX "me_message_idx" ON "message_envelopes" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_commits_group_epoch_idx" ON "mls_commits" USING btree ("mls_group_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_group_members_active_idx" ON "mls_group_members" USING btree ("mls_group_id","device_id") WHERE "mls_group_members"."removed_at_epoch" IS NULL;--> statement-breakpoint
CREATE INDEX "mls_group_members_device_idx" ON "mls_group_members" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_groups_conversation_idx" ON "mls_groups" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_groups_group_id_idx" ON "mls_groups" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_key_packages_device_hash_idx" ON "mls_key_packages" USING btree ("device_id","package_hash");--> statement-breakpoint
CREATE INDEX "mls_key_packages_available_idx" ON "mls_key_packages" USING btree ("device_id","cipher_suite","created_at") WHERE "mls_key_packages"."consumed" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "mls_welcomes_group_device_epoch_idx" ON "mls_welcomes" USING btree ("mls_group_id","device_id","epoch");--> statement-breakpoint
CREATE INDEX "mls_welcomes_pending_idx" ON "mls_welcomes" USING btree ("device_id") WHERE "mls_welcomes"."claimed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_votes_proposal_user_unique" ON "proposal_votes" USING btree ("treasury_proposal_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_proposals_contract_proposal_idx" ON "treasury_proposals" USING btree ("contract_id","proposal_id");
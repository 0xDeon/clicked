CREATE TYPE "public"."audit_action" AS ENUM('device_linked', 'device_revoked', 'logout_everywhere', 'key_bundle_drained', 'auth_failed', 'file_access_denied', 'group_member_added', 'group_member_removed');--> statement-breakpoint
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
CREATE INDEX "audit_logs_subject_created_idx" ON "audit_logs" USING btree ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_created_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
-- Append-only enforcement (#376). Enforced in the database rather than by
-- convention: the log is only useful to an incident responder if the
-- application account an attacker would already have reached cannot rewrite
-- or erase it. Retention pruning is therefore a deliberate, privileged
-- operation — drop the trigger, prune, recreate it — not something a stray
-- UPDATE or DELETE can do. The actor/subject columns carry no foreign keys
-- for the same reason: a cascade would delete the history along with the
-- account it incriminates.
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_logs_no_mutation
	BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_logs"
	FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_mutation();
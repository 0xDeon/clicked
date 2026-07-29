CREATE TYPE "public"."group_control_event_type" AS ENUM('member_added', 'member_removed', 'member_left', 'commit');--> statement-breakpoint
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
ALTER TABLE "conversations" ADD COLUMN "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_control_events" ADD CONSTRAINT "group_control_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_control_conversation_sequence_idx" ON "group_control_events" USING btree ("conversation_id","sequence");
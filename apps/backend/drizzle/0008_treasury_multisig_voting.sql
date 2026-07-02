CREATE TYPE "public"."treasury_proposal_status" AS ENUM('active', 'approved', 'rejected', 'executed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."proposal_vote_type" AS ENUM('approve', 'reject');--> statement-breakpoint
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
CREATE TABLE "proposal_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"vote" "proposal_vote_type" NOT NULL,
	"signature" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treasury_proposals" ADD CONSTRAINT "treasury_proposals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_votes" ADD CONSTRAINT "proposal_votes_treasury_proposal_id_treasury_proposals_id_fk" FOREIGN KEY ("treasury_proposal_id") REFERENCES "public"."treasury_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_votes" ADD CONSTRAINT "proposal_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_proposals_contract_proposal_idx" ON "treasury_proposals" USING btree ("contract_id","proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_votes_proposal_user_unique" ON "proposal_votes" USING btree ("treasury_proposal_id","user_id");

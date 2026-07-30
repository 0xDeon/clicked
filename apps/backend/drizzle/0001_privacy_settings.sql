ALTER TABLE "users" ALTER COLUMN "presence_visible" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "send_read_receipts" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "allow_direct_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "allow_group_invites" boolean DEFAULT false NOT NULL;

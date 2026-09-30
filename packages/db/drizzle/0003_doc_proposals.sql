CREATE TABLE "doc_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"step" text NOT NULL,
	"thread_id" uuid,
	"base_checkpoint" text NOT NULL,
	"head_checkpoint" text NOT NULL,
	"patch" text NOT NULL,
	"files" jsonb NOT NULL,
	"outside_docs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_proposals" ADD CONSTRAINT "doc_proposals_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_proposals" ADD CONSTRAINT "doc_proposals_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;
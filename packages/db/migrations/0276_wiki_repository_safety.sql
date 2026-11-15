ALTER TABLE "wiki_repositories" ADD COLUMN "public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_repositories" ADD COLUMN "removals_waiting" integer;--> statement-breakpoint
ALTER TABLE "wiki_repositories" ADD COLUMN "removals_allowed" boolean DEFAULT false NOT NULL;
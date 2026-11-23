-- The forum's tables, unused since 0216 removed the forum and its data (ADR 0022).
DROP TABLE "forum_participants" CASCADE;--> statement-breakpoint
DROP TABLE "forum_topics" CASCADE;--> statement-breakpoint
DROP TABLE "forum_turns" CASCADE;--> statement-breakpoint
-- There is no approval step: a wait an older provisioner left as `approval` is a wait for capacity.
UPDATE "machine_provisioning" SET "reason" = 'capacity' WHERE "reason" = 'approval';

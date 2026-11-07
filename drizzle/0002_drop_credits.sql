DROP TABLE "credit_ledger" CASCADE;--> statement-breakpoint
ALTER TABLE "translation_chunks" DROP COLUMN "cost";--> statement-breakpoint
ALTER TABLE "translation_jobs" DROP COLUMN "credits_reserved";--> statement-breakpoint
ALTER TABLE "translation_jobs" DROP COLUMN "credits_used";
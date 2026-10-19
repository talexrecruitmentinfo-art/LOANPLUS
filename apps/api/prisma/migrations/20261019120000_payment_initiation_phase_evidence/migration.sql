ALTER TABLE "payment_transactions"
ADD COLUMN "initiationPhase" VARCHAR(40);

ALTER TABLE "payment_reconciliation_attempts"
ADD COLUMN "evidenceSource" VARCHAR(40),
ADD COLUMN "evidenceReference" VARCHAR(100);
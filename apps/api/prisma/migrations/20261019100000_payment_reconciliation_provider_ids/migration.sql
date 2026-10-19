ALTER TABLE "payment_reconciliation_attempts"
ADD COLUMN "submittedAccountReference" VARCHAR(12),
ADD COLUMN "submittedCheckoutRequestId" VARCHAR(100),
ADD COLUMN "submittedMerchantRequestId" VARCHAR(100);
ALTER TYPE "LoanApplicationStatus" ADD VALUE 'DRAFT';
ALTER TYPE "LoanApplicationStatus" ADD VALUE 'PROCESSING_PAYMENT_PENDING';
ALTER TYPE "PaymentType" ADD VALUE 'LOAN_PROCESSING_FEE';

ALTER TABLE "loan_applications"
ADD COLUMN "creationIdempotencyKey" VARCHAR(128),
ADD COLUMN "creationRequestHash" VARCHAR(64),
ADD COLUMN "createdAt" TIMESTAMP(3);

UPDATE "loan_applications"
SET "createdAt" = "submittedAt";

ALTER TABLE "loan_applications"
ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "createdAt" SET NOT NULL;

CREATE UNIQUE INDEX "loan_applications_creationIdempotencyKey_key"
ON "loan_applications"("creationIdempotencyKey");

ALTER TABLE "payment_transactions"
ADD COLUMN "loanApplicationId" TEXT;

CREATE UNIQUE INDEX "payment_transactions_loanApplicationId_key"
ON "payment_transactions"("loanApplicationId");

ALTER TABLE "payment_transactions"
ADD CONSTRAINT "payment_transactions_loanApplicationId_fkey"
FOREIGN KEY ("loanApplicationId") REFERENCES "loan_applications"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

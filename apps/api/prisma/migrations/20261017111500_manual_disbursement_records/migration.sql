CREATE TYPE "DisbursementStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED');

CREATE TABLE "loan_disbursements" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "amountKes" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "status" "DisbursementStatus" NOT NULL DEFAULT 'PENDING',
    "paymentReference" VARCHAR(100) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "loan_disbursements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loan_disbursements_positive_amount" CHECK ("amountKes" > 0 AND "currency" = 'KES')
);

CREATE UNIQUE INDEX "loan_disbursements_loanId_key" ON "loan_disbursements"("loanId");
CREATE UNIQUE INDEX "loan_disbursements_paymentReference_key" ON "loan_disbursements"("paymentReference");
CREATE INDEX "loan_disbursements_status_createdAt_idx" ON "loan_disbursements"("status", "createdAt");

ALTER TABLE "loan_disbursements"
    ADD CONSTRAINT "loan_disbursements_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "loan_disbursements"
    ADD CONSTRAINT "loan_disbursements_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES "superadmin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
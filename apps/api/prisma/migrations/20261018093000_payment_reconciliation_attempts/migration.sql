CREATE TABLE "payment_reconciliation_attempts" (
    "id" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "superadminId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "operatorNote" VARCHAR(500) NOT NULL,
    "outcome" VARCHAR(40) NOT NULL DEFAULT 'STARTED',
    "providerResultCode" VARCHAR(40),
    "reasonCode" VARCHAR(80),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "payment_reconciliation_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_reconciliation_attempts_paymentTransactionId_idempotencyKey_key"
ON "payment_reconciliation_attempts"("paymentTransactionId", "idempotencyKey");

CREATE INDEX "payment_reconciliation_attempts_paymentTransactionId_requestedAt_idx"
ON "payment_reconciliation_attempts"("paymentTransactionId", "requestedAt");

CREATE INDEX "payment_reconciliation_attempts_outcome_requestedAt_idx"
ON "payment_reconciliation_attempts"("outcome", "requestedAt");

ALTER TABLE "payment_reconciliation_attempts"
ADD CONSTRAINT "payment_reconciliation_attempts_paymentTransactionId_fkey"
FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_reconciliation_attempts"
ADD CONSTRAINT "payment_reconciliation_attempts_superadminId_fkey"
FOREIGN KEY ("superadminId") REFERENCES "superadmin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
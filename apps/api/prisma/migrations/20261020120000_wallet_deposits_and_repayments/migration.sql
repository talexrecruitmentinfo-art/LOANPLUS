CREATE UNIQUE INDEX "payment_transactions_one_pending_wallet_deposit_per_user"
ON "payment_transactions" ("userId")
WHERE "type" = 'WALLET_DEPOSIT' AND "status" = 'PENDING';

ALTER TABLE "repayments"
ADD COLUMN "outstandingAfterKes" INTEGER;

ALTER TABLE "repayments"
ADD COLUMN "loanStatusAfter" "LoanStatus";

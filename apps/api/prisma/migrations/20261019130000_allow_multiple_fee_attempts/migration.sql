DROP INDEX "payment_transactions_loanApplicationId_key";

CREATE INDEX "payment_transactions_loanApplicationId_createdAt_idx"
ON "payment_transactions"("loanApplicationId", "createdAt");

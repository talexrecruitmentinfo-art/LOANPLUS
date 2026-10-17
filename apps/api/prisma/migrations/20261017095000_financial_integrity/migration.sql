ALTER TABLE "payment_transactions"
    ADD CONSTRAINT "payment_transactions_positive_amount" CHECK ("amountKes" > 0);

ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_single_sided_positive_amount"
    CHECK (("debitKes" > 0 AND "creditKes" = 0) OR ("creditKes" > 0 AND "debitKes" = 0));

ALTER TABLE "loan_products"
    ADD CONSTRAINT "loan_products_valid_principal_range"
    CHECK ("minimumPrincipalKes" > 0 AND "maximumPrincipalKes" >= "minimumPrincipalKes");

ALTER TABLE "loans"
    ADD CONSTRAINT "loans_valid_outstanding_balance"
    CHECK ("totalRepayableKes" > 0 AND "outstandingKes" >= 0 AND "outstandingKes" <= "totalRepayableKes");

ALTER TABLE "repayment_schedules"
    ADD CONSTRAINT "repayment_schedules_positive_due_amount"
    CHECK ("principalDueKes" >= 0 AND "chargesDueKes" >= 0 AND "amountDueKes" > 0 AND "amountDueKes" = "principalDueKes" + "chargesDueKes");

ALTER TABLE "repayments"
    ADD CONSTRAINT "repayments_positive_allocated_amount"
    CHECK ("principalPaidKes" >= 0 AND "chargesPaidKes" >= 0 AND "amountKes" > 0 AND "amountKes" = "principalPaidKes" + "chargesPaidKes");

ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_positive_amount" CHECK ("amountKes" > 0);

ALTER TABLE "referral_rewards"
    ADD CONSTRAINT "referral_rewards_positive_amount" CHECK ("amountKes" > 0);
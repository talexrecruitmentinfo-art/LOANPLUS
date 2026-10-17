ALTER TABLE "users"
    ADD COLUMN "referralCode" VARCHAR(24);

CREATE UNIQUE INDEX "users_referralCode_key"
    ON "users"("referralCode");

DROP INDEX "referrals_code_key";

CREATE INDEX "referrals_code_idx"
    ON "referrals"("code");
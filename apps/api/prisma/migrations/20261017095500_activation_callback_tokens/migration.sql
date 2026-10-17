ALTER TABLE "activation_payment_requests"
    ADD COLUMN "callbackTokenHash" VARCHAR(64);

CREATE UNIQUE INDEX "activation_payment_requests_callbackTokenHash_key"
    ON "activation_payment_requests"("callbackTokenHash");
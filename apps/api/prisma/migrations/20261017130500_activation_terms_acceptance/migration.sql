ALTER TABLE "activation_payment_requests"
ADD COLUMN "termsAcceptedVersion" VARCHAR(40),
ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);

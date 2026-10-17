-- CreateEnum
CREATE TYPE "ActivationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "LoanApplicationStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'ADDITIONAL_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'ACCEPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('DISBURSEMENT_PENDING', 'DISBURSED', 'REPAYMENT_IN_PROGRESS', 'REPAID', 'OVERDUE', 'CANCELLED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "activationStatus" "ActivationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "loan_products" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "minimumPrincipalKes" INTEGER NOT NULL,
    "maximumPrincipalKes" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "interestRateBps" INTEGER NOT NULL,
    "flatFeeKes" INTEGER NOT NULL DEFAULT 0,
    "eligibilityRules" JSONB NOT NULL DEFAULT '{}',
    "termsVersion" VARCHAR(40) NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "requestedPrincipalKes" INTEGER NOT NULL,
    "approvedPrincipalKes" INTEGER,
    "approvedChargesKes" INTEGER,
    "status" "LoanApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "applicationData" JSONB NOT NULL DEFAULT '{}',
    "decisionReason" VARCHAR(1000),
    "requestedInformation" VARCHAR(1000),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "offerExpiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "loan_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "principalKes" INTEGER NOT NULL,
    "chargesKes" INTEGER NOT NULL,
    "totalRepayableKes" INTEGER NOT NULL,
    "outstandingKes" INTEGER NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'DISBURSEMENT_PENDING',
    "acceptedTermsVersion" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disbursedAt" TIMESTAMP(3),
    "repaidAt" TIMESTAMP(3),

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loan_products_isAvailable_name_idx" ON "loan_products"("isAvailable", "name");

-- CreateIndex
CREATE INDEX "loan_applications_userId_submittedAt_idx" ON "loan_applications"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "loan_applications_status_submittedAt_idx" ON "loan_applications"("status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "loans_applicationId_key" ON "loans"("applicationId");

-- CreateIndex
CREATE INDEX "loans_userId_status_idx" ON "loans"("userId", "status");

-- AddForeignKey
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_productId_fkey" FOREIGN KEY ("productId") REFERENCES "loan_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "superadmin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

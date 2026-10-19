WITH eligible_applications AS (
  SELECT
    application."id",
    application."userId",
    application."approvedPrincipalKes",
    application."approvedChargesKes",
    snapshot."termsVersion"
  FROM "loan_applications" AS application
  JOIN "users" AS customer ON customer."id" = application."userId"
  CROSS JOIN LATERAL (
    SELECT
      application."approvedTermsSnapshot" ->> 'productName' AS "productName",
      application."approvedTermsSnapshot" ->> 'termsVersion' AS "termsVersion",
      CASE
        WHEN jsonb_typeof(application."approvedTermsSnapshot" -> 'durationDays') = 'number'
          AND (application."approvedTermsSnapshot" ->> 'durationDays') ~ '^[0-9]+$'
        THEN (application."approvedTermsSnapshot" ->> 'durationDays')::numeric
      END AS "durationDays",
      CASE
        WHEN jsonb_typeof(application."approvedTermsSnapshot" -> 'interestRateBps') = 'number'
          AND (application."approvedTermsSnapshot" ->> 'interestRateBps') ~ '^[0-9]+$'
        THEN (application."approvedTermsSnapshot" ->> 'interestRateBps')::numeric
      END AS "interestRateBps",
      CASE
        WHEN jsonb_typeof(application."approvedTermsSnapshot" -> 'flatFeeKes') = 'number'
          AND (application."approvedTermsSnapshot" ->> 'flatFeeKes') ~ '^[0-9]+$'
        THEN (application."approvedTermsSnapshot" ->> 'flatFeeKes')::numeric
      END AS "flatFeeKes",
      CASE
        WHEN jsonb_typeof(application."approvedTermsSnapshot" -> 'approvedPrincipalKes') = 'number'
          AND (application."approvedTermsSnapshot" ->> 'approvedPrincipalKes') ~ '^[0-9]+$'
        THEN (application."approvedTermsSnapshot" ->> 'approvedPrincipalKes')::numeric
      END AS "approvedPrincipalKes",
      CASE
        WHEN jsonb_typeof(application."approvedTermsSnapshot" -> 'approvedChargesKes') = 'number'
          AND (application."approvedTermsSnapshot" ->> 'approvedChargesKes') ~ '^[0-9]+$'
        THEN (application."approvedTermsSnapshot" ->> 'approvedChargesKes')::numeric
      END AS "approvedChargesKes",
      CASE
        WHEN jsonb_typeof(application."approvedTermsSnapshot" -> 'totalRepayableKes') = 'number'
          AND (application."approvedTermsSnapshot" ->> 'totalRepayableKes') ~ '^[0-9]+$'
        THEN (application."approvedTermsSnapshot" ->> 'totalRepayableKes')::numeric
      END AS "totalRepayableKes"
  ) AS snapshot
  WHERE application."status" = 'APPROVED'
    AND application."reviewerId" IS NOT NULL
    AND application."reviewedAt" IS NOT NULL
    AND application."approvedPrincipalKes" > 0
    AND application."approvedChargesKes" >= 0
    AND application."approvedPrincipalKes" <= application."requestedPrincipalKes"
    AND customer."isActive" = true
    AND customer."identityStatus" = 'VERIFIED'
    AND jsonb_typeof(application."approvedTermsSnapshot") = 'object'
    AND snapshot."productName" IS NOT NULL
    AND length(trim(snapshot."productName")) > 0
    AND snapshot."termsVersion" IS NOT NULL
    AND length(trim(snapshot."termsVersion")) > 0
    AND snapshot."durationDays" >= 1
    AND snapshot."interestRateBps" >= 0
    AND snapshot."flatFeeKes" >= 0
    AND snapshot."approvedPrincipalKes" = application."approvedPrincipalKes"
    AND snapshot."approvedChargesKes" = application."approvedChargesKes"
    AND snapshot."totalRepayableKes" = application."approvedPrincipalKes" + application."approvedChargesKes"
    AND application."approvedChargesKes" =
      ceil(application."approvedPrincipalKes" * snapshot."interestRateBps" / 10000) + snapshot."flatFeeKes"
    AND EXISTS (
      SELECT 1
      FROM "payment_transactions" AS fee
      WHERE fee."loanApplicationId" = application."id"
        AND fee."userId" = application."userId"
        AND fee."type" = 'LOAN_PROCESSING_FEE'
        AND fee."status" = 'CONFIRMED'
        AND fee."amountKes" = 50
        AND fee."currency" = 'KES'
        AND fee."receiptReference" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "loans" AS existing
      WHERE existing."userId" = application."userId"
        AND existing."status" IN ('DISBURSEMENT_PENDING', 'DISBURSED', 'REPAYMENT_IN_PROGRESS', 'OVERDUE')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "loan_applications" AS another
      WHERE another."userId" = application."userId"
        AND another."status" = 'APPROVED'
        AND another."id" <> application."id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "loans" AS existing_application_loan
      WHERE existing_application_loan."applicationId" = application."id"
    )
),
created_loans AS (
  INSERT INTO "loans" (
    "id",
    "applicationId",
    "userId",
    "principalKes",
    "chargesKes",
    "totalRepayableKes",
    "outstandingKes",
    "status",
    "acceptedTermsVersion",
    "createdAt"
  )
  SELECT
    'legacy-approved-' || eligible."id",
    eligible."id",
    eligible."userId",
    eligible."approvedPrincipalKes",
    eligible."approvedChargesKes",
    eligible."approvedPrincipalKes" + eligible."approvedChargesKes",
    eligible."approvedPrincipalKes" + eligible."approvedChargesKes",
    'DISBURSEMENT_PENDING',
    eligible."termsVersion",
    now()
  FROM eligible_applications AS eligible
  RETURNING "applicationId"
)
UPDATE "loan_applications" AS application
SET "status" = 'WAITING_FOR_DISBURSEMENT'
FROM created_loans AS created
WHERE application."id" = created."applicationId";

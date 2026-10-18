# Initial Operations Notes

## Development services

Docker Compose starts PostgreSQL 16 and Redis 7 for local development only. The credentials in Compose are explicitly local placeholders. Do not reuse them outside a developer machine.

The `app` Compose profile builds the Next.js and NestJS containers. It runs migrations before starting the API; for production, run migrations as a separately authorized deployment step rather than relying on application replicas to migrate concurrently.

In restricted Docker-outside-of-Docker environments, peer-container networking may be unavailable even when published host ports work. The default `DATABASE_HOST=postgres` uses normal Compose service DNS; only when required by that environment, set `DATABASE_HOST=host.docker.internal` and ensure the DB port is securely published. Do not use the host-gateway override in a normal production deployment.

## Local database environment

The repository's local environment pattern is a root `.env` copied from `.env.example`; `.env` is ignored by Git. The Prisma schema resolves `DATABASE_URL` and `DIRECT_URL` from the process environment. For Codespaces, configure both as Codespaces secrets/environment variables so they are injected into terminal processes. For local commands, make sure the variables are exported in the shell before invoking Prisma; do not paste their values into command history. Do not put connection strings in `prisma/schema.prisma`: the datasource must use `env("DATABASE_URL")` and `env("DIRECT_URL")`.

- `DATABASE_URL` is the API/runtime connection. For Supabase, use the transaction pooler on port `6543`, with the project-specific username `postgres.kgvsekredvzepeewocxl` and provider-recommended runtime options such as `pgbouncer=true`.
- `DIRECT_URL` is Prisma's migration connection. It can use either the project's direct database endpoint on port `5432` (username `postgres`) or the Supabase session pooler on port `5432` (username `postgres.kgvsekredvzepeewocxl`). The session-pooler hostname contains `.pooler.supabase.com`; this is supported and is not treated as an invalid endpoint. Both variables should target the `postgres` database.

The API package supplies a no-connect preflight:

```sh
pnpm --filter @loanplus/api db:preflight
```

It reports presence and URL syntax, hostname, port, database name, expected Supabase username format, pooler classification, password presence, and whether URL-reserved password characters may need encoding. It never prints credentials or attempts a database connection. It checks that `DATABASE_URL` uses the transaction pooler on port `6543` and that `DIRECT_URL` uses either the expected direct host or a Supabase session-pooler host on port `5432`; it also verifies the project and database targets. URL-encode reserved characters in passwords. A successful preflight verifies configuration only, not DNS resolution, network access, credentials, or database connectivity.

For Supabase project `kgvsekredvzepeewocxl`, the expected `DATABASE_URL` username is `postgres.kgvsekredvzepeewocxl`. A direct `DIRECT_URL` endpoint uses host `db.kgvsekredvzepeewocxl.supabase.co` and username `postgres`; a session-pooler `DIRECT_URL` uses the pooler hostname and username `postgres.kgvsekredvzepeewocxl`. Use the connection modes and values shown in the project's Supabase **Connect** dialog; do not substitute a guessed host or username.

The migration status and read-only database diagnostic are separate commands that do connect:

```sh
pnpm --filter @loanplus/api exec prisma migrate status
pnpm --filter @loanplus/api db:diagnose
```

Prisma uses `DATABASE_URL` for the runtime datasource and `DIRECT_URL` for direct migration connections, as configured in `apps/api/prisma/schema.prisma`. Add or update each Codespaces secret separately in the repository's **Settings > Secrets and variables > Codespaces** page; do not replace unrelated secrets. Rebuild/restart the Codespace so updated values are available to terminal processes, then run the preflight again. Do not paste connection strings into commands, shell history, logs, or source files.

## Render API deployment

The repository uses pnpm 12.3.4 (`packageManager` in the root manifest and `pnpm-lock.yaml`). Configure the existing Render Node web service with root directory `.` and Node `24.21.0`. Do not use `yarn` as the build command. Set:

```sh
# Build command
corepack enable && corepack prepare pnpm@12.3.4 --activate && pnpm install --frozen-lockfile && pnpm --filter @loanplus/api db:generate && pnpm --filter @loanplus/api build

# Pre-deploy command (run migrations only through this reviewed deployment step)
pnpm --filter @loanplus/api db:deploy

# Start command
pnpm --filter @loanplus/api start:prod
```

Set the Render health check path to `/api/v1/health/ready`. `/api/v1/health` reports process health only; `/api/v1/health/ready` makes a minimal `SELECT 1` query via the runtime Prisma client and returns only a generic healthy/unavailable response. The service binds to `0.0.0.0` and uses Render's `PORT` value, with `API_PORT` retained as the local fallback. The pre-deploy migration command needs both database connection variables and a Render plan that supports pre-deploy commands; otherwise run the same migration command manually as an authorized deployment step before starting the release. Never run migrations from every application instance at startup.

Release verification is separate from health and financial reconciliation. `GET /api/v1/health/version` returns `{ releaseId, source }` using a valid `APP_RELEASE_SHA` override or Render's `RENDER_GIT_COMMIT`; otherwise it returns `releaseId: "unknown"`. The Vercel frontend exposes `GET /api/release` using `APP_RELEASE_SHA` or `VERCEL_GIT_COMMIT_SHA`, also with an explicit unknown fallback. Both endpoints validate a hexadecimal 7–40 character SHA and return no other environment data. After an authorized deployment, compare these API/frontend identifiers with the intended Git commit and Render/Vercel deployment records; if either is unknown, use the hosting provider deployment metadata. HTTP health 200 alone does not establish release parity, database reconciliation, or payment resolution.

For an authorized, read-only deployment check, run the following against the known public origins. These requests do not change application or financial state; `/health/ready` performs only `SELECT 1` against the API database connection.

```sh
curl --fail --silent --show-error --header 'Cache-Control: no-cache' https://loanplus-api.onrender.com/api/v1/health
curl --fail --silent --show-error --header 'Cache-Control: no-cache' https://loanplus-api.onrender.com/api/v1/health/ready
curl --fail --silent --show-error --header 'Cache-Control: no-cache' https://loanplus-api.onrender.com/api/v1/health/version
curl --fail --silent --show-error --header 'Cache-Control: no-cache' https://loanplus-mnfs.vercel.app/api/release
```

Confirm the reported API and frontend release IDs independently against the intended commit and their respective Render/Vercel deployment records. In Vercel project settings, verify `NEXT_PUBLIC_API_URL` is the public API base `https://loanplus-api.onrender.com/api/v1`; this build-time public value is not a credential. The repository does not expose that Vercel environment value through a public endpoint, so do not infer it from the frontend release response. A health response or matching release IDs do not prove payment-provider connectivity, financial settlement, or database migration parity.

Render service settings are not defined by a Render manifest in this repository. Treat the commands above as the intended configuration, not proof of the live service settings; verify the service's **Pre-Deploy Command** in the Render dashboard before relying on automatic migration deployment.

Configure `NODE_ENV=production`, `DATABASE_URL`, `DIRECT_URL`, `WEB_ORIGIN`, `ID_ENCRYPTION_KEY_BASE64`, `ID_HASH_KEY`, `OTP_HASH_KEY`, `TERMS_VERSION`, `PRIVACY_VERSION`, `SUPERADMIN_EMAIL`, `SUPERADMIN_EMAIL_VERIFIED`, `RESEND_API_KEY`, and `RESEND_FROM` as Render environment values. For Supabase project `kgvsekredvzepeewocxl`, use its transaction-pooler URL on port `6543` as `DATABASE_URL` for application runtime connections, and either the direct database endpoint or session-pooler URL on port `5432` as `DIRECT_URL` for Prisma migration commands. The Prisma schema's `url` maps to `DATABASE_URL`; `directUrl` maps to `DIRECT_URL`. Configure both as Render secrets; never print them or pass them as build arguments.

Applicant registration specifically requires:

- `ID_HASH_KEY`: independent random secret of at least 32 bytes, used as the HMAC key to protect the National ID lookup digest. Missing or undersized values cause the generic “A required security setting is unavailable” 500 during registration.
- `ID_ENCRYPTION_KEY_BASE64`: base64 encoding of exactly 32 random bytes, used for authenticated encryption of the National ID. Missing or invalid values cause the same generic 500 later in registration.
- `TERMS_VERSION` and `PRIVACY_VERSION`: set only to owner/legal-approved versions that exactly identify the published documents; the values are stored with consent records. Missing or `draft-` values block registration in production. The API rejects missing values and values beginning with `draft-`, but does not validate version syntax, verify approval, or match a value to the published page. A non-draft value alone is not evidence of approval.
- `DATABASE_URL`: reachable application/runtime PostgreSQL connection; required for lookup and transactional account/session/consent writes.
- `WEB_ORIGIN`: exact deployed frontend origin for CORS and same-origin checks. For `loanplus-mnfs`, confirm `https://loanplus-mnfs.vercel.app` in Vercel Settings > Domains and configure exactly that origin (no path or trailing slash). A mismatch blocks browser registration.
- `NODE_ENV=production`: ensures production cookies are Secure and cross-site compatible.

`DIRECT_URL` is required for Prisma migration commands but is not used for applicant registration queries. `OTP_HASH_KEY` is for Superadmin OTP, not applicant registration. Resend is used for mail flows, but registration does not send a verification email. Keep all secrets in Render's environment settings. Do not replace missing values with defaults, sample values, or credentials from `.env.example`. Render provides `PORT`; do not hardcode it.

## Terms and privacy documents: owner review required

The customer-facing [Terms and Conditions](../apps/web/src/app/terms/page.tsx) and [Privacy Policy](../apps/web/src/app/privacy/page.tsx) are drafts pending owner and legal/compliance review. They are not legal approval, a production-ready customer contract, or evidence of a licence, registration, or regulatory approval. The example environment uses `TERMS_VERSION=draft-v1` and `PRIVACY_VERSION=draft-v1` for development only; do not copy these values into production.

Before collecting real customer data, onboarding applicants, enabling lending, or enabling live payments:

- Complete every bracketed owner-input item in both pages. In particular, confirm the contracting/controller entity and registration details, service and privacy contacts, registered address, eligibility/age rules, regulatory/licensing status and applicability, complaint and escalation process, and final approval/effective dates.
- Have Kenyan legal/compliance reviewers verify the terms against actual loan offers, repayment operations, all product charges, the KSh 50 loan processing-fee and refund disclosures, disbursement, collection practices, and applicable consumer and financial-services requirements. The customer repayment collection flow is not currently implemented; repayment schedules and records exist in the data model, so confirm the actual operational contract before launch.
- Have the privacy reviewer confirm purposes and lawful bases, actual processors and recipients, processing/cross-border locations and safeguards, any required controller/processor registration or DPO/impact assessment, retention and deletion schedule, rights-handling workflow, cookie disclosure, and incident/breach process. The implementation includes personal, identity, loan, payment, referral, support, authentication, and audit data; it does not currently perform identity-document verification or credit-reference bureau checks.
- Resolve implementation gaps before offering loans or live payments: confirm the customer application, offer-acceptance, and fee-accounting configuration against the approved operational policy; no customer repayment collection flow or in-app refund workflow exists, and uncertain M-Pesa initiations have no scheduled reconciliation worker. The customer referral API should expose only the name and referral status needed by its screen.
- Establish a customer privacy-rights request process and confirm session-cookie/CSRF protections for all browser state-changing endpoints before production. The customer and administrator sessions use cross-site cookies in production; the current controller origin checks accept requests when the `Origin` header is absent, so they do not enforce an origin check for every such request.
- Publish the reviewed documents, assign each the exact approved version and effective date, and update the corresponding production environment variables to those approved version identifiers. Keep the registration validation in place: missing or `draft-` policy versions intentionally block production registration. Version identifiers are not a substitute for approval or for publishing the matching documents.

The draft pages display document version `1.0` for both policies; this is an editorial draft identifier only, not an approved production `TERMS_VERSION` or `PRIVACY_VERSION`. The owner has supplied 15 October 2026 as a proposed effective date. Neither the date nor draft identifiers are evidence that qualified Kenyan counsel approved the exact policy text; both pages remain drafts. Do not configure these values in production unless the exact documents and effective dates have been formally approved, then published, and the configured values identify the published text.

The owner identifies Airswif as the legal entity for the draft and supplied company reference `PVT_2451`; its official registration number, jurisdiction, and legal status have not been independently verified. Owner-supplied contact information for the draft is RNG Plaza, 2nd Floor, Nairobi, Kenya; loanplus.info@gmail.com; and +254107052973. Verify the business address and contacts before publication; the address is not confirmed as the registered office. Lending authorization, contact monitoring and service hours remain unverified. Loan product limits and referral rewards must not be represented as available or charged based only on an unapproved proposal. The application processing fee is KSh 50; it is not an account activation fee or wallet funding.

The registration API logs only the failing security variable name or a generic database/unexpected dependency classification, with a per-request correlation ID. Registration responses include that ID in the `X-Request-Id` header so an applicant can provide it to an operator. Logs do not include environment values, connection URLs, query parameters, request bodies, or exception messages. The client receives a generic response for security-key failures and database errors.

The API's read-only database diagnostic compares application tables and migration records against the checked-in schema and migration directory names:

```sh
pnpm --filter @loanplus/api db:diagnose
```

It requires `DATABASE_URL` in the process environment (and never prints its value). It queries PostgreSQL catalogs and, only if present, `_prisma_migrations`; it does not create or modify database objects or rows. It reports missing tables, whether the migration table exists, exact pending migration directory names, and failed migration names. A missing `_prisma_migrations` table is reported explicitly rather than assumed to exist. If migrations are pending, first review the exact files and take a verified backup; then run the existing `pnpm --filter @loanplus/api db:deploy` only as an authorized, reviewed production deployment step. Do not use `migrate reset`, `db push`, or automatic startup migrations against production.

In the Vercel project's Production environment, set the public build-time variable:

```text
NEXT_PUBLIC_API_URL=https://loanplus-api.onrender.com/api/v1
```

`NEXT_PUBLIC_API_URL` is the only frontend API URL variable read by the web app. It is public and is compiled into the browser bundle; it must contain no credentials. API calls append endpoint paths such as `/auth/login` to this base, so include `/api/v1` exactly once in the variable and do not add another API URL variable. Leave the `.env.example` localhost values unchanged for local development. Vercel environment changes require a new deployment/build to take effect. Do not configure Preview deployments to use production unless that is intentional.

The web app makes its API requests from client-side pages with `credentials: 'include'`. Since the default Vercel and Render hostnames are cross-site, production authentication cookies use `SameSite=None; Secure`; local development keeps `SameSite=Strict`. Credentialed CORS remains limited to the exact `WEB_ORIGIN`. Browser privacy settings that block third-party cookies may still prevent sessions on the default cross-site hostnames; a same-site custom frontend/API domain pair is the reliable option where that restriction matters.

For the confirmed LoanPlus Safaricom production configuration, use `MPESA_ENVIRONMENT=production`, `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline`, `MPESA_SHORT_CODE=5526990`, and `MPESA_TILL_NUMBER=3400188`. Daraja's `BusinessShortCode` and STK password use `MPESA_SHORT_CODE`; `PartyB` uses the separate `MPESA_TILL_NUMBER`. STK Query also uses `MPESA_SHORT_CODE`. The API validates these destination values and all credentials while live payments are disabled, then reports `MPESA_LIVE_ENABLED` as the remaining gate only if configuration is complete. Keep `MPESA_LIVE_ENABLED=false` until authorized production verification is complete. Set `MPESA_PASSKEY` to the passkey Safaricom associated with the STK BusinessShortCode; keep it, `MPESA_CONSUMER_KEY`, and `MPESA_CONSUMER_SECRET` in Render secrets. The code uses Daraja's production OAuth, STK Push, and STK Query endpoints; it does not invoke a provider during availability checks.

For the production LoanPlus Render API, set `MPESA_CALLBACK_URL=https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback` exactly, without a token, query, fragment, or port. This is the STK Push callback base. Nest applies the global `api/v1` prefix and `PaymentController` handles `POST /payments/mpesa/callback/:token`, so the deployed route is `POST https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback/<per-payment-token>`. The API appends the unique opaque token to the configured base and sends that URL in Safaricom's STK `CallBackURL`. Production configuration is restricted to the HTTPS `loanplus-api.onrender.com` host and this exact route; localhost, IP literals, private/local hostnames, the configured frontend origin, and unrelated paths are rejected. Loan processing-fee initiation reports missing or invalid configuration without returning secret values and keeps provider availability failures distinct. Do not include the per-payment token in Render.

This STK URL is not a C2B URL. C2B v2 validation and confirmation routes/processing are separate and are not implemented in this repository; do not register the STK callback as either C2B endpoint or claim C2B v2 is supported. Do not enable live processing until Daraja credentials, provider-side callback delivery, customer policy, and payment reconciliation have been verified. `REDIS_URL` and `DATABASE_HOST` are not read by the API application.

New applications use the KSh 50 loan processing fee. No customer account activation fee is collected. The fee is initiated only after the authenticated customer has saved and reviewed an application draft and is posted from the M-Pesa clearing asset to the configured KES processing-fee revenue account; it is never wallet funding. A draft becomes submitted only within the transaction that records authoritative payment confirmation and balanced ledger entries. Configure `loan.processing_fee_revenue_account` to an active KES revenue account before allowing fee collection.

The fee flow calls Daraja STK Push at `/mpesa/stkpush/v1/processrequest` and STK Query at `/mpesa/stkpushquery/v1/query`. An accepted initiation is only a request acceptance and leaves the payment pending. STK Query result `0` alone does not settle a payment; a token-bound callback must match the saved checkout/merchant IDs, be reconciled with a successful STK Query, and contain the expected KES 50 amount, encrypted-phone match, and valid receipt before the receipt is persisted and settlement proceeds. Query result `4999`, all other nonzero result codes without a verified source-specific mapping, network failures, and temporary provider errors remain unresolved. The code does not map unverified nonzero results to a final failure, cancellation, or expiration; do not retry while an outcome is uncertain. Callback bodies are not cryptographic signatures, so the opaque callback token and authoritative provider query are required. Callback history, payment outcome, receipt, balanced ledger entries, application submission, and audit event are committed transactionally. Duplicate callbacks cannot post duplicate financial effects. Historical activation payments remain identifiable for reconciliation and are not rewritten to processing-fee purpose; no new activation payment can be initiated.

The Superadmin reconciliation queue at `GET /api/v1/admin/payment-reconciliation` is cursor-paginated (1–100 rows), supports exact internal-reference search, and can show all unresolved rows, aged pending rows, legacy `4999` rows, or provider-review exceptions. Legacy `4999` and active provider-review exceptions remain included regardless of age. It returns sanitized transaction/provider identifiers, callback summaries, recent investigation attempts, the queue-inclusion reason, and no customer name or email. `POST /api/v1/admin/payment-reconciliation/:paymentId/refresh` is limited to five requests per minute and requires an idempotency key and investigation note; a query-only success remains pending for a verified callback. `POST /api/v1/admin/payment-reconciliation/:paymentId/escalate` records an audited escalation without changing payment state. There is intentionally no operator endpoint that manually marks a payment successful or failed: a nonzero result remains unresolved until Safaricom result semantics and the approved resolution policy are verified.

The wallet balance is derived from posted customer-liability ledger entries, not a separate balance column. The KSh 50 loan processing fee is credited to the configured revenue account, not the customer's wallet. Historical activation settlements are retained for reconciliation and preserve their original accounting treatment. No wallet credit may be made from a processing-fee initiation or an inconclusive provider result.

Loan approvals now store the approved product name, terms version, duration, pricing inputs, approved principal, charges, and total repayment amount on the application. Offer acceptance records that approved version, and disbursement scheduling uses its stored duration rather than mutable product settings. Before deploying code that reads or writes the new workflow, review and apply the additive migrations `20261018120000_loan_offer_terms_snapshot`, `20261018120800_loan_processing_fee`, and `20261018120900_defer_loan_submission_timestamp` through the authorized migration procedure. The submission timestamp is nullable so an unpaid draft is not represented as submitted. Existing approved offers and accepted loans without a snapshot are deliberately blocked from acceptance/disbursement because the historical offer duration and terms cannot be reconstructed safely from a currently editable product; reconcile those records against approved source documents before enabling this code on a database containing such records.

The customer PWA uses `/manifest.webmanifest`, raster 192/512 PNG icons, and an Apple touch icon. Its service worker caches only same-origin Next static assets, public icons, and the manifest; it does not cache API routes, authenticated responses, wallet data, sessions, or payment data. App installation requires HTTPS outside localhost and browser support; iOS users use Safari's Share > Add to Home Screen flow. The authenticated `/platform/pwa/eligibility` response is controlled by the audited Superadmin platform setting; disabling it hides the LoanPlus install entry and does not uninstall existing device installations.

Platform currency defaults to KES/KSh (`en-KE`, zero decimals). The existing wallet, ledger, loan, and M-Pesa workflows, plus historical activation-payment reconciliation, are KES-only, so `/api/v1/admin/settings/platform/currency` accepts only KES. USD, EUR, GBP, UGX, and TZS are deliberately unavailable until currency-aware transaction and ledger accounting is implemented. Display settings never convert or rewrite historical financial data. Platform setting changes use existing `SystemSetting` rows and transactional `AdminAuditLog` records; no schema migration is required.

C2B v2 validation/confirmation URLs and C2B transaction processing are not implemented in this repository. Do not configure or use C2B v2 to accept customer payments until separate matching, validation, confirmation, idempotency, and ledger processing are implemented and tested.

### Daraja sandbox verification

Use a separate staging API and an isolated PostgreSQL test/staging database; never point the sandbox exercise at production customer or ledger data. Configure these API variables on the staging Render service using credentials created in the Daraja sandbox application:

- `MPESA_ENVIRONMENT=sandbox`
- `MPESA_LIVE_ENABLED=false`
- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORT_CODE`
- `MPESA_TILL_NUMBER` (only when testing `CustomerBuyGoodsOnline`)
- `MPESA_PASSKEY`
- `MPESA_CALLBACK_URL=https://<staging-api-host>/api/v1/payments/mpesa/callback`

Also configure the staging database and required ID encryption key. Migrations, if needed, may only be applied to the isolated staging database. `MPESA_CALLBACK_URL` is a base path: LoanPlus appends a per-payment opaque token and sends the resulting HTTPS URL as the STK `CallBackURL`; do not put a token in Render settings. No C2B callback registration is used for this STK flow.

After staging is isolated and configured, deploy the candidate API there and configure an active KES M-Pesa clearing account plus the approved KES processing-fee revenue account. Sign in with a staging applicant, create and review a valid loan application, and initiate one Daraja sandbox STK prompt using a sandbox-supported test number. Verify the payment remains `PENDING` immediately after initiation. Confirm the callback reaches the staging route, the server-side STK query returns matching stored checkout and merchant IDs plus success, and the fee changes to `CONFIRMED` with exactly one balanced ledger transaction while the application changes to `SUBMITTED`. Verify that no wallet liability is created. Replay the callback and confirm the payment, ledger, and application remain unchanged. For a nonzero result without a verified Safaricom mapping, confirm the payment stays unresolved and cannot be resubmitted. If query identifiers are absent or differ, the implementation intentionally fails closed and the flow is not verified. Never perform this exercise against the production Render service or with a real customer number.

## Security key generation

Generate independent values and keep them in a secret manager or a local untracked `.env` file. Example commands:

```sh
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
openssl rand -hex 32
```

Use separate outputs for `OTP_HASH_KEY`, `ID_HASH_KEY`, `ID_ENCRYPTION_KEY_BASE64`, and any future session-signing key. The ID encryption value must decode to exactly 32 bytes. Do not put production values in CI logs, images, source control, or build arguments.

## Superadmin bootstrap

Set `SUPERADMIN_EMAIL` to an operator-controlled, verified mailbox and set `SUPERADMIN_EMAIL_VERIFIED=true` only after the operator confirms mailbox ownership. To provision an initial account, securely load the intended database's `DATABASE_URL` plus these two settings into the operator shell, then run `pnpm --filter @loanplus/api superadmin:bootstrap` from an interactive terminal and enter the password at its hidden prompt. The command uses `DATABASE_URL` through Prisma Client; `DIRECT_URL` is not used for bootstrap. It normalizes the configured email, hashes the password with bcrypt (cost 12), and creates an active `SUPERADMIN` record with its email marked verified. It refuses to create a duplicate or modify any existing account, so it cannot be used to reset an existing password. Never pass the password as a command-line argument or put secrets in shell history. Public Superadmin registration is not provided. `OTP_HASH_KEY`, `RESEND_API_KEY`, and `RESEND_FROM` are needed for login/OTP delivery, not for account creation; configure Resend before the first login, as an email delivery failure denies sign-in.

For Render Superadmin sign-in, configure `SUPERADMIN_EMAIL`, `OTP_HASH_KEY`, `RESEND_API_KEY`, and `RESEND_FROM`. `OTP_HASH_KEY` must be an independent random secret of at least 32 bytes. Add and verify your sending domain in the Resend dashboard, complete its required DNS records, then set `RESEND_FROM` to a valid address on that verified domain (for example, `LoanPlus <no-reply@your-verified-domain>`). Do not use the example domain for real delivery. `SUPERADMIN_EMAIL_VERIFIED` is only required by the one-time bootstrap command; verification is stored on the Superadmin database record and is checked at sign-in. Sign-in also requires the runtime `DATABASE_URL`, exact `WEB_ORIGIN`, and `NODE_ENV=production` for secure cross-site session cookies. `DIRECT_URL` is only for Prisma migration tooling. Never place API secrets in Vercel.

`MailService` uses the Resend HTTPS API for both Superadmin OTP and applicant password-reset emails. It reads `RESEND_API_KEY` and `RESEND_FROM` at send time, validates both, uses a bounded request timeout, and logs only sanitized network/status/configuration diagnostics. It does not log API keys, OTPs, email contents, or provider response bodies. If Resend rejects delivery or is unavailable, the OTP challenge is invalidated and no authenticated session is created. Applicant email/password login continues independently and does not require OTP.

The Superadmin page uses `POST /api/v1/admin/auth/password` to request an email challenge and `POST /api/v1/admin/auth/otp` to verify it. A successful verification sets an HttpOnly `lp_admin_session` cookie; protected access is checked through `GET /api/v1/admin/auth/me`. Vercel Production must have `NEXT_PUBLIC_API_URL=https://loanplus-api.onrender.com/api/v1`; Render `WEB_ORIGIN` must be exactly `https://loanplus-mnfs.vercel.app`. The production build-time API URL is public, not a secret. The API source enforces throttling on both challenge endpoints and limits OTP guesses; production delivery, mailbox receipt, and authenticated access must still be verified after deployment.

## Security boundary

Production Superadmin OTP delivery and authenticated login have not been end-to-end verified. `/api/v1/health/ready` checks only database connectivity, not full application or production readiness. Keep live financial actions disabled until provider callbacks, idempotency, reconciliation, approvals, and audit controls are implemented and reviewed.

The current source includes database-backed customer/admin authentication, manual loan review, manual disbursement confirmation, a balanced ledger poster, and a Daraja STK Push adapter. M-Pesa has only been integration-tested with a mocked provider response. It has not been verified against Daraja sandbox/live credentials. New customer account activation payments are removed. Processing-fee collection remains dependent on the approved customer disclosures, configured revenue and clearing accounts, and a publicly reachable HTTPS callback URL. The Docker example keeps live M-Pesa processing disabled.

Repayment processing, withdrawal/payout workflows, referral reward posting/configuration, production notification delivery, risk scoring/review, and full reporting/export workflows are not implemented. Their database foundations must not be mistaken for live workflows.

## Planned foundation work

1. Database schema and migrations for users, consent, sessions, and audit records.
2. Customer email/password authentication and separate Superadmin password-plus-email-OTP authentication.
3. ID-number-only registration with encryption, masking, and access controls.
4. Provider-backed payments, double-entry ledger, lending, referrals, withdrawals, support, and administrative workflows.
5. Automated security, integration, and end-to-end tests; then deployment and recovery procedures.

## Kenyan digital-credit launch readiness checklist

This is an operational checklist, not legal advice, a compliance assessment, or evidence of a licence. Kenyan counsel and the appropriate regulators must confirm which current laws, regulations, registrations, approvals, and supervisory requirements apply to the actual LoanPlus entity and product. All items remain open until an accountable owner records evidence of completion.

- [ ] **Licensing and regulatory classification:** obtain a documented Kenyan legal assessment of the lending, payment, agency, and platform roles; verify any Central Bank of Kenya licensing, registration, approval, reporting, and ongoing supervisory requirements before offering credit.
- [ ] **Governance and accountability:** identify the responsible legal entity, directors and accountable control owners; approve credit, collections, complaints, outsourcing, incident, and business-continuity policies.
- [ ] **Customer disclosures and fair treatment:** have counsel review the customer terms and each versioned product offer, including eligibility, total cost, the loan processing fee and refund treatment, repayment obligations, consequences of missed payments, disbursement, payment collection, and cancellation; record affirmative acceptance and preserve the accepted version.
- [ ] **Customer complaints and disputes:** provide a working, staffed complaint channel; define internal ownership, escalation, investigation evidence, customer updates, resolution approval, and regulator escalation obligations. Set response targets only after the policy is approved; the current support module is not proof of an operational complaint service.
- [ ] **Privacy and data protection:** document purposes and lawful bases, notices/consents, data minimization, access controls, processors and cross-border transfers, retention/deletion, rights requests, incident response, and any required registrations, assessments, or DPO appointment under applicable Kenyan data-protection requirements.
- [ ] **Credit information handling:** obtain legal confirmation of whether credit-reference-bureau access, furnishing, customer notices/consent, dispute handling, correction, and retention obligations apply; do not represent bureau integrations or reporting as available until implemented and contracted.
- [ ] **AML/CFT and financial-crime controls:** obtain a documented applicability assessment for the entity and payment/lending activities; where obligations apply, approve customer due-diligence, monitoring, sanctions/escalation, suspicious-activity reporting, training, and recordkeeping controls before live operations.
- [ ] **Accounting and customer funds:** approve the chart of accounts and processing-fee/loan accounting treatment; test balanced journals, settlement idempotency, reconciliations, reversals, financial reporting, and access separation against an isolated database and independently reviewed evidence.
- [ ] **Payment-provider and operational readiness:** verify the exact Safaricom product contract, callback/query semantics, merchant configuration, webhook reachability, failure/recovery procedures, incident contacts, and sandbox evidence. Unknown M-Pesa outcomes must remain unresolved; successful HTTP responses are not payment evidence.
- [ ] **Security and access governance:** test Superadmin OTP delivery, staff lifecycle and least-privilege permissions, sensitive-operation approvals, session revocation, secrets handling, vulnerability response, backups, restore, and audit-log access. The current API has only a Superadmin staff role, not the requested Finance, Loan Officer, Support, or Auditor separation.
- [ ] **Record retention and evidence:** approve retention periods for applications, accepted terms, decisions, disbursement/repayment evidence, payment callbacks, reconciliation attempts, complaints, consent, security events, and audit records; verify legal holds, access, export, and secure deletion procedures.
- [ ] **End-to-end lending and servicing:** validate versioned offer terms, application decisions, verified disbursement, repayment collection/allocation, arrears, statements, payoff, complaints, and loan closure with approved business rules. Current repayment collection/allocation and complete servicing are not implemented.
- [ ] **Release and launch approval:** independently verify API and frontend release IDs, environment configuration, migration state, service health, provider configuration, support readiness, and signed legal/compliance/finance/security approvals. Keep production payments and credit offers disabled until all applicable gates are evidenced.
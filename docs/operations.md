# Initial Operations Notes

## Development services

Docker Compose starts PostgreSQL 16 and Redis 7 for local development only. The credentials in Compose are explicitly local placeholders. Do not reuse them outside a developer machine.

The `app` Compose profile builds the Next.js and NestJS containers. It runs migrations before starting the API; for production, run migrations as a separately authorized deployment step rather than relying on application replicas to migrate concurrently.

In restricted Docker-outside-of-Docker environments, peer-container networking may be unavailable even when published host ports work. The default `DATABASE_HOST=postgres` uses normal Compose service DNS; only when required by that environment, set `DATABASE_HOST=host.docker.internal` and ensure the DB port is securely published. Do not use the host-gateway override in a normal production deployment.

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

Set the Render health check path to `/api/v1/health`. The service binds to `0.0.0.0` and uses Render's `PORT` value, with `API_PORT` retained as the local fallback. The pre-deploy migration command needs `DATABASE_URL` and a Render plan that supports pre-deploy commands; otherwise run the same migration command manually as an authorized deployment step before starting the release. Never run migrations from every application instance at startup.

Configure `DATABASE_URL`, `WEB_ORIGIN`, `ID_ENCRYPTION_KEY_BASE64`, `ID_HASH_KEY`, `OTP_HASH_KEY`, `TERMS_VERSION`, `PRIVACY_VERSION`, `SUPERADMIN_EMAIL`, `SUPERADMIN_EMAIL_VERIFIED`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` as Render environment values. Use a production PostgreSQL URL from the existing Supabase project, the exact deployed Vercel origin for `WEB_ORIGIN`, non-draft approved terms/privacy versions, independent generated keys, a verified Superadmin mailbox, and a verified email sender. Render provides `PORT`; do not hardcode it. Configure `NEXT_PUBLIC_API_URL` in Vercel to the API base URL ending in `/api/v1`; it must contain no credentials.

For a separately approved M-Pesa production rollout, the API also reads `MPESA_ENVIRONMENT`, `MPESA_LIVE_ENABLED`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORT_CODE`, `MPESA_PASSKEY`, and `MPESA_CALLBACK_URL`. Keep credentials in Render secrets; set the callback base to the public HTTPS `/api/v1/payments/mpesa/callback` path. Do not enable live processing until Daraja credentials, callback reachability, customer policy, and payment reconciliation have been verified. `REDIS_URL` and `DATABASE_HOST` are not read by the API application.

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

Set `SUPERADMIN_EMAIL` to an operator-controlled, verified mailbox and set `SUPERADMIN_EMAIL_VERIFIED=true` only after the operator confirms mailbox ownership. With database and the OTP/email keys configured, run `pnpm --filter @loanplus/api superadmin:bootstrap` from an interactive terminal and enter the password at its hidden prompt. Public Superadmin registration is not provided. Configure SMTP before the first login; an email delivery failure denies sign-in.

## Security boundary

No production customer authentication, Superadmin OTP delivery, M-Pesa transactions, lending decisions, or financial ledger are active in this foundation. The API health route is not an application-readiness or production-readiness signal. Keep live financial actions disabled until provider callbacks, idempotency, reconciliation, approvals, and audit controls are implemented and reviewed.

The current source includes database-backed customer/admin authentication, manual loan review, manual disbursement confirmation, a balanced ledger poster, and a Daraja STK Push adapter. M-Pesa has only been integration-tested with a mocked provider response. It has not been verified against Daraja sandbox/live credentials. Activation payments remain unavailable until an operator approves the purpose/refundability/accounting/customer disclosure, configures the required ledger accounts, and supplies a publicly reachable HTTPS callback URL. The Docker example keeps live M-Pesa processing disabled.

Repayment processing, withdrawal/payout workflows, referral reward posting/configuration, production notification delivery, risk scoring/review, and full reporting/export workflows are not implemented. Their database foundations must not be mistaken for live workflows.

## Planned foundation work

1. Database schema and migrations for users, consent, sessions, and audit records.
2. Customer email/password authentication and separate Superadmin password-plus-email-OTP authentication.
3. ID-number-only registration with encryption, masking, and access controls.
4. Provider-backed payments, double-entry ledger, lending, referrals, withdrawals, support, and administrative workflows.
5. Automated security, integration, and end-to-end tests; then deployment and recovery procedures.
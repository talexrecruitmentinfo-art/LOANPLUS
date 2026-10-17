# Initial Operations Notes

## Development services

Docker Compose starts PostgreSQL 16 and Redis 7 for local development only. The credentials in Compose are explicitly local placeholders. Do not reuse them outside a developer machine.

The `app` Compose profile builds the Next.js and NestJS containers. It runs migrations before starting the API; for production, run migrations as a separately authorized deployment step rather than relying on application replicas to migrate concurrently.

In restricted Docker-outside-of-Docker environments, peer-container networking may be unavailable even when published host ports work. The default `DATABASE_HOST=postgres` uses normal Compose service DNS; only when required by that environment, set `DATABASE_HOST=host.docker.internal` and ensure the DB port is securely published. Do not use the host-gateway override in a normal production deployment.

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
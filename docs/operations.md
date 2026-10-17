# Initial Operations Notes

## Development services

Docker Compose starts PostgreSQL 16 and Redis 7 for local development only. The credentials in Compose are explicitly local placeholders. Do not reuse them outside a developer machine.

The `app` Compose profile builds the Next.js and NestJS containers. It runs migrations before starting the API; for production, run migrations as a separately authorized deployment step rather than relying on application replicas to migrate concurrently.

## Security boundary

No production customer authentication, Superadmin OTP delivery, M-Pesa transactions, lending decisions, or financial ledger are active in this foundation. The API health route is not an application-readiness or production-readiness signal. Keep live financial actions disabled until provider callbacks, idempotency, reconciliation, approvals, and audit controls are implemented and reviewed.

## Planned foundation work

1. Database schema and migrations for users, consent, sessions, and audit records.
2. Customer email/password authentication and separate Superadmin password-plus-email-OTP authentication.
3. ID-number-only registration with encryption, masking, and access controls.
4. Provider-backed payments, double-entry ledger, lending, referrals, withdrawals, support, and administrative workflows.
5. Automated security, integration, and end-to-end tests; then deployment and recovery procedures.
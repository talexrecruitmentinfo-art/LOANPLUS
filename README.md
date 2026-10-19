# LoanPlus

LoanPlus is a Kenya-focused lending and referral platform. This repository is a pnpm monorepo with a Next.js customer/admin frontend and a NestJS REST API; PostgreSQL is the source of truth and Redis is reserved for background work.

## Status

This repository started as an empty project. The current implementation is the development foundation,production lending system. Financial processing, KYC, M-Pesa, email, and loan decisions must be represented as live until their approved providers, policies, and workflows are implemented and tested.

## Requirements

- Node.js 24
- pnpm 12.3.4
- Docker Compose

## Local development

1. Copy `.env.example` to `.env` and replace development-only secrets.
2. Start PostgreSQL and Redis with `docker compose up -d`.
3. Install dependencies with `pnpm install`.
4. Apply database migrations with `pnpm db:deploy`.
5. Start the apps with `pnpm dev`.

To run the containerized apps, copy `.env.example` to `.env`, configure the required security keys, then run `docker compose --profile app up --build`. The API container applies checked-in Prisma migrations before it starts.

The web app runs at `http://localhost:3000`; the versioned API runs at `http://localhost:4000/api/v1`. API health is available at `/api/v1/health`.

## Workspace

- `apps/web`: responsive Next.js application.
- `apps/api`: NestJS API and Prisma database schema.

## Database

Apply migrations to an existing database with `pnpm db:deploy`. Use `pnpm db:migrate` only for creating a new migration during development. A fresh database can be initialized by running the migrations with `DATABASE_URL` set to that database.

## Security and operations

- Never commit `.env` files, production credentials, or real customer data.
- The `.env.example` values are placeholders, not deployable secrets.
- Do not enable live payment or payout processing without approved customer disclosures, provider credentials, reconciliation procedures, and operational sign-off.
- National ID is a sensitive identifier, not proof of identity verification. No identity-document upload flow is part of this project.
- Before production, complete authentication, authorization, data protection, financial ledger controls, provider integrations, migrations, automated tests, backups, monitoring, and the production-readiness review.

See `docs/operations.md` for the initial operational boundary and implementation notes.
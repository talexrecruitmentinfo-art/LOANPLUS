import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

const EXPECTED_TABLES = [
  'users',
  'consent_records',
  'customer_sessions',
  'password_reset_tokens',
  'superadmin_users',
  'superadmin_otp_challenges',
  'superadmin_sessions',
  'admin_audit_logs',
  'auth_audit_logs',
  'loan_products',
  'loan_applications',
  'loans',
  'loan_disbursements',
  'payment_transactions',
  'activation_payment_requests',
  'payment_callback_events',
  'ledger_accounts',
  'ledger_transactions',
  'ledger_entries',
  'idempotency_records',
  'system_settings',
  'referrals',
  'referral_rewards',
  'withdrawal_requests',
  'repayment_schedules',
  'repayments',
  'support_tickets',
  'support_messages',
] as const;

async function diagnoseDatabase(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const migrationsDirectory = join(__dirname, '..', 'prisma', 'migrations');
    const migrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN (${Prisma.join(EXPECTED_TABLES)})
      ORDER BY tablename
    `;
    const presentTables = new Set(tables.map(({ tablename }) => tablename));
    const [migrationTable] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_tables
        WHERE schemaname = current_schema()
          AND tablename = '_prisma_migrations'
      ) AS "exists"
    `;

    let migrationRows: Array<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
      started_at: Date | null;
    }> = [];

    if (migrationTable.exists) {
      migrationRows = await prisma.$queryRaw`
        SELECT migration_name, finished_at, rolled_back_at, started_at
        FROM "_prisma_migrations"
      `;
    }

    const appliedMigrations = new Set(
      migrationRows
        .filter(({ finished_at, rolled_back_at }) => finished_at !== null && rolled_back_at === null)
        .map(({ migration_name }) => migration_name),
    );
    const pendingMigrations = migrations.filter((migration) => !appliedMigrations.has(migration));
    const failedMigrations = migrationRows
      .filter(({ started_at, finished_at, rolled_back_at }) => started_at !== null && finished_at === null && rolled_back_at === null)
      .map(({ migration_name }) => migration_name);
    const missingTables = EXPECTED_TABLES.filter((table) => !presentTables.has(table));

    console.log(JSON.stringify({
      database: 'reachable',
      expectedTableCount: EXPECTED_TABLES.length,
      missingTables,
      migrationTableExists: migrationTable.exists,
      pendingMigrations,
      failedMigrations,
    }, null, 2));

    if (missingTables.length > 0 || !migrationTable.exists || pendingMigrations.length > 0 || failedMigrations.length > 0) {
      process.exitCode = 1;
    }
  } catch {
    console.error('Read-only database diagnostic failed. Check database connectivity and configuration; no database details were printed.');
    process.exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      console.error('Could not close the diagnostic database connection.');
      process.exitCode = 1;
    }
  }
}

void diagnoseDatabase();

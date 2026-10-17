import {
  diagnoseDatabaseConfiguration,
  validateDatabaseConfiguration,
} from './database-config';

const projectRef = 'kgvsekredvzepeewocxl';
const transactionPoolerHost = 'aws-0-us-east-1.pooler.supabase.com';
const sessionPoolerHost = 'aws-0-us-east-1.pooler.supabase.com';
const directHost = `db.${projectRef}.supabase.co`;

function connectionUrl(
  username: string,
  password: string,
  hostname: string,
  port: number,
  database = 'postgres',
  query = '',
): string {
  return `postgresql://${username}:${password}@${hostname}:${port}/${database}${query}`;
}

function validPoolerEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: connectionUrl(
      `postgres.${projectRef}`,
      'runtime-test-password',
      transactionPoolerHost,
      6543,
      'postgres',
      '?pgbouncer=true',
    ),
    DIRECT_URL: connectionUrl(
      `postgres.${projectRef}`,
      'direct-test-password',
      sessionPoolerHost,
      5432,
    ),
  };
}

describe('validateDatabaseConfiguration', () => {
  it('accepts separate valid PostgreSQL runtime and direct URLs', () => {
    expect(validateDatabaseConfiguration({
      DATABASE_URL: 'postgresql://loanplus:local-password@localhost:5432/loanplus?schema=public',
      DIRECT_URL: 'postgresql://loanplus:local-password@localhost:5432/loanplus?schema=public',
    })).toEqual([]);
  });

  it('reports missing URL variable names without exposing values', () => {
    expect(validateDatabaseConfiguration({})).toEqual([
      'DATABASE_URL is not set',
      'DIRECT_URL is not set',
    ]);
  });

  it('rejects malformed or non-PostgreSQL URLs without echoing them', () => {
    expect(validateDatabaseConfiguration({
      DATABASE_URL: 'not-a-url-with-a-secret',
      DIRECT_URL: 'https://user:secret@example.test/loanplus',
    })).toEqual([
      'DATABASE_URL is not a valid URL',
      'DIRECT_URL must be a PostgreSQL URL with a host, username, and database name',
    ]);
  });
});

describe('diagnoseDatabaseConfiguration', () => {
  it('accepts a transaction pooler and a session pooler for the expected project', () => {
    const diagnostic = diagnoseDatabaseConfiguration(validPoolerEnvironment());

    expect(diagnostic.consistent).toBe(true);
    expect(diagnostic.issues).toEqual([]);
    expect(diagnostic.variables).toMatchObject({
      DATABASE_URL: {
        present: true,
        syntacticallyValid: true,
        hostname: transactionPoolerHost,
        port: '6543',
        database: 'postgres',
        isSupabasePooler: true,
        usernameMatchesExpectedFormat: true,
        passwordPresent: true,
      },
      DIRECT_URL: {
        present: true,
        syntacticallyValid: true,
        hostname: sessionPoolerHost,
        port: '5432',
        database: 'postgres',
        isSupabasePooler: true,
        usernameMatchesExpectedFormat: true,
        passwordPresent: true,
      },
    });
  });

  it('accepts the expected Supabase direct database endpoint', () => {
    const environment = validPoolerEnvironment();
    environment.DIRECT_URL = connectionUrl('postgres', 'direct-test-password', directHost, 5432);

    const diagnostic = diagnoseDatabaseConfiguration(environment);

    expect(diagnostic.consistent).toBe(true);
    expect(diagnostic.issues).toEqual([]);
    expect(diagnostic.variables.DIRECT_URL).toMatchObject({
      hostname: directHost,
      port: '5432',
      isSupabasePooler: false,
      usernameMatchesExpectedFormat: true,
    });
  });

  it('requires the direct endpoint username to be postgres', () => {
    const environment = validPoolerEnvironment();
    environment.DIRECT_URL = connectionUrl(
      `postgres.${projectRef}`,
      'direct-test-password',
      directHost,
      5432,
    );

    const diagnostic = diagnoseDatabaseConfiguration(environment);

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.variables.DIRECT_URL.usernameMatchesExpectedFormat).toBe(false);
    expect(diagnostic.issues).toContain(
      'DIRECT_URL username must be postgres for the expected direct Supabase endpoint',
    );
  });

  it('rejects usernames that do not identify the expected Supabase project', () => {
    const environment = validPoolerEnvironment();
    environment.DATABASE_URL = connectionUrl(
      'postgres.otherproject',
      'runtime-test-password',
      transactionPoolerHost,
      6543,
      'postgres',
      '?pgbouncer=true',
    );
    environment.DIRECT_URL = connectionUrl(
      'postgres.otherproject',
      'direct-test-password',
      sessionPoolerHost,
      5432,
    );

    const diagnostic = diagnoseDatabaseConfiguration(environment);

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.issues).toContain(
      `DATABASE_URL username must be postgres.${projectRef} for the expected Supabase project`,
    );
    expect(diagnostic.issues).toContain(
      `DIRECT_URL username must be postgres.${projectRef} for the expected Supabase project`,
    );
  });

  it('rejects a direct endpoint for a different project', () => {
    const environment = validPoolerEnvironment();
    environment.DIRECT_URL = connectionUrl(
      'postgres',
      'direct-test-password',
      'db.otherproject.supabase.co',
      5432,
    );

    const diagnostic = diagnoseDatabaseConfiguration(environment);

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.issues).toContain(
      'DIRECT_URL host does not confirm the expected Supabase project or a Supabase session pooler',
    );
  });

  it('rejects unsupported runtime and direct ports', () => {
    const environment = validPoolerEnvironment();
    environment.DATABASE_URL = connectionUrl(
      `postgres.${projectRef}`,
      'runtime-test-password',
      transactionPoolerHost,
      5432,
    );
    environment.DIRECT_URL = connectionUrl(
      `postgres.${projectRef}`,
      'direct-test-password',
      sessionPoolerHost,
      6543,
    );

    const diagnostic = diagnoseDatabaseConfiguration(environment);

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.issues).toContain('DATABASE_URL must use transaction-pooler port 6543');
    expect(diagnostic.issues).toContain(
      'DIRECT_URL must use port 5432 for a direct or session-pooler connection',
    );
  });

  it('rejects non-pooler runtime hosts and unsupported direct hosts', () => {
    const environment = validPoolerEnvironment();
    environment.DATABASE_URL = connectionUrl(
      `postgres.${projectRef}`,
      'runtime-test-password',
      'example.test',
      6543,
    );
    environment.DIRECT_URL = connectionUrl(
      `postgres.${projectRef}`,
      'direct-test-password',
      'example.test',
      5432,
    );

    const diagnostic = diagnoseDatabaseConfiguration(environment);

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.issues).toContain(
      'DATABASE_URL host must be a Supabase transaction-pooler endpoint',
    );
    expect(diagnostic.issues).toContain(
      'DIRECT_URL host does not confirm the expected Supabase project or a Supabase session pooler',
    );
  });

  it('reports malformed URLs, missing values, and missing passwords clearly', () => {
    expect(diagnoseDatabaseConfiguration({}).issues).toEqual([
      'DATABASE_URL is not set',
      'DIRECT_URL is not set',
    ]);

    const diagnostic = diagnoseDatabaseConfiguration({
      DATABASE_URL: 'not-a-url-with-a-secret',
      DIRECT_URL: connectionUrl(`postgres.${projectRef}`, '', sessionPoolerHost, 5432),
    });

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.issues).toContain('DATABASE_URL is not a valid PostgreSQL URL');
    expect(diagnostic.issues).toContain('DIRECT_URL password is missing');
  });

  it('rejects URLs that target different or unexpected databases', () => {
    const environment = validPoolerEnvironment();
    environment.DIRECT_URL = connectionUrl(
      `postgres.${projectRef}`,
      'direct-test-password',
      sessionPoolerHost,
      5432,
      'loanplus',
    );

    const diagnostic = diagnoseDatabaseConfiguration(environment);

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.issues).toContain('DIRECT_URL must target the postgres database');
    expect(diagnostic.issues).toContain(
      'DATABASE_URL and DIRECT_URL use different database names',
    );
  });

  it('parses encoded passwords without exposing credentials or full URLs', () => {
    const environment = validPoolerEnvironment();
    const secretPassword = 'test@pass:/?#[]%';
    environment.DATABASE_URL = connectionUrl(
      `postgres.${projectRef}`,
      encodeURIComponent(secretPassword),
      transactionPoolerHost,
      6543,
      'postgres',
      '?pgbouncer=true&token=connection-query-secret',
    );

    const diagnostic = diagnoseDatabaseConfiguration(environment);
    const output = JSON.stringify(diagnostic);

    expect(diagnostic.consistent).toBe(true);
    expect(diagnostic.variables.DATABASE_URL.passwordMayRequireUrlEncoding).toBe(true);
    expect(output).not.toContain(secretPassword);
    expect(output).not.toContain(encodeURIComponent(secretPassword));
    expect(output).not.toContain('runtime-test-password');
    expect(output).not.toContain('direct-test-password');
    expect(output).not.toContain('connection-query-secret');
    expect(output).not.toContain(`postgres.${projectRef}`);
    expect(output).not.toContain('postgresql://');
  });
});

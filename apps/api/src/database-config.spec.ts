import {
  diagnoseDatabaseConfiguration,
  validateDatabaseConfiguration,
} from './database-config';

describe('validateDatabaseConfiguration', () => {
  it('accepts separate valid PostgreSQL runtime and direct URLs', () => {
    expect(validateDatabaseConfiguration({
      DATABASE_URL: 'postgresql://loanplus:loanplus_dev_only@localhost:5432/loanplus?schema=public',
      DIRECT_URL: 'postgresql://loanplus:loanplus_dev_only@localhost:5432/loanplus?schema=public',
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
      DIRECT_URL: 'https://loanplus:loanplus_dev_only@localhost:5432/loanplus',
    })).toEqual([
      'DATABASE_URL is not a valid URL',
      'DIRECT_URL must be a PostgreSQL URL with a host, username, and database name',
    ]);
  });

  it('reports Supabase target consistency without exposing credentials', () => {
    const diagnostic = diagnoseDatabaseConfiguration({
      DATABASE_URL: 'postgresql://postgres.kgvsekredvzepeewocxl:password@region.pooler.supabase.com:6543/postgres',
      DIRECT_URL: 'postgresql://postgres:password@db.kgvsekredvzepeewocxl.supabase.co:5432/postgres',
    });

    expect(diagnostic.consistent).toBe(true);
    expect(diagnostic.variables.DATABASE_URL).toMatchObject({
      present: true,
      syntacticallyValid: true,
      hostname: 'region.pooler.supabase.com',
      port: '6543',
      database: 'postgres',
      isSupabasePooler: true,
      usernameMatchesExpectedFormat: true,
      passwordPresent: true,
      passwordMayRequireUrlEncoding: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(':password@');
    expect(JSON.stringify(diagnostic)).not.toContain('postgres.kgvsekredvzepeewocxl');
  });

  it('reports a malformed direct target without exposing unexpected credentials', () => {
    const diagnostic = diagnoseDatabaseConfiguration({
      DATABASE_URL: 'postgresql://postgres.kgvsekredvzepeewocxl:runtime-secret@region.pooler.supabase.com:6543/postgres',
      DIRECT_URL: 'postgresql://postgres.unexpected:direct-secret@region.pooler.supabase.com:6543/postgres',
    });

    expect(diagnostic.consistent).toBe(false);
    expect(diagnostic.variables.DIRECT_URL.usernameMatchesExpectedFormat).toBe(false);
    expect(diagnostic.issues).toContain(
      'DIRECT_URL host appears to be a pooler, not a direct Supabase host',
    );
    expect(JSON.stringify(diagnostic)).not.toContain('runtime-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('direct-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('postgres.unexpected');
  });
});

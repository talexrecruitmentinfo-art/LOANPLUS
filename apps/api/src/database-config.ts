const DATABASE_VARIABLES = ['DATABASE_URL', 'DIRECT_URL'] as const;
const EXPECTED_SUPABASE_PROJECT_REF = 'kgvsekredvzepeewocxl';
const EXPECTED_DATABASE = 'postgres';
const EXPECTED_DIRECT_HOST = `db.${EXPECTED_SUPABASE_PROJECT_REF}.supabase.co`;
const URL_RESERVED_CHARACTERS = /[:/?#\[\]@!$&'()*+,;=%\s]/;

type DatabaseVariable = (typeof DATABASE_VARIABLES)[number];

interface ParsedDatabaseUrl {
  present: boolean;
  syntacticallyValid: boolean;
  hostname: string | null;
  port: string | null;
  database: string | null;
  isSupabasePooler: boolean | null;
  usernameMatchesExpectedFormat: boolean | null;
  passwordPresent: boolean;
  passwordMayRequireUrlEncoding: boolean | null;
}

export interface DatabaseConfigurationDiagnostic {
  variables: Record<DatabaseVariable, ParsedDatabaseUrl>;
  consistent: boolean;
  issues: string[];
}

function parseDatabaseUrl(
  variable: DatabaseVariable,
  value: string | undefined,
): ParsedDatabaseUrl {
  const missing = {
    present: false,
    syntacticallyValid: false,
    hostname: null,
    port: null,
    database: null,
    isSupabasePooler: null,
    usernameMatchesExpectedFormat: null,
    passwordPresent: false,
    passwordMayRequireUrlEncoding: null,
  };

  if (!value) {
    return missing;
  }

  try {
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const syntacticallyValid =
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      Boolean(url.hostname && username && database) &&
      !database.includes('/');
    const isSupabasePooler = url.hostname.toLowerCase().endsWith('.pooler.supabase.com');
    const expectedUsername = `postgres.${EXPECTED_SUPABASE_PROJECT_REF}`;
    const isSupabaseDirectHost = /^db\.[a-z0-9]+\.supabase\.co$/i.test(url.hostname);
    const usernameMatchesExpectedFormat =
      variable === 'DATABASE_URL'
        ? username === expectedUsername
        : isSupabasePooler
          ? username === expectedUsername
          : isSupabaseDirectHost && username === 'postgres';

    return {
      present: true,
      syntacticallyValid,
      hostname: sanitize(url.hostname, /[^a-zA-Z0-9.:[\]-]/g),
      port: url.port || 'default',
      database: sanitize(database, /[^a-zA-Z0-9_.-]/g),
      isSupabasePooler,
      usernameMatchesExpectedFormat,
      passwordPresent: password.length > 0,
      passwordMayRequireUrlEncoding: URL_RESERVED_CHARACTERS.test(password),
    };
  } catch {
    return {
      ...missing,
      present: true,
    };
  }
}

function sanitize(value: string, invalidCharacters: RegExp): string {
  return value.replace(invalidCharacters, '?');
}

export function diagnoseDatabaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfigurationDiagnostic {
  const variables = {
    DATABASE_URL: parseDatabaseUrl('DATABASE_URL', environment.DATABASE_URL),
    DIRECT_URL: parseDatabaseUrl('DIRECT_URL', environment.DIRECT_URL),
  };
  const issues: string[] = [];

  for (const variable of DATABASE_VARIABLES) {
    const configuration = variables[variable];
    if (!configuration.present) {
      issues.push(`${variable} is not set`);
    } else if (!configuration.syntacticallyValid) {
      issues.push(`${variable} is not a valid PostgreSQL URL`);
    } else {
      if (!configuration.passwordPresent) {
        issues.push(`${variable} password is missing`);
      }
    }
  }

  const runtime = variables.DATABASE_URL;
  const direct = variables.DIRECT_URL;
  const runtimeUrl = getValidUrl(environment.DATABASE_URL);
  const directUrl = getValidUrl(environment.DIRECT_URL);

  if (runtime.syntacticallyValid && runtimeUrl) {
    if (runtime.isSupabasePooler !== true) {
      issues.push('DATABASE_URL host must be a Supabase transaction-pooler endpoint');
    }
    if (runtimeUrl.port !== '6543') {
      issues.push('DATABASE_URL must use transaction-pooler port 6543');
    }
    if (!runtime.usernameMatchesExpectedFormat) {
      issues.push(
        `DATABASE_URL username must be postgres.${EXPECTED_SUPABASE_PROJECT_REF} for the expected Supabase project`,
      );
    }
  }

  if (direct.syntacticallyValid && directUrl) {
    const isExpectedDirectHost = directUrl.hostname === EXPECTED_DIRECT_HOST;
    const isSupabaseDirectHost = /^db\.[a-z0-9]+\.supabase\.co$/i.test(directUrl.hostname);
    const isSupabaseSessionPooler = direct.isSupabasePooler === true;

    if (!isExpectedDirectHost && !isSupabaseSessionPooler) {
      issues.push(
        'DIRECT_URL host does not confirm the expected Supabase project or a Supabase session pooler',
      );
    }
    if (directUrl.port !== '5432') {
      issues.push('DIRECT_URL must use port 5432 for a direct or session-pooler connection');
    }
    if (!direct.usernameMatchesExpectedFormat) {
      issues.push(
        isSupabaseDirectHost
          ? 'DIRECT_URL username must be postgres for the expected direct Supabase endpoint'
          : isSupabaseSessionPooler
            ? `DIRECT_URL username must be postgres.${EXPECTED_SUPABASE_PROJECT_REF} for the expected Supabase project`
            : 'DIRECT_URL username does not match a supported Supabase connection format',
      );
    }
  }

  if (
    runtime.syntacticallyValid &&
    runtime.database !== EXPECTED_DATABASE
  ) {
    issues.push(`DATABASE_URL must target the ${EXPECTED_DATABASE} database`);
  }
  if (
    direct.syntacticallyValid &&
    direct.database !== EXPECTED_DATABASE
  ) {
    issues.push(`DIRECT_URL must target the ${EXPECTED_DATABASE} database`);
  }
  if (
    runtime.syntacticallyValid &&
    direct.syntacticallyValid &&
    runtime.database !== direct.database
  ) {
    issues.push('DATABASE_URL and DIRECT_URL use different database names');
  }

  return {
    variables,
    consistent: issues.length === 0,
    issues,
  };
}

function getValidUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function validateDatabaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return DATABASE_VARIABLES.flatMap((variable) => {
    const value = environment[variable];
    if (!value) {
      return [`${variable} is not set`];
    }
    try {
      new URL(value);
    } catch {
      return [`${variable} is not a valid URL`];
    }
    const configuration = parseDatabaseUrl(variable, value);
    if (!configuration.syntacticallyValid) {
      return [`${variable} must be a PostgreSQL URL with a host, username, and database name`];
    }
    return [];
  });
}

export function assertDatabaseConfiguration(environment: NodeJS.ProcessEnv = process.env): void {
  const errors = validateDatabaseConfiguration(environment);
  if (errors.length > 0) {
    throw new Error(
      `Database configuration is invalid: ${errors.join('; ')}. ` +
      'Set both variables in the environment before running Prisma commands.',
    );
  }
}

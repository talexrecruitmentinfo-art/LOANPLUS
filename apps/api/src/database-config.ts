const DATABASE_VARIABLES = ['DATABASE_URL', 'DIRECT_URL'] as const;
const EXPECTED_SUPABASE_PROJECT_REF = 'kgvsekredvzepeewocxl';
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
    const isSupabasePooler = /(^|\.)pooler\./i.test(url.hostname);
    const expectedUsername =
      variable === 'DATABASE_URL'
        ? `postgres.${EXPECTED_SUPABASE_PROJECT_REF}`
        : 'postgres';

    return {
      present: true,
      syntacticallyValid,
      hostname: sanitize(url.hostname, /[^a-zA-Z0-9.:[\]-]/g),
      port: url.port || 'default',
      database: sanitize(database, /[^a-zA-Z0-9_.-]/g),
      isSupabasePooler,
      usernameMatchesExpectedFormat: username === expectedUsername,
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
      if (!configuration.usernameMatchesExpectedFormat) {
        issues.push(`${variable} username does not match the expected Supabase format`);
      }
      if (!configuration.passwordPresent) {
        issues.push(`${variable} password is missing`);
      }
    }
  }

  const runtime = variables.DATABASE_URL;
  const direct = variables.DIRECT_URL;
  const runtimeUrl = getValidUrl(environment.DATABASE_URL);
  const directUrl = getValidUrl(environment.DIRECT_URL);

  if (runtime.syntacticallyValid && runtime.isSupabasePooler !== true) {
    issues.push('DATABASE_URL host does not appear to be a Supabase pooler');
  }
  if (direct.syntacticallyValid && direct.isSupabasePooler === true) {
    issues.push('DIRECT_URL host appears to be a pooler, not a direct Supabase host');
  }
  if (
    direct.syntacticallyValid &&
    directUrl?.hostname !== `db.${EXPECTED_SUPABASE_PROJECT_REF}.supabase.co`
  ) {
    issues.push('DIRECT_URL host does not confirm the expected Supabase project');
  }
  if (
    runtime.syntacticallyValid &&
    runtime.isSupabasePooler === true &&
    runtime.usernameMatchesExpectedFormat !== true
  ) {
    issues.push('DATABASE_URL username does not confirm the expected Supabase project');
  }
  if (
    runtime.syntacticallyValid &&
    direct.syntacticallyValid &&
    runtimeUrl &&
    directUrl &&
    decodeURIComponent(runtimeUrl.pathname.slice(1)) !==
      decodeURIComponent(directUrl.pathname.slice(1))
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
    const configuration = parseDatabaseUrl(variable, environment[variable]);
    if (!configuration.present) {
      return [`${variable} is not set`];
    }
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

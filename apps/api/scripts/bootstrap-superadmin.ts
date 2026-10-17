import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { isEmail } from 'class-validator';

interface SuperadminProvisioningClient {
  superadminUser: {
    findUnique(args: { where: { email: string }; select: { id: true } }): Promise<{ id: string } | null>;
    create(args: {
      data: { email: string; passwordHash: string; role: 'SUPERADMIN'; emailVerifiedAt: Date };
    }): Promise<unknown>;
  };
}

export class BootstrapInputError extends Error {}

export async function provisionSuperadmin(
  prisma: SuperadminProvisioningClient,
  emailSetting: string | undefined,
  emailVerifiedSetting: string | undefined,
  password: string,
): Promise<string> {
  const configuredEmail = emailSetting?.trim().toLowerCase();
  if (
    !configuredEmail ||
    configuredEmail.length > 254 ||
    !isEmail(configuredEmail) ||
    emailVerifiedSetting !== 'true'
  ) {
    throw new BootstrapInputError(
      'Set SUPERADMIN_EMAIL to a valid address and explicitly confirm mailbox verification with SUPERADMIN_EMAIL_VERIFIED=true.',
    );
  }
  if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new BootstrapInputError('Password must be between 12 and 72 UTF-8 bytes.');
  }

  const existing = await prisma.superadminUser.findUnique({
    where: { email: configuredEmail },
    select: { id: true },
  });
  if (existing) {
    throw new BootstrapInputError(
      'A Superadmin already exists for SUPERADMIN_EMAIL; this command never changes an existing account.',
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.superadminUser.create({
    data: {
      email: configuredEmail,
      passwordHash,
      role: 'SUPERADMIN',
      emailVerifiedAt: new Date(),
    },
  });
  return configuredEmail;
}

function readHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Run this operator command in an interactive terminal.'));
      return;
    }

    process.stdout.write(label);
    input.setRawMode(true);
    input.resume();
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          reject(new Error('Bootstrap cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
  });
}

async function bootstrap(): Promise<void> {
  const password = await readHidden('New Superadmin password (hidden): ');
  const prisma = new PrismaClient();
  try {
    await provisionSuperadmin(
      prisma,
      process.env.SUPERADMIN_EMAIL,
      process.env.SUPERADMIN_EMAIL_VERIFIED,
      password,
    );
    process.stdout.write('Superadmin provisioned.\n');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    const message = error instanceof BootstrapInputError
      ? error.message
      : 'Superadmin provisioning failed; sensitive database error details are suppressed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
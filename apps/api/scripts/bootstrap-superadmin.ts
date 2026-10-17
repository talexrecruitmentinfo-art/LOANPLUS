import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

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
  const configuredEmail = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  if (!configuredEmail || process.env.SUPERADMIN_EMAIL_VERIFIED !== 'true') {
    throw new Error('Set SUPERADMIN_EMAIL and explicitly confirm mailbox verification with SUPERADMIN_EMAIL_VERIFIED=true.');
  }

  const password = await readHidden('New Superadmin password (hidden): ');
  if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Password must be between 12 and 72 UTF-8 bytes.');
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.superadminUser.findUnique({ where: { email: configuredEmail } });
    if (existing) throw new Error('A Superadmin already exists for the configured email.');
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.superadminUser.create({
      data: { email: configuredEmail, passwordHash, emailVerifiedAt: new Date() },
    });
    process.stdout.write(`Superadmin provisioned for ${configuredEmail}.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Superadmin bootstrap failed.'}\n`);
  process.exitCode = 1;
});
import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService, type PostJournalInput } from './ledger.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = databaseUrl ? it : it.skip;

describe('ledger database integration', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let userId: string;
  let accountIds: string[] = [];
  const idempotencyKey = `ledger-test:${randomBytes(16).toString('hex')}`;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const parsedUrl = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database whose name ends in _test.');
    }
    prisma = new PrismaService();
    await prisma.$connect();
    ledger = new LedgerService(prisma);
    const user = await prisma.user.create({
      data: {
        fullName: 'Ledger Test Customer',
        email: `ledger-${Date.now()}-${randomBytes(4).toString('hex')}@example.invalid`,
        phone: `+2547${randomBytes(4).readUInt32BE() % 100_000_000}`.padEnd(13, '0'),
        nationalIdCiphertext: 'test-fixture-only',
        nationalIdHash: randomBytes(32).toString('hex'),
        passwordHash: 'test-only-not-a-real-hash',
        termsVersion: 'test-v1',
        privacyVersion: 'test-v1',
      },
      select: { id: true },
    });
    userId = user.id;
    const [cash, wallet] = await Promise.all([
      prisma.ledgerAccount.create({
        data: { code: `TEST_CASH_${randomBytes(4).toString('hex')}`, name: 'Test cash', accountType: 'ASSET' },
        select: { id: true },
      }),
      prisma.ledgerAccount.create({
        data: { code: `TEST_WALLET_${randomBytes(4).toString('hex')}`, name: 'Test customer wallet', accountType: 'LIABILITY', userId },
        select: { id: true },
      }),
    ]);
    accountIds = [cash.id, wallet.id];
  });

  afterAll(async () => {
    if (!databaseUrl || !prisma) return;
    if (accountIds.length) {
      await prisma.ledgerEntry.deleteMany({ where: { ledgerAccountId: { in: accountIds } } });
      await prisma.ledgerTransaction.deleteMany({ where: { idempotencyKey } });
      await prisma.ledgerAccount.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  databaseTest('posts balanced lines once and derives the KES wallet from the ledger', async () => {
    const input: PostJournalInput = {
      idempotencyKey,
      transactionType: 'TEST_CREDIT',
      actorType: 'SYSTEM',
      reason: 'Automated integration fixture.',
      lines: [
        { accountId: accountIds[0], debitKes: 100, creditKes: 0 },
        { accountId: accountIds[1], debitKes: 0, creditKes: 100 },
      ],
    };
    const first = await ledger.postBalancedTransaction(input);
    const replay = await ledger.postBalancedTransaction(input);
    expect(first.id).toBe(replay.id);
    expect(first.entries).toHaveLength(2);
    expect(await ledger.getCustomerWallet(userId)).toEqual({ balanceKes: 100, currency: 'KES' });
    await expect(ledger.postBalancedTransaction({
      ...input,
      reason: 'Different data under the same key.',
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(ledger.postBalancedTransaction({
      ...input,
      idempotencyKey: `unbalanced:${randomBytes(16).toString('hex')}`,
      lines: [
        { accountId: accountIds[0], debitKes: 101, creditKes: 0 },
        { accountId: accountIds[1], debitKes: 0, creditKes: 100 },
      ],
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
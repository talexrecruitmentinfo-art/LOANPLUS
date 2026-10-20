import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { LedgerAccountType, Prisma, type LedgerAccountType as AccountType } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface JournalLineInput {
  accountId: string;
  debitKes: number;
  creditKes: number;
}

export interface PostJournalInput {
  idempotencyKey: string;
  transactionType: string;
  actorType: 'CUSTOMER' | 'SUPERADMIN' | 'SYSTEM' | 'PROVIDER';
  actorId?: string;
  paymentId?: string;
  reason?: string;
  lines: JournalLineInput[];
}

export interface CreateLedgerAccountInput {
  code: string;
  name: string;
  accountType: AccountType;
  reason: string;
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async listSystemAccounts() {
    return this.prisma.ledgerAccount.findMany({
      where: { userId: null },
      select: { id: true, code: true, name: true, accountType: true, currency: true, isActive: true, createdAt: true },
      orderBy: { code: 'asc' },
    });
  }

  async createSystemAccount(input: CreateLedgerAccountInput, adminId: string, ipAddress?: string) {
    if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(input.code) || input.code.startsWith('WALLET_')) {
      throw new BadRequestException('Ledger account code is invalid or reserved.');
    }
    if (input.name.trim().length < 3 || input.name.trim().length > 120) {
      throw new BadRequestException('Ledger account name must be 3 to 120 characters.');
    }
    if (input.reason.trim().length < 10 || input.reason.trim().length > 500) {
      throw new BadRequestException('A ledger account creation reason is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.ledgerAccount.create({
        data: { code: input.code, name: input.name.trim(), accountType: input.accountType, currency: 'KES' },
        select: { id: true, code: true, name: true, accountType: true, currency: true, isActive: true },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: adminId,
          action: 'LEDGER_ACCOUNT_CREATE',
          subjectType: 'LEDGER_ACCOUNT',
          subjectId: account.id,
          outcome: 'SUCCESS',
          reason: input.reason.trim(),
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return account;
    });
  }

  async postBalancedTransaction(input: PostJournalInput) {
    const requestHash = this.hashRequest(input);
    const existing = await this.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });
    if (existing) return this.matchExisting(existing, requestHash);

    try {
      return await this.prisma.$transaction(async (tx) => {
        return this.postWithinTransaction(tx, input, requestHash);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      ) {
        const raced = await this.prisma.ledgerTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: { entries: true },
        });
        if (raced) return this.matchExisting(raced, requestHash);
      }
      throw error;
    }
  }

  async postWithinTransaction(
    tx: Prisma.TransactionClient,
    input: PostJournalInput,
    requestHash = this.hashRequest(input),
  ) {
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });
    if (existing) return this.matchExisting(existing, requestHash);

    const accountIds = input.lines.map((line) => line.accountId);
    const accounts = await tx.ledgerAccount.findMany({
      where: { id: { in: accountIds }, isActive: true, currency: 'KES' },
      select: { id: true },
    });
    if (accounts.length !== accountIds.length) {
      throw new BadRequestException('Every journal line must use an active KES ledger account.');
    }
    const transaction = await tx.ledgerTransaction.create({
      data: {
        internalReference: `LPJ${randomBytes(16).toString('hex').toUpperCase()}`,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        transactionType: input.transactionType,
        actorType: input.actorType,
        actorId: input.actorId,
        paymentId: input.paymentId,
        reason: input.reason,
      },
    });
    await tx.ledgerEntry.createMany({
      data: input.lines.map((line) => ({
        ledgerTransactionId: transaction.id,
        ledgerAccountId: line.accountId,
        debitKes: line.debitKes,
        creditKes: line.creditKes,
      })),
    });
    return tx.ledgerTransaction.findUniqueOrThrow({
      where: { id: transaction.id },
      include: { entries: true },
    });
  }

  async getCustomerWallet(userId: string) {
    const [entries, pendingDeposits] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: {
          account: {
            code: `WALLET_${userId}`,
            userId,
            accountType: LedgerAccountType.LIABILITY,
            currency: 'KES',
            isActive: true,
          },
          transaction: { status: 'POSTED' },
        },
        select: { debitKes: true, creditKes: true },
      }),
      this.prisma.paymentTransaction.aggregate({
        where: { userId, type: 'WALLET_DEPOSIT', status: 'PENDING', currency: 'KES' },
        _sum: { amountKes: true },
      }),
    ]);
    const balanceKes = entries.reduce((balance, entry) => balance + entry.creditKes - entry.debitKes, 0);
    const pendingDepositsKes = pendingDeposits._sum.amountKes ?? 0;
    if (!Number.isSafeInteger(balanceKes) || balanceKes < 0 ||
      !Number.isSafeInteger(pendingDepositsKes) || pendingDepositsKes < 0) {
      throw new ConflictException('The customer ledger balance requires reconciliation.');
    }
    return {
      balanceKes,
      pendingDepositsKes,
      currency: 'KES',
    };
  }

  async listCustomerEntries(userId: string, cursor?: string, requestedLimit = 25) {
    const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), 100);
    const walletAccount = {
      code: `WALLET_${userId}`,
      userId,
      accountType: LedgerAccountType.LIABILITY,
      currency: 'KES',
    };
    if (cursor) {
      const anchor = await this.prisma.ledgerEntry.findFirst({
        where: { id: cursor, account: walletAccount },
        select: { id: true },
      });
      if (!anchor) throw new BadRequestException('Wallet transaction cursor is invalid.');
    }
    const rows = await this.prisma.ledgerEntry.findMany({
      where: { account: walletAccount },
      select: {
        id: true,
        debitKes: true,
        creditKes: true,
        createdAt: true,
        account: { select: { code: true, name: true } },
        transaction: { select: { internalReference: true, transactionType: true, status: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  private validateLines(lines: JournalLineInput[]): void {
    if (lines.length < 2 || new Set(lines.map((line) => line.accountId)).size !== lines.length) {
      throw new BadRequestException('A journal requires at least two distinct ledger accounts.');
    }
    let debits = 0;
    let credits = 0;
    for (const line of lines) {
      if (
        !Number.isSafeInteger(line.debitKes) ||
        !Number.isSafeInteger(line.creditKes) ||
        line.debitKes < 0 ||
        line.creditKes < 0 ||
        (line.debitKes > 0) === (line.creditKes > 0)
      ) {
        throw new BadRequestException('Each ledger entry must contain one positive debit or credit amount in KES.');
      }
      debits += line.debitKes;
      credits += line.creditKes;
    }
    if (!Number.isSafeInteger(debits) || debits !== credits) {
      throw new BadRequestException('Ledger debits and credits must balance exactly.');
    }
  }

  private hashRequest(input: PostJournalInput): string {
    if (!/^[a-zA-Z0-9._:-]{16,128}$/.test(input.idempotencyKey)) {
      throw new BadRequestException('A valid idempotency key is required.');
    }
    if (!/^[A-Z0-9_]{2,40}$/.test(input.transactionType)) {
      throw new BadRequestException('Invalid ledger transaction type.');
    }
    if (input.reason && input.reason.length > 500) {
      throw new BadRequestException('The ledger transaction reason is too long.');
    }
    this.validateLines(input.lines);
    const canonical = {
      transactionType: input.transactionType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      paymentId: input.paymentId ?? null,
      reason: input.reason?.trim() ?? null,
      lines: [...input.lines].sort((left, right) => left.accountId.localeCompare(right.accountId)),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private matchExisting<T extends { requestHash: string }>(existing: T, requestHash: string): T {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException('This idempotency key was already used for a different ledger transaction.');
    }
    return existing;
  }
}
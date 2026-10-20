import { LedgerAccountType } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';

describe('LedgerService customer wallet reads', () => {
  it('derives the available balance and pending deposits from the authenticated wallet only', async () => {
    const findMany = jest.fn(async () => [
      { debitKes: 0, creditKes: 1000 },
      { debitKes: 250, creditKes: 0 },
    ]);
    const aggregate = jest.fn(async () => ({ _sum: { amountKes: 400 } }));
    const service = new LedgerService({
      ledgerEntry: { findMany },
      paymentTransaction: { aggregate },
    } as unknown as PrismaService);

    await expect(service.getCustomerWallet('customer-id')).resolves.toEqual({
      balanceKes: 750,
      pendingDepositsKes: 400,
      currency: 'KES',
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        account: {
          code: 'WALLET_customer-id',
          userId: 'customer-id',
          accountType: LedgerAccountType.LIABILITY,
          currency: 'KES',
          isActive: true,
        },
        transaction: { status: 'POSTED' },
      },
    }));
    expect(aggregate).toHaveBeenCalledWith({
      where: { userId: 'customer-id', type: 'WALLET_DEPOSIT', status: 'PENDING', currency: 'KES' },
      _sum: { amountKes: true },
    });
  });

  it('returns a bounded wallet-specific cursor page', async () => {
    const rows = [
      { id: 'entry-newest', transaction: { internalReference: 'LPW1' } },
      { id: 'entry-next', transaction: { internalReference: 'LPW2' } },
      { id: 'entry-last', transaction: { internalReference: 'LPW3' } },
    ];
    const findMany = jest.fn(async () => rows);
    const service = new LedgerService({
      ledgerEntry: { findMany },
    } as unknown as PrismaService);

    await expect(service.listCustomerEntries('customer-id', undefined, 2)).resolves.toEqual({
      items: rows.slice(0, 2),
      nextCursor: 'entry-next',
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        account: {
          code: 'WALLET_customer-id',
          userId: 'customer-id',
          accountType: LedgerAccountType.LIABILITY,
          currency: 'KES',
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    }));
  });
});

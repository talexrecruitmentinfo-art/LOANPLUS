import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentType } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from '../ledger/ledger.service';
import { LoanService } from './loan.service';

describe('wallet-funded loan repayment', () => {
  const loanFixture = () => ({
    id: 'loan-id',
    userId: 'customer-id',
    principalKes: 3000,
    chargesKes: 310,
    totalRepayableKes: 3310,
    outstandingKes: 3310,
    status: 'DISBURSED',
    disbursedAt: new Date(),
    repaymentSchedules: [{ id: 'schedule-id' }],
    repayments: [],
  });

  function setup(options: {
    balanceKes?: number;
    loan?: ReturnType<typeof loanFixture> | null;
    chargesAccountType?: string;
    processingFeeCode?: string;
    existingPayment?: Record<string, unknown> | null;
    transactionError?: Error;
  } = {}) {
    const loan = options.loan === undefined ? loanFixture() : options.loan;
    const createdPayment: Record<string, unknown>[] = [];
    const createdRepayment: Record<string, unknown>[] = [];
    const postLedger = jest.fn(async () => undefined);
    const transactionClient = {
      paymentTransaction: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const result = { id: 'repayment-payment-id', internalReference: 'LPWRRECEIPT001', ...data };
          createdPayment.push(result);
          return { id: result.id, internalReference: result.internalReference };
        }),
      },
      loan: {
        findFirst: jest.fn(async () => loan),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      ledgerAccount: {
        findUnique: jest.fn(async ({ where }: { where: { code: string } }) => {
          if (where.code === 'WALLET_customer-id') {
            return { id: 'wallet-account', userId: 'customer-id', isActive: true, currency: 'KES', accountType: 'LIABILITY' };
          }
          if (where.code === 'LOAN_RECEIVABLE') {
            return { id: 'receivable-account', isActive: true, currency: 'KES', accountType: 'ASSET' };
          }
          if (where.code === 'LOAN_CHARGES_REVENUE') {
            return {
              id: 'charges-account',
              isActive: true,
              currency: 'KES',
              accountType: options.chargesAccountType ?? 'REVENUE',
            };
          }
          return null;
        }),
      },
      systemSetting: {
        findUnique: jest.fn(async ({ where }: { where: { key: string } }) => ({
          value: where.key === 'loan.charges_revenue_account'
            ? 'LOAN_CHARGES_REVENUE'
            : options.processingFeeCode ?? 'LOAN_PROCESSING_FEES',
        })),
      },
      ledgerEntry: {
        aggregate: jest.fn(async () => ({
          _sum: { creditKes: options.balanceKes ?? 4000, debitKes: 0 },
        })),
      },
      repayment: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          createdRepayment.push(data);
          return { ...data, createdAt: new Date() };
        }),
      },
    };
    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn(async () => options.existingPayment ?? null),
      },
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient)),
    } as unknown as PrismaService;
    return {
      service: new LoanService(prisma, { postWithinTransaction: postLedger } as unknown as LedgerService),
      prisma,
      transactionClient,
      createdPayment,
      createdRepayment,
      postLedger,
    };
  }

  it('applies partial payments to charges first and posts a balanced wallet liability reduction', async () => {
    const state = setup();
    const receipt = await state.service.repayWithWallet(
      'customer-id',
      'loan-id',
      100,
      true,
      'wallet-repayment-key-001',
    );

    expect(receipt).toMatchObject({
      reference: state.createdPayment[0].internalReference,
      amountKes: 100,
      chargesPaidKes: 100,
      principalPaidKes: 0,
      outstandingKes: 3210,
      status: 'REPAYMENT_IN_PROGRESS',
    });
    expect(state.createdRepayment[0]).toMatchObject({
      loanId: 'loan-id',
      scheduleId: 'schedule-id',
      amountKes: 100,
      chargesPaidKes: 100,
      principalPaidKes: 0,
      outstandingAfterKes: 3210,
    });
    expect(state.createdPayment[0]).toMatchObject({
      type: PaymentType.REPAYMENT,
      provider: 'INTERNAL_WALLET',
      status: 'CONFIRMED',
    });
    expect(state.postLedger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      transactionType: 'WALLET_LOAN_REPAYMENT',
      actorType: 'CUSTOMER',
      lines: [
        { accountId: 'wallet-account', debitKes: 100, creditKes: 0 },
        { accountId: 'charges-account', debitKes: 0, creditKes: 100 },
      ],
    }));
  });

  it('settles a full balance with separate principal and charges credits', async () => {
    const state = setup();
    const receipt = await state.service.repayWithWallet(
      'customer-id',
      'loan-id',
      3310,
      true,
      'wallet-repayment-key-002',
    );
    expect(receipt).toMatchObject({
      amountKes: 3310,
      principalPaidKes: 3000,
      chargesPaidKes: 310,
      outstandingKes: 0,
      status: 'REPAID',
    });
    expect(state.postLedger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lines: [
        { accountId: 'wallet-account', debitKes: 3310, creditKes: 0 },
        { accountId: 'receivable-account', debitKes: 0, creditKes: 3000 },
        { accountId: 'charges-account', debitKes: 0, creditKes: 310 },
      ],
    }));
  });

  it('rejects insufficient balance without writing payment, loan, or ledger records', async () => {
    const state = setup({ balanceKes: 99 });
    await expect(state.service.repayWithWallet(
      'customer-id',
      'loan-id',
      100,
      true,
      'wallet-repayment-key-003',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(state.createdPayment).toHaveLength(0);
    expect(state.createdRepayment).toHaveLength(0);
    expect(state.postLedger).not.toHaveBeenCalled();
    expect(state.transactionClient.loan.updateMany).not.toHaveBeenCalled();
  });

  it('does not reveal or repay a loan owned by another customer', async () => {
    const state = setup({ loan: null });
    await expect(state.service.repayWithWallet(
      'customer-id',
      'another-customer-loan',
      100,
      true,
      'wallet-repayment-key-004',
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(state.createdPayment).toHaveLength(0);
    expect(state.postLedger).not.toHaveBeenCalled();
  });

  it('rejects an amount above the current outstanding balance', async () => {
    const state = setup();
    await expect(state.service.repayWithWallet(
      'customer-id',
      'loan-id',
      3311,
      true,
      'wallet-repayment-key-005',
    )).rejects.toThrow('The repayment cannot exceed the current amount due.');
    expect(state.createdPayment).toHaveLength(0);
  });

  it('refuses to credit the configured processing-fee revenue account for loan charges', async () => {
    const state = setup({ processingFeeCode: 'LOAN_CHARGES_REVENUE' });
    await expect(state.service.repayWithWallet(
      'customer-id',
      'loan-id',
      100,
      true,
      'wallet-repayment-key-006',
    )).rejects.toThrow('Separate KES loan-receivable and loan-charges revenue accounts must be configured.');
    expect(state.createdPayment).toHaveLength(0);
    expect(state.postLedger).not.toHaveBeenCalled();
  });

  it('returns the original receipt for an identical idempotent retry', async () => {
    const requestHash = createHashForRequest('customer-id', 'loan-id', 100);
    const existingPayment = {
      userId: 'customer-id',
      type: PaymentType.REPAYMENT,
      provider: 'INTERNAL_WALLET',
      requestHash,
      internalReference: 'LPWRRECEIPT002',
      currency: 'KES',
      repayments: [{
        loanId: 'loan-id',
        amountKes: 100,
        principalPaidKes: 0,
        chargesPaidKes: 100,
        outstandingAfterKes: 3210,
        loanStatusAfter: 'REPAYMENT_IN_PROGRESS',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        loan: { id: 'loan-id', userId: 'customer-id', outstandingKes: 3210, status: 'REPAYMENT_IN_PROGRESS' },
      }],
    };
    const state = setup({ existingPayment });
    const receipt = await state.service.repayWithWallet(
      'customer-id',
      'loan-id',
      100,
      true,
      'wallet-repayment-key-007',
    );
    expect(receipt).toMatchObject({
      reference: 'LPWRRECEIPT002',
      amountKes: 100,
      outstandingKes: 3210,
      chargesPaidKes: 100,
    });
    expect(state.prisma.$transaction).not.toHaveBeenCalled();
    expect(state.postLedger).not.toHaveBeenCalled();
  });
});

function createHashForRequest(userId: string, loanId: string, amountKes: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ userId, loanId, amountKes, currency: 'KES' }))
    .digest('hex');
}

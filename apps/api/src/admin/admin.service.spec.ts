import { PaymentStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

describe('AdminService financial and account views', () => {
  it('searches customers without selecting personal identifiers or credentials', async () => {
    const findMany = jest.fn(async (_query: Record<string, unknown>) => []);
    const service = new AdminService({ user: { findMany } } as unknown as PrismaService);

    await service.listCustomers('Amina');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [
        { fullName: { contains: 'Amina', mode: 'insensitive' } },
        { email: { contains: 'Amina', mode: 'insensitive' } },
      ] },
      select: expect.objectContaining({
        fullName: true,
        email: true,
        activationStatus: true,
        _count: { select: { paymentTransactions: true, loans: true, loanApplications: true } },
      }),
      take: 100,
    }));
    const query = findMany.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(query.select).not.toHaveProperty('phone');
    expect(query.select).not.toHaveProperty('nationalIdCiphertext');
    expect(query.select).not.toHaveProperty('passwordHash');
  });

  it('includes legacy 4999 failures in pending payment searches without selecting raw payloads', async () => {
    const findMany = jest.fn(async (_query: Record<string, unknown>) => []);
    const service = new AdminService({ paymentTransaction: { findMany } } as unknown as PrismaService);

    await service.listPayments('LPA', PaymentStatus.PENDING);

    const query = findMany.mock.calls[0][0] as { where: { AND: unknown[] }; select: Record<string, unknown> };
    expect(query.where.AND).toEqual([
      { OR: [
        { status: PaymentStatus.PENDING },
        { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
      ] },
      { OR: expect.arrayContaining([
        { internalReference: { contains: 'LPA', mode: 'insensitive' } },
        { activationRequest: { is: { checkoutRequestId: { contains: 'LPA', mode: 'insensitive' } } } },
      ]) },
    ]);
    expect(query.select).toHaveProperty('activationRequest.select.callbackEvents');
    expect(query.select).not.toHaveProperty('activationRequest.select.payload');
  });

  it('distinguishes settled payment totals from posted-ledger wallet liabilities', async () => {
    const paymentCount = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if ('failureCode' in where) return 1;
      if (where.status === 'PENDING') return 2;
      if (where.status === 'FAILED') return 3;
      return 0;
    });
    const prisma = {
      user: { count: jest.fn(async () => 0) },
      paymentTransaction: {
        count: paymentCount,
        aggregate: jest.fn(async () => ({ _sum: { amountKes: 420 } })),
      },
      loanApplication: { count: jest.fn(async () => 0) },
      loan: { count: jest.fn(async () => 0) },
      withdrawalRequest: { count: jest.fn(async () => 0) },
      referral: { count: jest.fn(async () => 0) },
      referralReward: { count: jest.fn(async () => 0) },
      supportTicket: { count: jest.fn(async () => 0) },
      ledgerEntry: { aggregate: jest.fn(async () => ({ _sum: { creditKes: 150, debitKes: 35 } })) },
      adminAuditLog: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    const service = new AdminService(prisma);

    const dashboard = await service.getDashboard();

    expect(dashboard.metrics.verifiedPaymentsKes).toBe(420);
    expect(dashboard.metrics.walletLiabilitiesKes).toBe(115);
    expect(dashboard.metrics.paymentReconciliation).toEqual({ pending: 3, failed: 2 });
  });
});

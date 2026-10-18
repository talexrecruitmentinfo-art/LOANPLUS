import { PaymentStatus, PaymentType } from '@prisma/client';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

describe('AdminService financial and account views', () => {
  it('searches customers without selecting personal identifiers or credentials', async () => {
    const findMany = jest.fn(async (_query: Record<string, unknown>) => []);
    const count = jest.fn(async () => 0);
    const service = new AdminService({ user: { findMany, count } } as unknown as PrismaService);

    const result = await service.listCustomers({
      search: 'Amina',
      page: 2,
      pageSize: 20,
      accountStatus: 'ACTIVE',
      identityStatus: 'VERIFIED',
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [
        { OR: [
          { id: { contains: 'Amina', mode: 'insensitive' } },
          { fullName: { contains: 'Amina', mode: 'insensitive' } },
          { email: { contains: 'Amina', mode: 'insensitive' } },
        ] },
        { isActive: true },
        { identityStatus: 'VERIFIED' },
      ] },
      select: expect.objectContaining({
        fullName: true,
        email: true,
        identityStatus: true,
        _count: { select: { paymentTransactions: true, loans: true, loanApplications: true } },
      }),
      skip: 20,
      take: 20,
    }));
    const query = findMany.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(query.select).toHaveProperty('phone', true);
    expect(query.select).not.toHaveProperty('activationStatus');
    expect(query.select).not.toHaveProperty('nationalIdCiphertext');
    expect(query.select).not.toHaveProperty('passwordHash');
    expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 20, pageCount: 0 });
  });

  it('returns only a masked phone number to customer list responses', async () => {
    const service = new AdminService({
      user: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{
          id: 'customer-id',
          fullName: 'Amina Otieno',
          email: 'amina@example.invalid',
          phone: '+254712345678',
          role: 'NORMAL_USER',
          identityStatus: 'NOT_STARTED',
          isActive: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          _count: { paymentTransactions: 0, loans: 0, loanApplications: 0 },
        }]),
      },
    } as unknown as PrismaService);

    const result = await service.listCustomers({ page: 1, pageSize: 25 });

    expect(result.items[0]).toHaveProperty('phoneMasked', '***678');
    expect(result.items[0]).not.toHaveProperty('phone');
  });

  it('includes legacy 4999 failures in pending payment searches without selecting raw payloads', async () => {
    const findMany = jest.fn(async (_query: Record<string, unknown>) => []);
    const count = jest.fn(async () => 0);
    const service = new AdminService({ paymentTransaction: { findMany, count } } as unknown as PrismaService);

    await service.listPayments({
      search: 'LPA',
      status: PaymentStatus.PENDING,
      page: 1,
      pageSize: 25,
      type: PaymentType.ACTIVATION,
    });

    const query = findMany.mock.calls[0][0] as { where: { AND: unknown[] }; select: Record<string, unknown> };
    expect(query.where.AND).toEqual([
      { OR: [
        { status: PaymentStatus.PENDING },
        { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
      ] },
      { type: PaymentType.ACTIVATION },
      { OR: expect.arrayContaining([
        { internalReference: { contains: 'LPA', mode: 'insensitive' } },
        { activationRequest: { is: { checkoutRequestId: { contains: 'LPA', mode: 'insensitive' } } } },
      ]) },
    ]);
    expect(query.select).toHaveProperty('activationRequest.select.callbackEvents');
    expect(query.select).not.toHaveProperty('activationRequest.select.payload');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
  });

  it('returns bounded customer activity while excluding credentials and raw identity/payment payloads', async () => {
    const customer = { id: 'customer-id', fullName: 'Amina' };
    const findUnique = jest.fn(async (_query: Record<string, unknown>) => customer);
    const service = new AdminService({ user: { findUnique } } as unknown as PrismaService);

    await expect(service.getCustomerDetails('customer-id')).resolves.toBe(customer);

    const query = findUnique.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(query.select).toHaveProperty('loanApplications');
    expect(query.select).toHaveProperty('loans');
    expect(query.select).toHaveProperty('paymentTransactions');
    expect(query.select).toHaveProperty('referralsSent');
    expect(query.select).toHaveProperty('supportTickets');
    expect(query.select).not.toHaveProperty('phone');
    expect(query.select).not.toHaveProperty('nationalIdCiphertext');
    expect(query.select).not.toHaveProperty('nationalIdHash');
    expect(query.select).not.toHaveProperty('passwordHash');
    expect(query.select).not.toHaveProperty('sessions');
  });

  it('returns an explicit not-found result for a missing customer', async () => {
    const findUnique = jest.fn(async (_query: Record<string, unknown>) => null);
    const service = new AdminService({ user: { findUnique } } as unknown as PrismaService);

    await expect(service.getCustomerDetails('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('suspends only customer accounts, revokes their sessions, and audits the reason atomically', async () => {
    const customer = { id: 'customer-id', role: 'NORMAL_USER', isActive: true };
    const tx = {
      user: {
        findUnique: jest.fn(async () => customer),
        update: jest.fn(async () => ({ id: customer.id, isActive: false })),
      },
      customerSession: { updateMany: jest.fn(async () => ({ count: 2 })) },
      adminAuditLog: { create: jest.fn(async () => ({ id: 'audit-id' })) },
    };
    const transaction = jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    const service = new AdminService({ $transaction: transaction } as unknown as PrismaService);

    await expect(service.updateCustomerStatus('customer-id', false, 'Confirmed support request', 'admin-id', '127.0.0.1'))
      .resolves.toEqual({ id: 'customer-id', isActive: false, changed: true });
    expect(tx.customerSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'customer-id', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        superadminId: 'admin-id',
        action: 'CUSTOMER_SUSPENDED',
        subjectId: 'customer-id',
        reason: 'Confirmed support request',
        ipAddress: '127.0.0.1',
      }),
    });
  });

  it('does not permit status changes for privileged or missing accounts and requires a reason', async () => {
    const findUnique = jest.fn(async () => ({ id: 'not-a-customer', role: 'SUPERADMIN', isActive: true }));
    const transaction = jest.fn(async (callback: (client: { user: { findUnique: typeof findUnique } }) => Promise<unknown>) =>
      callback({ user: { findUnique } }));
    const service = new AdminService({ $transaction: transaction } as unknown as PrismaService);

    await expect(service.updateCustomerStatus('not-a-customer', false, 'reason long enough', 'admin-id'))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateCustomerStatus('customer-id', false, 'short', 'admin-id'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates only the customer display name with optimistic concurrency and before/after audit details', async () => {
    const original = {
      id: 'customer-id',
      role: 'NORMAL_USER',
      fullName: 'Amina Otieno',
      updatedAt: new Date('2026-10-18T20:00:00.000Z'),
    };
    const saved = { id: original.id, fullName: 'Amina N. Otieno', updatedAt: new Date('2026-10-18T21:00:00.000Z') };
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(saved),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
    };
    const service = new AdminService({
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService);

    await expect(service.updateCustomerProfile(
      'customer-id',
      '  Amina   N. Otieno ',
      original.updatedAt.toISOString(),
      'Customer requested a display name correction',
      'admin-id',
    )).resolves.toEqual({
      ...saved,
      updatedAt: saved.updatedAt.toISOString(),
      changed: true,
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer-id', role: 'NORMAL_USER', updatedAt: original.updatedAt },
      data: { fullName: 'Amina N. Otieno' },
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CUSTOMER_PROFILE_UPDATED',
        details: { before: { fullName: 'Amina Otieno' }, after: { fullName: 'Amina N. Otieno' } },
      }),
    });
  });

  it('rejects stale profile versions and short change reasons', async () => {
    const customer = {
      id: 'customer-id',
      role: 'NORMAL_USER',
      fullName: 'Amina Otieno',
      updatedAt: new Date('2026-10-18T20:00:00.000Z'),
    };
    const tx = {
      user: { findUnique: jest.fn().mockResolvedValue(customer), updateMany: jest.fn() },
      adminAuditLog: { create: jest.fn() },
    };
    const service = new AdminService({
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService);

    await expect(service.updateCustomerProfile(
      'customer-id', 'Amina Otieno', '2026-10-18T19:00:00.000Z', 'Valid reason for change', 'admin-id',
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(service.updateCustomerProfile(
      'customer-id', 'Amina Otieno', customer.updatedAt.toISOString(), 'short', 'admin-id',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('filters and paginates audit records server-side with safe details', async () => {
    const count = jest.fn().mockResolvedValue(1);
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new AdminService({
      adminAuditLog: { count, findMany },
    } as unknown as PrismaService);

    const result = await service.getAuditEvents({
      search: 'profile',
      actorId: 'admin-id',
      action: 'CUSTOMER_PROFILE_UPDATED',
      resourceType: 'CUSTOMER',
      outcome: 'SUCCESS',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-18T23:59:59.999Z'),
      page: 2,
      pageSize: 25,
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: expect.arrayContaining([
        expect.objectContaining({ superadminId: 'admin-id' }),
        expect.objectContaining({ action: { contains: 'CUSTOMER_PROFILE_UPDATED', mode: 'insensitive' } }),
        expect.objectContaining({ subjectType: 'CUSTOMER' }),
        expect.objectContaining({ outcome: 'SUCCESS' }),
      ]) },
      select: expect.objectContaining({ details: true }),
      skip: 25,
      take: 25,
    }));
    expect(result).toEqual({ items: [], total: 1, page: 2, pageSize: 25, pageCount: 1 });
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

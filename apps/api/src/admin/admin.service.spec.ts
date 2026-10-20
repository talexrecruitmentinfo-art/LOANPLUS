import { IdentityStatus, PaymentStatus, PaymentType } from '@prisma/client';
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
          { phone: { contains: 'Amina', mode: 'insensitive' } },
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
    expect(query.select).toHaveProperty('ledgerTransaction.select.internalReference', true);
    expect(query.select).toHaveProperty('ledgerTransaction.select.entries.select.account.select.currency', true);
    expect(query.select).not.toHaveProperty('activationRequest.select.payload');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
  });

  it('flags confirmed wallet deposits whose posted journal has an amount mismatch', async () => {
    const paymentTransaction = {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([
        {
          type: PaymentType.WALLET_DEPOSIT,
          amountKes: 100,
          currency: 'KES',
          userId: 'customer-id',
          status: PaymentStatus.CONFIRMED,
          activationRequest: { callbackEvents: [] },
          ledgerTransaction: {
            status: 'POSTED',
            entries: [
              { debitKes: 100, creditKes: 0, account: { code: 'MPESA_CLEARING', userId: null, accountType: 'ASSET', currency: 'KES' } },
              { debitKes: 0, creditKes: 90, account: { code: 'WALLET_customer-id', userId: 'customer-id', accountType: 'LIABILITY', currency: 'KES' } },
            ],
          },
        },
        {
          type: PaymentType.WALLET_DEPOSIT,
          amountKes: 200,
          currency: 'KES',
          userId: 'second-customer-id',
          status: PaymentStatus.CONFIRMED,
          activationRequest: { callbackEvents: [] },
          ledgerTransaction: null,
        },
        {
          type: PaymentType.WALLET_DEPOSIT,
          amountKes: 300,
          currency: 'KES',
          userId: 'third-customer-id',
          status: PaymentStatus.PENDING,
          activationRequest: { callbackEvents: [{ providerResultCode: '4999' }] },
          ledgerTransaction: null,
        },
      ]),
    };
    const service = new AdminService({ paymentTransaction } as unknown as PrismaService);

    const result = await service.listPayments({ page: 1, pageSize: 25 });

    expect(result.items[0].settlementIssues).toEqual(['LEDGER_AMOUNT_MISMATCH', 'WALLET_CREDIT_MISMATCH']);
    expect(result.items[1].settlementIssues).toContain('MISSING_LEDGER_TRANSACTION');
    expect(result.items[2].settlementIssues).toContain('UNRESOLVED_PROVIDER_CALLBACK');
    expect(result.items[0]).not.toHaveProperty('userId');
  });

  it('returns bounded customer activity while excluding credentials and raw identity/payment payloads', async () => {
    const customer = { id: 'customer-id', fullName: 'Amina' };
    const findUnique = jest.fn(async (_query: Record<string, unknown>) => customer);
    const identityReviewLookup = jest.fn().mockResolvedValue(null);
    const service = new AdminService({
      user: { findUnique },
      adminAuditLog: { findFirst: identityReviewLookup },
    } as unknown as PrismaService);

    await expect(service.getCustomerDetails('customer-id')).resolves.toMatchObject({
      ...customer,
      identityReview: null,
    });

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
    expect(identityReviewLookup).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        subjectType: 'CUSTOMER',
        subjectId: 'customer-id',
        action: { in: ['CUSTOMER_IDENTITY_VERIFIED', 'CUSTOMER_IDENTITY_REJECTED'] },
      }),
      select: expect.objectContaining({
        superadmin: { select: { email: true } },
      }),
    }));
  });

  it('returns an explicit not-found result for a missing customer', async () => {
    const findUnique = jest.fn(async (_query: Record<string, unknown>) => null);
    const service = new AdminService({
      user: { findUnique },
      adminAuditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService);

    await expect(service.getCustomerDetails('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the latest identity decision actor and time without exposing the review note', async () => {
    const customer = {
      id: 'customer-id',
      role: 'NORMAL_USER',
      identityStatus: IdentityStatus.VERIFIED,
    };
    const reviewAt = new Date('2026-10-19T20:00:00.000Z');
    const service = new AdminService({
      user: { findUnique: jest.fn().mockResolvedValue(customer) },
      adminAuditLog: {
        findFirst: jest.fn().mockResolvedValue({
          action: 'CUSTOMER_IDENTITY_VERIFIED',
          createdAt: reviewAt,
          superadmin: { email: 'reviewer@example.invalid' },
          reason: 'Review note must not be returned',
        }),
      },
    } as unknown as PrismaService);

    const details = await service.getCustomerDetails('customer-id');

    expect(details.identityReview).toEqual({
      status: IdentityStatus.VERIFIED,
      reviewerEmail: 'reviewer@example.invalid',
      reviewedAt: reviewAt,
    });
    expect(details).not.toHaveProperty('nationalIdCiphertext');
    expect(details).not.toHaveProperty('reason');
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

  describe('customer identity decisions', () => {
    const reason = 'Reviewed approved identity evidence';

    it('marks an identity verified atomically and audits actor, previous status, new status, timestamp, and reason', async () => {
      const customer = { id: 'customer-id', role: 'NORMAL_USER', identityStatus: IdentityStatus.PENDING };
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue(customer),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        adminAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
      };
      const transaction = jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
      const service = new AdminService({ $transaction: transaction } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'customer-id',
        IdentityStatus.VERIFIED,
        reason,
        true,
        'superadmin-id',
        '127.0.0.1',
      )).resolves.toEqual({
        id: 'customer-id',
        identityStatus: IdentityStatus.VERIFIED,
        changed: true,
      });
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'customer-id', role: 'NORMAL_USER', identityStatus: IdentityStatus.PENDING },
        data: { identityStatus: IdentityStatus.VERIFIED },
      });
      expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          superadminId: 'superadmin-id',
          action: 'CUSTOMER_IDENTITY_VERIFIED',
          subjectType: 'CUSTOMER',
          subjectId: 'customer-id',
          outcome: 'SUCCESS',
          reason,
          createdAt: expect.any(Date),
          details: {
            before: { identityStatus: IdentityStatus.PENDING },
            after: { identityStatus: IdentityStatus.VERIFIED },
          },
          ipAddress: '127.0.0.1',
        }),
      });
    });

    it('allows rejection with a required note and writes a rejected decision audit', async () => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'customer-id',
            role: 'NORMAL_USER',
            identityStatus: IdentityStatus.NEEDS_REVIEW,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        adminAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
      };
      const service = new AdminService({
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.REJECTED, 'Required identity details do not match', true, 'superadmin-id',
      )).resolves.toMatchObject({ identityStatus: IdentityStatus.REJECTED, changed: true });
      expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'CUSTOMER_IDENTITY_REJECTED',
          reason: 'Required identity details do not match',
          details: {
            before: { identityStatus: IdentityStatus.NEEDS_REVIEW },
            after: { identityStatus: IdentityStatus.REJECTED },
          },
        }),
      });
    });

    it('approves without a typed reason and records a default audit note', async () => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'customer-id',
            role: 'NORMAL_USER',
            identityStatus: IdentityStatus.PENDING,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        adminAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
      };
      const service = new AdminService({
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.VERIFIED, undefined, true, 'superadmin-id',
      )).resolves.toMatchObject({ identityStatus: IdentityStatus.VERIFIED, changed: true });
      expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          superadminId: 'superadmin-id',
          action: 'CUSTOMER_IDENTITY_VERIFIED',
          subjectId: 'customer-id',
          reason: 'Approved after completed identity review.',
          details: {
            before: { identityStatus: IdentityStatus.PENDING },
            after: { identityStatus: IdentityStatus.VERIFIED },
          },
        }),
      });
    });

    it('rejects missing review confirmation, invalid decision states, short notes, and National ID-like numbers', async () => {
      const service = new AdminService({} as PrismaService);
      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.VERIFIED, reason, false, 'superadmin-id',
      )).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.PENDING, reason, true, 'superadmin-id',
      )).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.REJECTED, 'Too short', true, 'superadmin-id',
      )).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.REJECTED, undefined, true, 'superadmin-id',
      )).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.REJECTED, 'National ID 1234 5678 was checked', true, 'superadmin-id',
      )).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not permit reversing a verified identity to rejected', async () => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'customer-id',
            role: 'NORMAL_USER',
            identityStatus: IdentityStatus.VERIFIED,
          }),
          updateMany: jest.fn(),
        },
        adminAuditLog: { create: jest.fn() },
      };
      const service = new AdminService({
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.REJECTED, reason, true, 'superadmin-id',
      )).rejects.toBeInstanceOf(ConflictException);
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    });

    it('does not reject an identity that has not entered review', async () => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'customer-id',
            role: 'NORMAL_USER',
            identityStatus: IdentityStatus.NOT_STARTED,
          }),
          updateMany: jest.fn(),
        },
        adminAuditLog: { create: jest.fn() },
      };
      const service = new AdminService({
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.REJECTED, reason, true, 'superadmin-id',
      )).rejects.toBeInstanceOf(ConflictException);
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    });

    it('does not change identity status on privileged or missing accounts', async () => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'superadmin-customer-id',
            role: 'SUPERADMIN',
            identityStatus: IdentityStatus.NOT_STARTED,
          }),
          updateMany: jest.fn(),
        },
        adminAuditLog: { create: jest.fn() },
      };
      const service = new AdminService({
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'superadmin-customer-id', IdentityStatus.VERIFIED, reason, true, 'superadmin-id',
      )).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    });

    it('treats a repeated decision as idempotent and avoids duplicate audit events', async () => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'customer-id',
            role: 'NORMAL_USER',
            identityStatus: IdentityStatus.VERIFIED,
          }),
          updateMany: jest.fn(),
        },
        adminAuditLog: { create: jest.fn() },
      };
      const service = new AdminService({
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.VERIFIED, reason, true, 'superadmin-id',
      )).resolves.toEqual({ id: 'customer-id', identityStatus: IdentityStatus.VERIFIED, changed: false });
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    });

    it('returns unchanged when a concurrent request already applied the same decision', async () => {
      const tx = {
        user: {
          findUnique: jest.fn()
            .mockResolvedValueOnce({ id: 'customer-id', role: 'NORMAL_USER', identityStatus: IdentityStatus.PENDING })
            .mockResolvedValueOnce({ id: 'customer-id', role: 'NORMAL_USER', identityStatus: IdentityStatus.VERIFIED }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        adminAuditLog: { create: jest.fn() },
      };
      const service = new AdminService({
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      } as unknown as PrismaService);

      await expect(service.updateCustomerIdentityStatus(
        'customer-id', IdentityStatus.VERIFIED, reason, true, 'superadmin-id',
      )).resolves.toEqual({ id: 'customer-id', identityStatus: IdentityStatus.VERIFIED, changed: false });
      expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    });
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

  it('withholds free-form identity review notes from audit API responses', async () => {
    const service = new AdminService({
      adminAuditLog: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{
          id: 'audit-id',
          action: 'CUSTOMER_IDENTITY_VERIFIED',
          subjectType: 'CUSTOMER',
          subjectId: 'customer-id',
          outcome: 'SUCCESS',
          reason: 'Private review note',
          details: {
            before: { identityStatus: IdentityStatus.PENDING },
            after: { identityStatus: IdentityStatus.VERIFIED },
          },
          createdAt: new Date('2026-10-19T20:00:00.000Z'),
          superadmin: { id: 'admin-id', email: 'admin@example.invalid' },
        }]),
      },
    } as unknown as PrismaService);

    const result = await service.getAuditEvents({ page: 1, pageSize: 25 });

    expect(result.items[0]).toMatchObject({
      action: 'CUSTOMER_IDENTITY_VERIFIED',
      reason: null,
    });
    expect(result.items[0].reason).not.toBe('Private review note');
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

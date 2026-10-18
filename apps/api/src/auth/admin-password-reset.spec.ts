import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { MailService } from './mail.service';

describe('Admin customer password reset', () => {
  const customer = {
    id: 'customer-id',
    email: 'customer@example.invalid',
    role: 'NORMAL_USER',
    isActive: true,
  };

  it('stores only a hashed single-use token, sends through the existing mail service, and audits without exposing it', async () => {
    const createToken = jest.fn(async ({ data }: { data: { tokenHash: string; expiresAt: Date } }) => ({
      id: 'reset-id',
      ...data,
    }));
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-id' });
    const tx = {
      passwordResetToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: createToken,
      },
      adminAuditLog: { create: auditCreate },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(customer) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      adminAuditLog: { create: auditCreate },
    };
    const mail = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(prisma as unknown as PrismaService, mail as unknown as MailService);

    const result = await service.requestCustomerPasswordReset(
      customer.id,
      'admin-id',
      'Customer verified identity and requested account recovery',
      '127.0.0.1',
    );

    const stored = createToken.mock.calls[0][0].data;
    const deliveredToken = mail.sendPasswordReset.mock.calls[0][1];
    expect(stored.tokenHash).not.toBe(deliveredToken);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result).toEqual({ requested: true, delivery: 'SENT' });
    expect(JSON.stringify(result)).not.toContain(deliveredToken);
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'CUSTOMER_PASSWORD_RESET_DELIVERY',
        outcome: 'SENT',
      }),
    }));
  });

  it('invalidates the reset token and records delivery failure without exposing the reset link', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      passwordResetToken: { updateMany, create: jest.fn().mockResolvedValue({ id: 'reset-id' }) },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(customer) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const mail = { sendPasswordReset: jest.fn().mockRejectedValue(new Error('mail provider unavailable')) };
    const service = new AuthService(prisma as unknown as PrismaService, mail as unknown as MailService);

    await expect(service.requestCustomerPasswordReset(
      customer.id, 'admin-id', 'Customer verified identity and requested account recovery',
    )).resolves.toEqual({ requested: true, delivery: 'UNAVAILABLE' });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(tx.adminAuditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'CUSTOMER_PASSWORD_RESET_DELIVERY',
        outcome: 'UNAVAILABLE',
      }),
    }));
  });

  it('rejects privileged or disabled accounts and invalid reasons', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ ...customer, role: 'SUPERADMIN' }) },
    };
    const service = new AuthService(prisma as unknown as PrismaService, {} as MailService);

    await expect(service.requestCustomerPasswordReset(
      customer.id, 'admin-id', 'A sufficiently long reason',
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.requestCustomerPasswordReset(
      customer.id, 'admin-id', 'short',
    )).rejects.toBeInstanceOf(BadRequestException);
  });
});

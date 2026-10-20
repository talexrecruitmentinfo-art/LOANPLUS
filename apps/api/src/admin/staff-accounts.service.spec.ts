import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { MailService } from '../auth/mail.service';
import { hashToken } from '../auth/security.util';
import type { PrismaService } from '../prisma/prisma.service';
import { STAFF_ROLES, StaffAccountsService } from './staff-accounts.service';

describe('StaffAccountsService', () => {
  const staffMember = {
    id: 'staff-id',
    email: 'new.staff@example.invalid',
    fullName: 'New Staff',
    phone: '+254712345678',
    role: Role.STAFF_SUPPORT,
    isActive: true,
    emailVerifiedAt: null,
  };

  it('creates least-privilege staff and stores only a hashed invitation token', async () => {
    const createdInvitations: Array<{ tokenHash: string; expiresAt: Date }> = [];
    const audits: Array<{ data: Record<string, unknown> }> = [];
    const tx = {
      superadminUser: {
        create: jest.fn(async () => ({ id: staffMember.id })),
      },
      staffInvitation: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }: { data: { tokenHash: string; expiresAt: Date } }) => {
          createdInvitations.push(data);
          return { id: 'invitation-id' };
        }),
      },
      adminAuditLog: {
        create: jest.fn(async (input: { data: Record<string, unknown> }) => {
          audits.push(input);
          return {};
        }),
      },
    };
    const transact = async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx);
    const prisma = {
      superadminUser: {
        findUnique: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) =>
          where.email ? null : staffMember),
      },
      user: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(transact),
    } as unknown as PrismaService;
    const sendStaffInvitation = jest.fn(async () => undefined);
    const service = new StaffAccountsService(prisma, { sendStaffInvitation } as unknown as MailService);

    await expect(service.createStaff({
      fullName: ' New   Staff ',
      email: ' NEW.STAFF@example.invalid ',
      phone: '0712345678',
      role: Role.STAFF_SUPPORT,
      reason: 'Provision support access for the new team member',
    }, 'superadmin-id', '127.0.0.1')).resolves.toEqual({
      staffId: 'staff-id',
      invitationSent: true,
    });

    const [, invitationToken] = sendStaffInvitation.mock.calls[0] as unknown as [string, string];
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createdInvitations).toHaveLength(1);
    expect(createdInvitations[0].tokenHash).toBe(hashToken(invitationToken));
    expect(createdInvitations[0].tokenHash).not.toBe(invitationToken);
    expect(audits.some(({ data }) => JSON.stringify(data).includes(invitationToken))).toBe(false);
    expect(audits[0].data).toMatchObject({
      superadminId: 'superadmin-id',
      action: 'STAFF_ACCOUNT_CREATED',
      subjectId: 'staff-id',
      outcome: 'SUCCESS',
    });
    expect(audits[1].data).toMatchObject({
      action: 'STAFF_INVITATION_SENT',
      reason: 'Provision support access for the new team member',
    });
    expect(STAFF_ROLES).not.toContain(Role.SUPERADMIN);
  });

  it('rejects duplicate email addresses across staff and customer accounts', async () => {
    const prisma = {
      superadminUser: { findUnique: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => ({ id: 'customer-id' })) },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const service = new StaffAccountsService(prisma, { sendStaffInvitation: jest.fn() } as unknown as MailService);

    await expect(service.createStaff({
      fullName: 'New Staff',
      email: 'existing@example.invalid',
      role: Role.STAFF_SUPPORT,
      reason: 'Provision staff account for support work',
    }, 'superadmin-id')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects granting the Superadmin role through staff account creation', async () => {
    const service = new StaffAccountsService({} as PrismaService, {} as MailService);

    await expect(service.createStaff({
      fullName: 'New Staff',
      email: 'new.staff@example.invalid',
      role: Role.SUPERADMIN as never,
      reason: 'Attempt to provision unrestricted access',
    }, 'superadmin-id')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects expired invitations and single-use token replays', async () => {
    const token = 'a'.repeat(43);
    const expiredService = new StaffAccountsService({
      staffInvitation: {
        findUnique: jest.fn(async () => ({
          id: 'expired-invitation',
          staffUserId: 'staff-id',
          expiresAt: new Date(Date.now() - 1),
          usedAt: null,
          invalidatedAt: null,
        })),
      },
    } as unknown as PrismaService, {} as MailService);
    await expect(expiredService.completeInvitation(token, 'a-secure-password', 'a-secure-password'))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const tx = {
      staffInvitation: { updateMany: jest.fn(async () => ({ count: 0 })) },
      superadminUser: { findFirst: jest.fn() },
      adminAuditLog: { create: jest.fn() },
      authAuditLog: { create: jest.fn() },
    };
    const transact = async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx);
    const replayService = new StaffAccountsService({
      staffInvitation: {
        findUnique: jest.fn(async () => ({
          id: 'used-invitation',
          staffUserId: 'staff-id',
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
          invalidatedAt: null,
        })),
      },
      $transaction: jest.fn(transact),
    } as unknown as PrismaService, {} as MailService);
    await expect(replayService.completeInvitation(token, 'a-secure-password', 'a-secure-password'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.superadminUser.findFirst).not.toHaveBeenCalled();
  });

  it('completes a valid invitation once without exposing password data in the audit record', async () => {
    const token = 'b'.repeat(43);
    const auditRecords: Array<{ data: Record<string, unknown> }> = [];
    const updateStaff = jest.fn(async (_input: {
      where: { id: string };
      data: { passwordHash: string; emailVerifiedAt: Date };
    }) => ({}));
    const tx = {
      staffInvitation: { updateMany: jest.fn(async () => ({ count: 1 })) },
      superadminUser: {
        findFirst: jest.fn(async () => ({ id: 'staff-id' })),
        update: updateStaff,
      },
      adminAuditLog: {
        create: jest.fn(async (input: { data: Record<string, unknown> }) => {
          auditRecords.push(input);
          return {};
        }),
      },
      authAuditLog: { create: jest.fn(async () => ({})) },
    };
    const transact = async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx);
    const prisma = {
      staffInvitation: {
        findUnique: jest.fn(async () => ({
          id: 'invitation-id',
          staffUserId: 'staff-id',
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
          invalidatedAt: null,
        })),
      },
      $transaction: jest.fn(transact),
    } as unknown as PrismaService;
    const service = new StaffAccountsService(prisma, {} as MailService);
    const password = 'a-secure-password';

    await expect(service.completeInvitation(token, password, password, '127.0.0.1'))
      .resolves.toEqual({ setupComplete: true });

    const storedPasswordHash = updateStaff.mock.calls[0][0].data.passwordHash as string;
    expect(storedPasswordHash).not.toBe(password);
    expect(storedPasswordHash).toMatch(/^\$2[aby]\$/);
    expect(tx.staffInvitation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenHash: hashToken(token), usedAt: null }),
    }));
    expect(JSON.stringify(auditRecords)).not.toContain(password);
    expect(JSON.stringify(auditRecords)).not.toContain(token);
    expect(tx.authAuditLog.create).toHaveBeenCalledTimes(1);
  });
});

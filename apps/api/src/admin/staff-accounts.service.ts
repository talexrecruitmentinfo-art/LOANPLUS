import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { MailService } from '../auth/mail.service';
import {
  assertMatchingPasswords,
  createOpaqueToken,
  hashToken,
  normalizeEmail,
  normalizeKenyaPhone,
} from '../auth/security.util';
import { PrismaService } from '../prisma/prisma.service';

export const STAFF_ROLES = [Role.STAFF_SUPPORT, Role.STAFF_FINANCE, Role.STAFF_OPERATIONS] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
const STAFF_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export const STAFF_ROLE_OPTIONS = [
  { role: Role.STAFF_SUPPORT, label: 'Support', permissions: ['support:read', 'support:reply'] },
  { role: Role.STAFF_FINANCE, label: 'Finance', permissions: ['payments:read', 'reconciliation:read'] },
  { role: Role.STAFF_OPERATIONS, label: 'Operations', permissions: ['loans:read'] },
] as const;

function isStaffRole(role: Role): role is StaffRole {
  return STAFF_ROLES.includes(role as StaffRole);
}

@Injectable()
export class StaffAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async listStaff(search?: string) {
    const query = search?.trim().slice(0, 100);
    const staff = await this.prisma.superadminUser.findMany({
      where: {
        role: { in: [...STAFF_ROLES] },
        ...(query ? {
          OR: [
            { email: { contains: query, mode: 'insensitive' } },
            { fullName: { contains: query, mode: 'insensitive' } },
          ],
        } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { email: 'asc' }],
      take: 200,
      include: {
        sessions: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        receivedStaffInvitations: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, expiresAt: true, usedAt: true, invalidatedAt: true },
        },
      },
    });
    const now = new Date();
    return {
      items: staff.map((member) => {
        const invitation = member.receivedStaffInvitations[0];
        return {
          id: member.id,
          fullName: member.fullName ?? '',
          email: member.email,
          phone: member.phone,
          role: member.role,
          isActive: member.isActive,
          status: !member.isActive
            ? 'SUSPENDED'
            : member.emailVerifiedAt
              ? 'ACTIVE'
              : invitation && invitation.expiresAt > now && !invitation.invalidatedAt && !invitation.usedAt
                ? 'INVITATION_PENDING'
                : 'INVITATION_EXPIRED',
          invitationId: invitation?.id ?? null,
          invitationExpiresAt: invitation?.expiresAt ?? null,
          lastLoginAt: member.sessions[0]?.createdAt ?? null,
          createdAt: member.createdAt,
        };
      }),
      roles: STAFF_ROLE_OPTIONS,
    };
  }

  async createStaff(
    input: {
      fullName: string;
      email: string;
      phone?: string;
      role: StaffRole;
      reason: string;
    },
    actorId: string,
    ipAddress?: string,
  ) {
    const reason = this.validateReason(input.reason);
    const email = normalizeEmail(input.email);
    const fullName = this.normalizeName(input.fullName);
    const phone = input.phone?.trim() ? normalizeKenyaPhone(input.phone) : null;
    if (!STAFF_ROLES.includes(input.role)) {
      throw new ForbiddenException('This role cannot be assigned to a staff account.');
    }
    const [staffEmail, customerEmail] = await Promise.all([
      this.prisma.superadminUser.findUnique({ where: { email }, select: { id: true } }),
      this.prisma.user.findUnique({ where: { email }, select: { id: true } }),
    ]);
    if (staffEmail || customerEmail) {
      throw new ConflictException('Some of the details provided are already registered.');
    }

    const initialPasswordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 12);
    let staff: { id: string };
    try {
      staff = await this.prisma.$transaction(async (tx) => {
        const created = await tx.superadminUser.create({
          data: {
            fullName,
            email,
            phone,
            role: input.role,
            isActive: true,
            emailVerifiedAt: null,
            passwordHash: initialPasswordHash,
          },
          select: { id: true },
        });
        await tx.adminAuditLog.create({
          data: {
            superadminId: actorId,
            action: 'STAFF_ACCOUNT_CREATED',
            subjectType: 'STAFF_ACCOUNT',
            subjectId: created.id,
            outcome: 'SUCCESS',
            reason,
            details: {
              changedFields: ['fullName', 'email', 'phone', 'role', 'isActive'],
              before: null,
              after: { fullName, email, phone, role: input.role, isActive: true },
            },
            ipAddress: ipAddress?.slice(0, 64),
          },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Some of the details provided are already registered.');
      }
      throw error;
    }

    await this.issueInvitation(staff.id, actorId, reason, ipAddress, true);
    return { staffId: staff.id, invitationSent: true };
  }

  async updateStaffDetails(
    staffId: string,
    input: { fullName: string; phone?: string },
    actorId: string,
    reason: string,
    ipAddress?: string,
  ) {
    const auditReason = this.validateReason(reason);
    const fullName = this.normalizeName(input.fullName);
    const phone = input.phone?.trim() ? normalizeKenyaPhone(input.phone) : null;
    const previous = await this.requireStaff(staffId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.superadminUser.update({
        where: { id: staffId },
        data: { fullName, phone },
        select: { id: true, fullName: true, email: true, phone: true, role: true, isActive: true },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: 'STAFF_DETAILS_UPDATED',
          subjectType: 'STAFF_ACCOUNT',
          subjectId: staffId,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: {
            changedFields: [
              ...(previous.fullName !== fullName ? ['fullName'] : []),
              ...(previous.phone !== phone ? ['phone'] : []),
            ],
            before: { fullName: previous.fullName, phone: previous.phone },
            after: { fullName, phone },
          },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return result;
    });
    return updated;
  }

  async updateStaffRole(
    staffId: string,
    role: StaffRole,
    actorId: string,
    reason: string,
    ipAddress?: string,
  ) {
    const auditReason = this.validateReason(reason);
    if (!STAFF_ROLES.includes(role)) throw new ForbiddenException('This role cannot be assigned to a staff account.');
    const previous = await this.requireStaff(staffId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.superadminUser.update({
        where: { id: staffId },
        data: { role },
        select: { id: true, email: true, role: true, isActive: true },
      });
      await tx.superadminSession.updateMany({
        where: { superadminId: staffId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: 'STAFF_ROLE_UPDATED',
          subjectType: 'STAFF_ACCOUNT',
          subjectId: staffId,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: {
            changedFields: previous.role === role ? [] : ['role'],
            before: { role: previous.role },
            after: { role },
          },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return updated;
    });
  }

  async updateStaffStatus(
    staffId: string,
    isActive: boolean,
    actorId: string,
    reason: string,
    ipAddress?: string,
  ) {
    const auditReason = this.validateReason(reason);
    const previous = await this.requireStaff(staffId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.superadminUser.update({
        where: { id: staffId },
        data: { isActive },
        select: { id: true, email: true, role: true, isActive: true },
      });
      if (!isActive) {
        await tx.superadminSession.updateMany({
          where: { superadminId: staffId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: isActive ? 'STAFF_ACCOUNT_REACTIVATED' : 'STAFF_ACCOUNT_SUSPENDED',
          subjectType: 'STAFF_ACCOUNT',
          subjectId: staffId,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: {
            changedFields: previous.isActive === isActive ? [] : ['isActive'],
            before: { isActive: previous.isActive },
            after: { isActive },
          },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return updated;
    });
  }

  async revokeStaffSessions(staffId: string, actorId: string, reason: string, ipAddress?: string) {
    const auditReason = this.validateReason(reason);
    await this.requireStaff(staffId);
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.superadminSession.updateMany({
        where: { superadminId: staffId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: 'STAFF_SESSIONS_REVOKED',
          subjectType: 'STAFF_ACCOUNT',
          subjectId: staffId,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: { changedFields: ['activeSessions'], after: { revokedCount: result.count } },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return { revokedCount: result.count };
    });
  }

  async resendInvitation(staffId: string, actorId: string, reason: string, ipAddress?: string) {
    const auditReason = this.validateReason(reason);
    const staff = await this.requireStaff(staffId);
    if (!staff.isActive || staff.emailVerifiedAt) {
      throw new ConflictException('An invitation can only be resent to an active staff account that has not completed setup.');
    }
    await this.issueInvitation(staffId, actorId, auditReason, ipAddress, false);
    return { invitationSent: true };
  }

  async revokeInvitation(
    staffId: string,
    invitationId: string,
    actorId: string,
    reason: string,
    ipAddress?: string,
  ) {
    const auditReason = this.validateReason(reason);
    const staff = await this.requireStaff(staffId);
    if (staff.emailVerifiedAt) throw new ConflictException('The staff invitation has already been used.');
    return this.prisma.$transaction(async (tx) => {
      const invalidated = await tx.staffInvitation.updateMany({
        where: {
          id: invitationId,
          staffUserId: staffId,
          usedAt: null,
          invalidatedAt: null,
        },
        data: { invalidatedAt: new Date() },
      });
      if (invalidated.count !== 1) throw new ConflictException('The invitation is no longer active.');
      await tx.superadminUser.update({ where: { id: staffId }, data: { isActive: false } });
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: 'STAFF_INVITATION_REVOKED',
          subjectType: 'STAFF_ACCOUNT',
          subjectId: staffId,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: { changedFields: ['invitationStatus', 'isActive'], after: { invitationStatus: 'REVOKED' } },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return { revoked: true };
    });
  }

  async getStaffAuditHistory(staffId: string) {
    await this.requireStaff(staffId);
    const events = await this.prisma.adminAuditLog.findMany({
      where: { subjectType: 'STAFF_ACCOUNT', subjectId: staffId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { superadmin: { select: { email: true } } },
    });
    return events.map((event) => ({
      id: event.id,
      action: event.action,
      actorId: event.superadminId,
      actorEmail: event.superadmin?.email ?? null,
      reason: event.reason,
      details: event.details,
      createdAt: event.createdAt,
      outcome: event.outcome,
    }));
  }

  async completeInvitation(token: string, password: string, confirmPassword: string, ipAddress?: string) {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
      throw new UnauthorizedException('This staff invitation is invalid or expired.');
    }
    assertMatchingPasswords(password, confirmPassword);
    if (password.length < 12) throw new UnprocessableEntityException('Password must be at least 12 characters.');
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, staffUserId: true, expiresAt: true, usedAt: true, invalidatedAt: true },
    });
    if (!invitation || invitation.usedAt || invitation.invalidatedAt || invitation.expiresAt <= now) {
      throw new UnauthorizedException('This staff invitation is invalid or expired.');
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.staffInvitation.updateMany({
        where: {
          id: invitation.id,
          tokenHash: hashToken(token),
          usedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new UnauthorizedException('This staff invitation is invalid or expired.');
      const staff = await tx.superadminUser.findFirst({
        where: { id: invitation.staffUserId, role: { in: [...STAFF_ROLES] }, isActive: true, emailVerifiedAt: null },
        select: { id: true },
      });
      if (!staff) throw new UnauthorizedException('This staff invitation is invalid or expired.');
      await tx.superadminUser.update({
        where: { id: staff.id },
        data: { passwordHash, emailVerifiedAt: now },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: staff.id,
          action: 'STAFF_INVITATION_ACCEPTED',
          subjectType: 'STAFF_ACCOUNT',
          subjectId: staff.id,
          outcome: 'SUCCESS',
          reason: 'Staff completed the single-use invitation setup.',
          details: { changedFields: ['password', 'emailVerifiedAt'], after: { emailVerified: true } },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      await tx.authAuditLog.create({
        data: {
          actorType: 'STAFF',
          actorId: staff.id,
          action: 'STAFF_INVITATION_ACCEPTED',
          outcome: 'SUCCESS',
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });
    return { setupComplete: true };
  }

  private async issueInvitation(
    staffId: string,
    actorId: string,
    reason: string,
    ipAddress: string | undefined,
    disableOnFailure: boolean,
  ): Promise<void> {
    const member = await this.requireStaff(staffId);
    const token = createOpaqueToken();
    const expiresAt = new Date(Date.now() + STAFF_INVITATION_TTL_MS);
    const invitation = await this.prisma.$transaction(async (tx) => {
      await tx.staffInvitation.updateMany({
        where: { staffUserId: staffId, usedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
      const created = await tx.staffInvitation.create({
        data: {
          staffUserId: staffId,
          invitedById: actorId,
          tokenHash: hashToken(token),
          expiresAt,
        },
        select: { id: true },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: 'STAFF_INVITATION_SENT',
          subjectType: 'STAFF_ACCOUNT',
          subjectId: staffId,
          outcome: 'SUCCESS',
          reason,
          details: {
            changedFields: ['invitation'],
            after: { email: member.email, expiresAt: expiresAt.toISOString() },
          },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return created;
    });

    try {
      await this.mail.sendStaffInvitation(member.email, token);
    } catch (error) {
      await this.prisma.$transaction(async (tx) => {
        await tx.staffInvitation.updateMany({
          where: { id: invitation.id, usedAt: null, invalidatedAt: null },
          data: { invalidatedAt: new Date() },
        });
        if (disableOnFailure) {
          await tx.superadminUser.update({ where: { id: staffId }, data: { isActive: false } });
        }
        await tx.adminAuditLog.create({
          data: {
            superadminId: actorId,
            action: 'STAFF_INVITATION_DELIVERY_FAILED',
            subjectType: 'STAFF_ACCOUNT',
            subjectId: staffId,
            outcome: 'FAILURE',
            reason,
            details: { changedFields: ['invitationStatus'], after: { invitationStatus: 'DELIVERY_FAILED' } },
            ipAddress: ipAddress?.slice(0, 64),
          },
        });
      });
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Staff invitation delivery is unavailable.');
    }
  }

  private async requireStaff(staffId: string) {
    const staff = await this.prisma.superadminUser.findUnique({
      where: { id: staffId },
      select: { id: true, email: true, fullName: true, phone: true, role: true, isActive: true, emailVerifiedAt: true },
    });
    if (!staff || !isStaffRole(staff.role)) throw new NotFoundException('Staff account was not found.');
    return staff;
  }

  private normalizeName(value: string): string {
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 160) {
      throw new UnprocessableEntityException('Staff name must be between 2 and 160 characters.');
    }
    return name;
  }

  private validateReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed.length < 10 || trimmed.length > 500) {
      throw new UnprocessableEntityException('A staff account change reason must be 10 to 500 non-whitespace characters.');
    }
    return trimmed;
  }
}

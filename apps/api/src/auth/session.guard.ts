import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, normalizeEmail, type AuthPrincipal } from './security.util';

type AuthenticatedRequest = Request & { principal?: AuthPrincipal };
const STAFF_ROLE_METADATA = 'staff-allowed-roles';

export const AllowStaffRoles = (...roles: Array<'STAFF_SUPPORT' | 'STAFF_FINANCE' | 'STAFF_OPERATIONS'>) =>
  SetMetadata(STAFF_ROLE_METADATA, roles);

@Injectable()
export class CustomerSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.lp_customer_session as string | undefined;
    if (!token) throw new UnauthorizedException('Authentication required.');
    const sessionHash = hashToken(token);
    const session = await this.prisma.customerSession.findFirst({
      where: { tokenHash: sessionHash, revokedAt: null, expiresAt: { gt: new Date() }, user: { isActive: true } },
      include: { user: { select: { id: true, role: true, email: true, phone: true, fullName: true, identityStatus: true, referralCode: true } } },
    });
    if (!session || session.user.role !== 'NORMAL_USER') {
      throw new UnauthorizedException('Authentication required.');
    }
    request.principal = { ...session.user, sessionHash };
    return true;
  }
}

@Injectable()
export class SuperadminSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.lp_admin_session as string | undefined;
    if (!token) throw new UnauthorizedException('Authentication required.');
    const sessionHash = hashToken(token);
    const session = await this.prisma.superadminSession.findFirst({
      where: {
        tokenHash: sessionHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        superadmin: { isActive: true, emailVerifiedAt: { not: null } },
      },
      include: { superadmin: { select: { id: true, role: true, email: true } } },
    });
    if (!session) {
      throw new UnauthorizedException('Authentication required.');
    }
    if (session.superadmin.role === 'SUPERADMIN') {
      const configuredEmail = process.env.SUPERADMIN_EMAIL;
      if (!configuredEmail || normalizeEmail(session.superadmin.email) !== normalizeEmail(configuredEmail)) {
        throw new ForbiddenException('This account is not the designated Superadmin.');
      }
    }
    const allowedStaffRoles = Reflect.getMetadata(STAFF_ROLE_METADATA, context.getHandler()) as
      Array<'STAFF_SUPPORT' | 'STAFF_FINANCE' | 'STAFF_OPERATIONS'> | undefined;
    if (session.superadmin.role !== 'SUPERADMIN' &&
      !(allowedStaffRoles ?? []).includes(session.superadmin.role as 'STAFF_SUPPORT' | 'STAFF_FINANCE' | 'STAFF_OPERATIONS')) {
      throw new ForbiddenException('This account does not have permission to perform this action.');
    }
    request.principal = { ...session.superadmin, sessionHash };
    return true;
  }
}
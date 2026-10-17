import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, type AuthPrincipal } from './security.util';

type AuthenticatedRequest = Request & { principal?: AuthPrincipal };

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
      include: { user: { select: { id: true, role: true, email: true, phone: true, fullName: true, identityStatus: true, activationStatus: true, referralCode: true } } },
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
    if (!session || session.superadmin.role !== 'SUPERADMIN') {
      throw new UnauthorizedException('Authentication required.');
    }
    request.principal = { ...session.superadmin, sessionHash };
    return true;
  }
}
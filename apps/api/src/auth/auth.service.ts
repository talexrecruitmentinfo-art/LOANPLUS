import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertMatchingPasswords,
  createOpaqueToken,
  encryptNationalId,
  hashToken,
  keyedDigest,
  normalizeEmail,
  normalizeKenyaPhone,
  normalizeNationalId,
  type AuthPrincipal,
} from './security.util';
import {
  CustomerLoginDto,
  PasswordChangeDto,
  PasswordResetCompleteDto,
  PasswordResetRequestDto,
  RegisterCustomerDto,
  SuperadminOtpDto,
  SuperadminPasswordDto,
} from './auth.dto';
import { MailService } from './mail.service';

const CUSTOMER_SESSION_MS = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('loanplus-invalid-credential-timing-padding', 12);
const logger = new Logger('AuthService');
const PRISMA_CONNECTIVITY_ERROR_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const PRISMA_SCHEMA_ERROR_CODES = new Set(['P2021', 'P2022']);

type SessionResult<T> = { token: string; principal: T };

function requestContext(requestId?: string): string {
  return `requestId=${requestId ?? 'unavailable'}`;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async registerCustomer(
    dto: RegisterCustomerDto,
    ipAddress?: string,
    requestId?: string,
  ): Promise<SessionResult<Pick<User, 'id' | 'fullName' | 'email' | 'identityStatus' | 'referralCode'>>> {
    try {
      return await this.registerCustomerRecord(dto, ipAddress);
    } catch (error) {
      if (error instanceof HttpException) {
        if (error.getStatus() >= 500) {
          logger.error(`Applicant registration failed with HTTP ${error.getStatus()} (${requestContext(requestId)}).`);
        }
        throw error;
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError
      ) {
        if (PRISMA_CONNECTIVITY_ERROR_CODES.has(error.code)) {
          logger.error(`Applicant registration database connectivity failed (Prisma code ${error.code}; ${requestContext(requestId)}).`);
          throw new ServiceUnavailableException('Registration service is temporarily unavailable.');
        }
        if (PRISMA_SCHEMA_ERROR_CODES.has(error.code)) {
          logger.error(`Applicant registration database schema mismatch (Prisma code ${error.code}; ${requestContext(requestId)}).`);
          throw new InternalServerErrorException('Registration could not be completed.');
        }
        logger.error(`Applicant registration database operation failed (Prisma code ${error.code}; ${requestContext(requestId)}).`);
        throw new InternalServerErrorException('Registration could not be completed.');
      }

      if (
        error instanceof Prisma.PrismaClientUnknownRequestError ||
        error instanceof Prisma.PrismaClientInitializationError ||
        error instanceof Prisma.PrismaClientRustPanicError
      ) {
        logger.error(`Applicant registration database configuration or connection failed (${error.constructor.name}; ${requestContext(requestId)}).`);
        throw new ServiceUnavailableException('Registration service is temporarily unavailable.');
      }

      logger.error(`Applicant registration failed due to an unexpected internal error (${requestContext(requestId)}).`);
      throw new InternalServerErrorException('Registration could not be completed.');
    }
  }

  private async registerCustomerRecord(
    dto: RegisterCustomerDto,
    ipAddress?: string,
  ): Promise<SessionResult<Pick<User, 'id' | 'fullName' | 'email' | 'identityStatus' | 'referralCode'>>> {
    assertMatchingPasswords(dto.password, dto.confirmPassword);
    const email = normalizeEmail(dto.email);
    const phone = normalizeKenyaPhone(dto.phone);
    const nationalId = normalizeNationalId(dto.nationalId);
    const nationalIdHash = keyedDigest(nationalId, 'ID_HASH_KEY');
    const referredByCode = dto.referralCode?.trim().toUpperCase();
    const referrer = referredByCode
      ? await this.prisma.user.findUnique({
          where: { referralCode: referredByCode },
          select: { id: true, email: true, nationalIdHash: true },
        })
      : null;
    if (referredByCode && !referrer) throw new BadRequestException('Referral code is invalid.');
    if (referrer && (referrer.email === email || referrer.nationalIdHash === nationalIdHash)) {
      throw new BadRequestException('Self-referrals are not permitted.');
    }

    const duplicate = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { phone }, { nationalIdHash }] },
      select: { id: true },
    });
    if (duplicate) throw new ConflictException('Some of the details provided are already registered.');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const configuredTermsVersion = process.env.TERMS_VERSION;
    const configuredPrivacyVersion = process.env.PRIVACY_VERSION;
    if (
      process.env.NODE_ENV === 'production' &&
      (!configuredTermsVersion || configuredTermsVersion.startsWith('draft-') ||
        !configuredPrivacyVersion || configuredPrivacyVersion.startsWith('draft-'))
    ) {
      logger.error('Applicant registration requires approved TERMS_VERSION and PRIVACY_VERSION settings.');
      throw new ServiceUnavailableException('Registration is not configured.');
    }
    const termsVersion = configuredTermsVersion ?? 'draft-v1';
    const privacyVersion = configuredPrivacyVersion ?? 'draft-v1';
    const createdAt = new Date();
    const token = createOpaqueToken();
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            fullName: dto.fullName.trim().replace(/\s+/g, ' '),
            email,
            phone,
            nationalIdCiphertext: encryptNationalId(nationalId),
            nationalIdHash,
            referralCode: randomBytes(8).toString('hex').toUpperCase(),
            passwordHash,
            identityStatus: 'NOT_STARTED',
            termsVersion,
            privacyVersion,
            consents: {
              create: [
                { consentType: 'TERMS', version: termsVersion, acceptedAt: createdAt },
                { consentType: 'PRIVACY', version: privacyVersion, acceptedAt: createdAt },
              ],
            },
          },
          select: { id: true, fullName: true, email: true, identityStatus: true, referralCode: true },
        });
        if (referrer && referredByCode) {
          await tx.referral.create({
            data: { code: referredByCode, referrerId: referrer.id, referredUserId: created.id },
          });
        }
        await tx.customerSession.create({
          data: {
            userId: created.id,
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + CUSTOMER_SESSION_MS),
          },
        });
        await tx.authAuditLog.create({
          data: { actorType: 'CUSTOMER', actorId: created.id, action: 'REGISTRATION', outcome: 'SUCCESS', ipAddress },
        });
        return created;
      });
      return { token, principal: user };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Some of the details provided are already registered.');
      }
      throw error;
    }
  }

  async loginCustomer(dto: CustomerLoginDto, ipAddress?: string): Promise<SessionResult<Pick<User, 'id' | 'fullName' | 'email' | 'identityStatus' | 'referralCode'>>> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });
    const passwordMatches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.isActive || user.role !== 'NORMAL_USER' || !passwordMatches) {
      await this.recordAuthAudit('CUSTOMER', user?.id, 'LOGIN', 'FAILURE', ipAddress);
      throw new UnauthorizedException('Email or password is incorrect.');
    }

    const token = createOpaqueToken();
    const principal = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customerSession.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + CUSTOMER_SESSION_MS),
        },
        select: { user: { select: { id: true, fullName: true, email: true, identityStatus: true, referralCode: true } } },
      });
      await tx.authAuditLog.create({
        data: { actorType: 'CUSTOMER', actorId: user.id, action: 'LOGIN', outcome: 'SUCCESS', ipAddress },
      });
      return created.user;
    });
    return { token, principal };
  }

  async logoutCustomer(sessionHash: string): Promise<void> {
    await this.prisma.customerSession.updateMany({
      where: { tokenHash: sessionHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async requestPasswordReset(dto: PasswordResetRequestDto): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(dto.email) } });
    if (!user || !user.isActive) return;
    const token = createOpaqueToken();
    const now = new Date();
    const reset = await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      return tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + 30 * 60 * 1000) },
        select: { id: true },
      });
    });
    try {
      await this.mail.sendPasswordReset(user.email, token);
    } catch {
      await this.prisma.passwordResetToken.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: now } });
    }
  }

  async requestCustomerPasswordReset(
    customerId: string,
    adminId: string,
    reason: string,
    ipAddress?: string,
  ): Promise<{ requested: boolean; delivery: 'SENT' | 'UNAVAILABLE' }> {
    const safeReason = reason.trim();
    if (safeReason.length < 10 || safeReason.length > 500) {
      throw new BadRequestException('A password-reset reason between 10 and 500 characters is required.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: { id: true, email: true, role: true, isActive: true },
    });
    if (!user || user.role !== 'NORMAL_USER') throw new NotFoundException('Customer account was not found.');
    if (!user.isActive) throw new BadRequestException('Password reset is unavailable for a disabled account.');

    const token = createOpaqueToken();
    const now = new Date();
    const reset = await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      const created = await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
        },
        select: { id: true },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: adminId,
          action: 'CUSTOMER_PASSWORD_RESET_REQUESTED',
          subjectType: 'CUSTOMER',
          subjectId: user.id,
          outcome: 'PENDING_DELIVERY',
          reason: safeReason,
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return { tokenId: created.id };
    });

    try {
      await this.mail.sendPasswordReset(user.email, token);
    } catch {
      const failedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.passwordResetToken.updateMany({
          where: { id: reset.tokenId, usedAt: null },
          data: { usedAt: failedAt },
        });
        await tx.adminAuditLog.create({
          data: {
            superadminId: adminId,
            action: 'CUSTOMER_PASSWORD_RESET_DELIVERY',
            subjectType: 'CUSTOMER',
            subjectId: user.id,
            outcome: 'UNAVAILABLE',
            reason: 'Reset email delivery failed; the reset token was invalidated.',
            ipAddress: ipAddress?.slice(0, 64),
          },
        });
      });
      return { requested: true, delivery: 'UNAVAILABLE' };
    }
    await this.prisma.adminAuditLog.create({
      data: {
        superadminId: adminId,
        action: 'CUSTOMER_PASSWORD_RESET_DELIVERY',
        subjectType: 'CUSTOMER',
        subjectId: user.id,
        outcome: 'SENT',
        reason: 'Password reset instructions were sent to the registered email address.',
        ipAddress: ipAddress?.slice(0, 64),
      },
    });
    return { requested: true, delivery: 'SENT' };
  }

  async completePasswordReset(dto: PasswordResetCompleteDto, ipAddress?: string): Promise<void> {
    assertMatchingPasswords(dto.password, dto.confirmPassword);
    const tokenHash = hashToken(dto.token);
    const reset = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, isActive: true } } },
    });
    const now = new Date();
    if (!reset || reset.usedAt || reset.expiresAt <= now || !reset.user.isActive) {
      throw new BadRequestException('This password reset link is invalid or expired.');
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.passwordResetToken.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claim.count !== 1) throw new BadRequestException('This password reset link is invalid or expired.');
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await tx.customerSession.updateMany({ where: { userId: reset.userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.passwordResetToken.updateMany({ where: { userId: reset.userId, usedAt: null }, data: { usedAt: now } });
      await tx.authAuditLog.create({
        data: { actorType: 'CUSTOMER', actorId: reset.userId, action: 'PASSWORD_RESET', outcome: 'SUCCESS', ipAddress },
      });
    });
  }

  async changeCustomerPassword(userId: string, dto: PasswordChangeDto, ipAddress?: string): Promise<void> {
    assertMatchingPasswords(dto.password, dto.confirmPassword);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.customerSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.authAuditLog.create({
        data: { actorType: 'CUSTOMER', actorId: userId, action: 'PASSWORD_CHANGE', outcome: 'SUCCESS', ipAddress },
      });
    });
  }

  async requestSuperadminOtp(dto: SuperadminPasswordDto, ipAddress?: string): Promise<{ challengeId: string }> {
    const email = normalizeEmail(dto.email);
    const configuredEmail = process.env.SUPERADMIN_EMAIL ? normalizeEmail(process.env.SUPERADMIN_EMAIL) : '';
    const admin = await this.prisma.superadminUser.findUnique({ where: { email } });
    if (!configuredEmail && admin?.role === 'SUPERADMIN') {
      logger.error('Required Superadmin setting SUPERADMIN_EMAIL is missing.');
    }
    const passwordMatches = await bcrypt.compare(dto.password, admin?.passwordHash ?? DUMMY_PASSWORD_HASH);
    const isStaff = admin?.role === 'STAFF_SUPPORT' || admin?.role === 'STAFF_FINANCE' ||
      admin?.role === 'STAFF_OPERATIONS';
    const isDesignatedSuperadmin = !!configuredEmail && admin?.role === 'SUPERADMIN' && email === configuredEmail;
    if (
      !admin ||
      (!isDesignatedSuperadmin && !isStaff) ||
      !admin.isActive ||
      !admin.emailVerifiedAt ||
      !passwordMatches
    ) {
      await this.recordAdminAudit(admin?.id, 'LOGIN_PASSWORD', 'FAILURE', ipAddress);
      await this.recordAuthAudit(isStaff ? 'STAFF' : 'SUPERADMIN', admin?.id, 'LOGIN_PASSWORD', 'FAILURE', ipAddress);
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    const actorType = isStaff ? 'STAFF' : 'SUPERADMIN';

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = new Date();
    const challenge = await this.prisma.$transaction(async (tx) => {
      await tx.superadminOtpChallenge.updateMany({
        where: { superadminId: admin.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      return tx.superadminOtpChallenge.create({
        data: {
          superadminId: admin.id,
          otpHash: keyedDigest(code, 'OTP_HASH_KEY'),
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        },
        select: { id: true },
      });
    });

    try {
      await this.mail.sendSuperadminOtp(admin.email, code);
    } catch {
      await this.prisma.superadminOtpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { invalidatedAt: new Date() },
      });
      await this.recordAdminAudit(admin.id, 'OTP_DELIVERY', 'FAILURE', ipAddress);
      await this.recordAuthAudit(actorType, admin.id, 'OTP_DELIVERY', 'FAILURE', ipAddress);
      logger.error('Superadmin OTP email delivery failed (email provider unavailable).');
      throw new ServiceUnavailableException('Administrator verification is unavailable.');
    }

    await this.recordAdminAudit(admin.id, 'OTP_REQUEST', 'SUCCESS', ipAddress);
    await this.recordAuthAudit(actorType, admin.id, 'OTP_REQUEST', 'SUCCESS', ipAddress);
    return { challengeId: challenge.id };
  }

  async verifySuperadminOtp(
    dto: SuperadminOtpDto,
    ipAddress?: string,
  ): Promise<SessionResult<Pick<AuthPrincipal, 'id' | 'role' | 'email'>>> {
    const challenge = await this.prisma.superadminOtpChallenge.findUnique({
      where: { id: dto.challengeId },
      include: { superadmin: { select: { id: true, role: true, email: true, isActive: true, emailVerifiedAt: true } } },
    });
    const now = new Date();
    if (!challenge) {
      await this.recordAdminAudit(null, 'OTP_VERIFY', 'FAILURE', ipAddress);
      await this.recordAuthAudit('SUPERADMIN', null, 'OTP_VERIFY', 'FAILURE', ipAddress);
      throw new UnauthorizedException('Verification code is invalid or expired.');
    }

    const suppliedHash = keyedDigest(dto.code, 'OTP_HASH_KEY');
    const hashesMatch = timingSafeEqual(Buffer.from(suppliedHash, 'hex'), Buffer.from(challenge.otpHash, 'hex'));
    const challengeValid = !challenge.consumedAt && !challenge.invalidatedAt && challenge.expiresAt > now &&
      challenge.attempts < OTP_MAX_ATTEMPTS && challenge.superadmin.isActive &&
      challenge.superadmin.emailVerifiedAt !== null &&
      (challenge.superadmin.role === 'SUPERADMIN' || challenge.superadmin.role === 'STAFF_SUPPORT' ||
        challenge.superadmin.role === 'STAFF_FINANCE' || challenge.superadmin.role === 'STAFF_OPERATIONS');
    const actorType = challenge.superadmin.role === 'SUPERADMIN' ? 'SUPERADMIN' : 'STAFF';
    if (!challengeValid || !hashesMatch) {
      await this.prisma.superadminOtpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, invalidatedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      await this.recordAdminAudit(challenge.superadminId, 'OTP_VERIFY', 'FAILURE', ipAddress);
      await this.recordAuthAudit(actorType, challenge.superadminId, 'OTP_VERIFY', 'FAILURE', ipAddress);
      throw new UnauthorizedException('Verification code is invalid or expired.');
    }

    const token = createOpaqueToken();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.superadminOtpChallenge.updateMany({
        where: {
          id: challenge.id,
          otpHash: challenge.otpHash,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: OTP_MAX_ATTEMPTS },
        },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) throw new UnauthorizedException('Verification code is invalid or expired.');
      await tx.superadminSession.create({
        data: {
          superadminId: challenge.superadminId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ADMIN_SESSION_MS),
        },
      });
      await tx.adminAuditLog.create({
        data: { superadminId: challenge.superadminId, action: 'LOGIN_OTP', outcome: 'SUCCESS', ipAddress },
      });
      await tx.authAuditLog.create({
        data: { actorType, actorId: challenge.superadminId, action: 'LOGIN_OTP', outcome: 'SUCCESS', ipAddress },
      });
    });
    return {
      token,
      principal: {
        id: challenge.superadmin.id,
        role: challenge.superadmin.role,
        email: challenge.superadmin.email,
      },
    };
  }

  async logoutSuperadmin(sessionHash: string, ipAddress?: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.superadminSession.findUnique({
        where: { tokenHash: sessionHash },
        select: { superadminId: true },
      });
      if (!session) return;
      const revoked = await tx.superadminSession.updateMany({
        where: { tokenHash: sessionHash, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return;
      await tx.adminAuditLog.create({
        data: { superadminId: session.superadminId, action: 'LOGOUT', outcome: 'SUCCESS', ipAddress },
      });
      await tx.authAuditLog.create({
        data: { actorType: 'SUPERADMIN', actorId: session.superadminId, action: 'LOGOUT', outcome: 'SUCCESS', ipAddress },
      });
    });
  }

  private async recordAuthAudit(
    actorType: string,
    actorId: string | undefined | null,
    action: string,
    outcome: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.prisma.authAuditLog.create({
      data: { actorType, actorId: actorId ?? null, action, outcome, ipAddress: ipAddress?.slice(0, 64) },
    });
  }

  private async recordAdminAudit(
    superadminId: string | undefined | null,
    action: string,
    outcome: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: { superadminId: superadminId ?? null, action, outcome, ipAddress: ipAddress?.slice(0, 64) },
    });
  }
}
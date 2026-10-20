import {
  ExecutionContext,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Response as ExpressResponse } from 'express';
import 'reflect-metadata';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import type { AuthenticatedRequest } from './request.types';
import { SuperadminAuthController } from './superadmin-auth.controller';
import { SuperadminSessionGuard } from './session.guard';
import { hashToken } from './security.util';

interface TestChallenge {
  id: string;
  superadminId: string;
  otpHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  attempts: number;
}

describe('Superadmin email OTP authentication flow', () => {
  const originalEnvironment = {
    otpHashKey: process.env.OTP_HASH_KEY,
    superadminEmail: process.env.SUPERADMIN_EMAIL,
    webOrigin: process.env.WEB_ORIGIN,
    nodeEnv: process.env.NODE_ENV,
  };
  const adminEmail = 'operator@example.invalid';
  let challenges: TestChallenge[];
  let sessions: Array<{ tokenHash: string; expiresAt: Date; superadminId: string; revokedAt: Date | null }>;
  let deliveredCodes: string[];
  let sendOtp: jest.Mock;
  let auth: AuthService;
  let controller: SuperadminAuthController;
  let prisma: PrismaService;
  let admin: {
    id: string;
    email: string;
    passwordHash: string;
    isActive: boolean;
    emailVerifiedAt: Date | null;
    role: 'SUPERADMIN' | 'NORMAL_USER';
  };

  beforeEach(async () => {
    process.env.OTP_HASH_KEY = randomBytes(32).toString('hex');
    process.env.SUPERADMIN_EMAIL = adminEmail;
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.NODE_ENV = 'test';
    admin = {
      id: 'admin-id',
      email: adminEmail,
      passwordHash: await bcrypt.hash('valid-superadmin-password', 4),
      isActive: true,
      emailVerifiedAt: new Date(),
      role: 'SUPERADMIN',
    };
    challenges = [];
    sessions = [];
    deliveredCodes = [];
    let challengeSequence = 0;
    sendOtp = jest.fn(async (_recipient: string, code: string) => {
      deliveredCodes.push(code);
    });

    const updateChallenges = jest.fn(async (args: {
      where: {
        id?: string;
        superadminId?: string;
        consumedAt?: null;
        invalidatedAt?: null;
        attempts?: { lt: number };
        expiresAt?: { gt: Date };
        otpHash?: string;
      };
      data: {
        invalidatedAt?: Date;
        consumedAt?: Date;
        attempts?: { increment: number };
      };
    }) => {
      let count = 0;
      for (const challenge of challenges) {
        const { where, data } = args;
        if (where.id && challenge.id !== where.id) continue;
        if (where.superadminId && challenge.superadminId !== where.superadminId) continue;
        if (where.otpHash && challenge.otpHash !== where.otpHash) continue;
        if (where.consumedAt === null && challenge.consumedAt !== null) continue;
        if (where.invalidatedAt === null && challenge.invalidatedAt !== null) continue;
        if (where.attempts && challenge.attempts >= where.attempts.lt) continue;
        if (where.expiresAt && challenge.expiresAt <= where.expiresAt.gt) continue;
        if (data.invalidatedAt) challenge.invalidatedAt = data.invalidatedAt;
        if (data.consumedAt) challenge.consumedAt = data.consumedAt;
        if (data.attempts) challenge.attempts += data.attempts.increment;
        count += 1;
      }
      return { count };
    });
    const transactionClient = {
      superadminOtpChallenge: {
        updateMany: updateChallenges,
        create: jest.fn(async (args: {
          data: { superadminId: string; otpHash: string; expiresAt: Date };
        }) => {
          challengeSequence += 1;
          const challenge = {
            ...args.data,
            id: `test-challenge-${challengeSequence.toString().padStart(8, '0')}`,
            consumedAt: null,
            invalidatedAt: null,
            attempts: 0,
          };
          challenges.push(challenge);
          return { id: challenge.id };
        }),
      },
      superadminSession: {
        create: jest.fn(async (args: { data: { tokenHash: string; expiresAt: Date; superadminId: string } }) => {
          const session = { ...args.data, revokedAt: null };
          sessions.push(session);
          return args.data;
        }),
        findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => {
          const session = sessions.find(({ tokenHash }) => tokenHash === where.tokenHash);
          return session ? { superadminId: session.superadminId } : null;
        }),
        updateMany: jest.fn(async ({ where, data }: {
          where: { tokenHash: string; revokedAt: null };
          data: { revokedAt: Date };
        }) => {
          const session = sessions.find(({ tokenHash, revokedAt }) =>
            tokenHash === where.tokenHash && revokedAt === null);
          if (!session) return { count: 0 };
          session.revokedAt = data.revokedAt;
          return { count: 1 };
        }),
      },
      adminAuditLog: { create: jest.fn(async () => ({})) },
      authAuditLog: { create: jest.fn(async () => ({})) },
    };
    const prismaMock = {
      superadminUser: {
        findUnique: jest.fn(async ({ where }: { where: { email: string } }) =>
          where.email === admin.email ? admin : null),
      },
      superadminOtpChallenge: {
        updateMany: updateChallenges,
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const challenge = challenges.find(({ id }) => id === where.id);
          return challenge ? { ...challenge, superadmin: admin } : null;
        }),
      },
      superadminSession: {
        findFirst: jest.fn(async ({ where }: { where: {
          tokenHash: string;
          revokedAt: null;
          expiresAt: { gt: Date };
        } }) => {
          const session = sessions.find(({ tokenHash, revokedAt, expiresAt }) =>
            tokenHash === where.tokenHash && revokedAt === null && expiresAt > where.expiresAt.gt);
          return session ? { ...session, superadmin: admin } : null;
        }),
      },
      adminAuditLog: { create: jest.fn(async () => ({})) },
      authAuditLog: { create: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (callback: (tx: never) => Promise<unknown>) =>
        callback(transactionClient as never)),
    } as unknown as PrismaService;

    prisma = prismaMock;
    auth = new AuthService(prisma, { sendSuperadminOtp: sendOtp } as unknown as MailService);
    controller = new SuperadminAuthController(auth);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      OTP_HASH_KEY: originalEnvironment.otpHashKey,
      SUPERADMIN_EMAIL: originalEnvironment.superadminEmail,
      WEB_ORIGIN: originalEnvironment.webOrigin,
      NODE_ENV: originalEnvironment.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const passwordDto = () => ({
    email: adminEmail,
    password: 'valid-superadmin-password',
  });

  const wrongOtp = (code: string) => code === '000000' ? '000001' : '000000';

  const request = (): AuthenticatedRequest => ({
    headers: { origin: 'http://localhost:3000' },
    cookies: {},
    ip: '127.0.0.1',
  }) as AuthenticatedRequest;

  it('sends a hashed, expiring OTP after valid credentials without issuing a session', async () => {
    const result = await controller.verifyPassword(passwordDto(), request());

    expect(result.data.challengeId).toEqual(expect.any(String));
    expect(result.data.expiresInSeconds).toBe(300);
    expect(sendOtp).toHaveBeenCalledWith(adminEmail, expect.stringMatching(/^\d{6}$/));
    expect(challenges[0].otpHash).not.toBe(deliveredCodes[0]);
    expect(challenges[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(challenges[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(sessions).toHaveLength(0);
  });

  it('does not issue an OTP or session for invalid credentials', async () => {
    await expect(auth.requestSuperadminOtp({
      ...passwordDto(),
      password: 'incorrect-password',
    })).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sendOtp).not.toHaveBeenCalled();
    expect(challenges).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it.each(['inactive', 'unverified', 'wrong-role'] as const)(
    'rejects a %s account before issuing an OTP',
    async (condition) => {
      if (condition === 'inactive') admin.isActive = false;
      if (condition === 'unverified') admin.emailVerifiedAt = null;
      if (condition === 'wrong-role') admin.role = 'NORMAL_USER';

      await expect(auth.requestSuperadminOtp(passwordDto()))
        .rejects.toBeInstanceOf(UnauthorizedException);

      expect(sendOtp).not.toHaveBeenCalled();
      expect(challenges).toHaveLength(0);
      expect(sessions).toHaveLength(0);
    },
  );

  it('rejects an email that does not match the database account', async () => {
    await expect(auth.requestSuperadminOtp({
      ...passwordDto(),
      email: 'different-operator@example.invalid',
    })).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sendOtp).not.toHaveBeenCalled();
    expect(challenges).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it('rejects a database account email that does not match SUPERADMIN_EMAIL', async () => {
    process.env.SUPERADMIN_EMAIL = 'different-operator@example.invalid';

    await expect(auth.requestSuperadminOtp(passwordDto()))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(sendOtp).not.toHaveBeenCalled();
    expect(challenges).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it('requires OTP before access and sets the secure administrator cookie after verification', async () => {
    const unauthenticatedRequest = request();
    const context = {
      switchToHttp: () => ({ getRequest: () => unauthenticatedRequest }),
    } as ExecutionContext;
    const guard = new SuperadminSessionGuard(prisma);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);

    const applicantRequest = request();
    applicantRequest.cookies = { lp_customer_session: 'applicant-session-token' };
    const applicantContext = {
      switchToHttp: () => ({ getRequest: () => applicantRequest }),
    } as ExecutionContext;
    await expect(guard.canActivate(applicantContext)).rejects.toBeInstanceOf(UnauthorizedException);

    const { data: challenge } = await controller.verifyPassword(passwordDto(), request());
    expect(sessions).toHaveLength(0);

    process.env.NODE_ENV = 'production';
    const setCookie = jest.fn();
    const response = { cookie: setCookie } as unknown as ExpressResponse;
    const result = await controller.verifyOtp({
      challengeId: challenge.challengeId,
      code: deliveredCodes[0],
    }, request(), response);

    expect(result.data).toMatchObject({ id: admin.id, role: 'SUPERADMIN', email: admin.email });
    expect(setCookie).toHaveBeenCalledWith('lp_admin_session', expect.any(String), expect.objectContaining({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
    }));
    const token = setCookie.mock.calls[0][1] as string;
    expect(sessions).toContainEqual(expect.objectContaining({ tokenHash: hashToken(token) }));

    const authenticatedRequest = request();
    authenticatedRequest.cookies = { lp_admin_session: token };
    const authenticatedContext = {
      switchToHttp: () => ({ getRequest: () => authenticatedRequest }),
      getHandler: () => SuperadminAuthController.prototype.getCurrentSuperadmin,
    } as unknown as ExecutionContext;
    expect(await guard.canActivate(authenticatedContext)).toBe(true);
    expect(authenticatedRequest.principal).toMatchObject({ id: admin.id, role: 'SUPERADMIN' });
    expect(controller.getCurrentSuperadmin(authenticatedRequest)).toMatchObject({
      data: { id: admin.id, role: 'SUPERADMIN' },
    });
  });

  it('clears and revokes an expired administrator session without allowing it to access protected routes', async () => {
    const token = 'expired-admin-session-token';
    sessions.push({
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 1),
      superadminId: admin.id,
      revokedAt: null,
    });
    const expiredRequest = request();
    expiredRequest.cookies = { lp_admin_session: token };
    const guard = new SuperadminSessionGuard(prisma);
    const context = {
      switchToHttp: () => ({ getRequest: () => expiredRequest }),
    } as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);

    const clearCookie = jest.fn();
    const result = await controller.logout(expiredRequest, { clearCookie } as unknown as ExpressResponse);

    expect(result).toEqual({ data: { loggedOut: true } });
    expect(clearCookie).toHaveBeenCalledWith('lp_admin_session', expect.objectContaining({ path: '/' }));
    expect(sessions[0].revokedAt).toBeInstanceOf(Date);
  });

  it('limits both OTP endpoints to five requests per minute', () => {
    for (const endpoint of ['verifyPassword', 'verifyOtp'] as const) {
      const handler = SuperadminAuthController.prototype[endpoint];
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    }
  });

  it('rejects incorrect and expired OTPs and enforces the attempt limit', async () => {
    const challenge = await auth.requestSuperadminOtp(passwordDto());
    await expect(auth.verifySuperadminOtp({
      challengeId: challenge.challengeId,
      code: wrongOtp(deliveredCodes[0]),
    })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(challenges[0].attempts).toBe(1);

    challenges[0].expiresAt = new Date(Date.now() - 1);
    await expect(auth.verifySuperadminOtp({
      challengeId: challenge.challengeId,
      code: deliveredCodes[0],
    })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions).toHaveLength(0);

    const replacement = await auth.requestSuperadminOtp(passwordDto());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.verifySuperadminOtp({
        challengeId: replacement.challengeId,
        code: wrongOtp(deliveredCodes[1]),
      })).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(auth.verifySuperadminOtp({
      challengeId: replacement.challengeId,
      code: deliveredCodes[1],
    })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(challenges[1].attempts).toBe(5);
    expect(sessions).toHaveLength(0);
  });

  it('invalidates an older OTP when a new password challenge is requested and consumes the new OTP once', async () => {
    const first = await auth.requestSuperadminOtp(passwordDto());
    const second = await auth.requestSuperadminOtp(passwordDto());
    expect(challenges[0].invalidatedAt).not.toBeNull();

    await expect(auth.verifySuperadminOtp({
      challengeId: first.challengeId,
      code: deliveredCodes[0],
    })).rejects.toBeInstanceOf(UnauthorizedException);

    const otpDto = { challengeId: second.challengeId, code: deliveredCodes[1] };
    const session = await auth.verifySuperadminOtp(otpDto);
    expect(session.principal.role).toBe('SUPERADMIN');
    expect(challenges[1].consumedAt).not.toBeNull();
    expect(sessions).toHaveLength(1);
    await expect(auth.verifySuperadminOtp(otpDto)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions).toHaveLength(1);
  });

  it('fails closed and records a sanitized diagnostic when email delivery fails', async () => {
    sendOtp.mockRejectedValueOnce(new Error('private email provider response'));
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(auth.requestSuperadminOtp(passwordDto()))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(challenges[0].invalidatedAt).not.toBeNull();
      expect(sessions).toHaveLength(0);
      expect(loggerSpy.mock.calls.flat().join(' '))
        .toContain('Superadmin OTP email delivery failed (email provider unavailable).');
      expect(loggerSpy.mock.calls.flat().join(' '))
        .not.toContain('private email provider response');
    } finally {
      loggerSpy.mockRestore();
    }
  });

  it('fails safely and identifies missing OTP or Superadmin configuration without logging values', async () => {
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      delete process.env.OTP_HASH_KEY;
      await expect(auth.requestSuperadminOtp(passwordDto()))
        .rejects.toMatchObject({ status: 500 });
      expect(sendOtp).not.toHaveBeenCalled();
      expect(sessions).toHaveLength(0);
      expect(loggerSpy.mock.calls.flat().join(' ')).toContain('OTP_HASH_KEY');

      process.env.OTP_HASH_KEY = randomBytes(32).toString('hex');
      delete process.env.SUPERADMIN_EMAIL;
      await expect(auth.requestSuperadminOtp(passwordDto()))
        .rejects.toBeInstanceOf(UnauthorizedException);
      expect(loggerSpy.mock.calls.flat().join(' ')).toContain('SUPERADMIN_EMAIL');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain(process.env.OTP_HASH_KEY);
    } finally {
      loggerSpy.mockRestore();
    }
  });
});

describe('Superadmin OTP mail configuration', () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.RESEND_FROM;
  const originalWebOrigin = process.env.WEB_ORIGIN;

  afterEach(() => {
    for (const [name, value] of Object.entries({
      RESEND_API_KEY: originalApiKey,
      RESEND_FROM: originalFrom,
      WEB_ORIGIN: originalWebOrigin,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('sends email through the Resend API using the configured verified sender', async () => {
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.RESEND_FROM = 'LoanPlus <no-reply@example.invalid>';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    try {
      await new MailService().sendSuperadminOtp('operator@example.invalid', '123456');
      expect(fetchSpy).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-resend-api-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'LoanPlus <no-reply@example.invalid>',
          to: 'operator@example.invalid',
          subject: 'Your LoanPlus administrator sign-in code',
          text: 'Your sign-in code is 123456. It expires in five minutes. If you did not request this code, contact your system operator.',
        }),
      }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses the same Resend API for applicant password reset messages', async () => {
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.RESEND_FROM = 'LoanPlus <no-reply@example.invalid>';
    process.env.WEB_ORIGIN = 'https://web.example.invalid';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    try {
      await new MailService().sendPasswordReset('applicant@example.invalid', 'test-reset-token');
      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(options.body))).toEqual({
        from: 'LoanPlus <no-reply@example.invalid>',
        to: 'applicant@example.invalid',
        subject: 'Reset your LoanPlus password',
        text: 'Use this one-time link to reset your password: https://web.example.invalid/reset-password?token=test-reset-token\nIf you did not request this, you can ignore this message.',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('identifies missing Resend settings without exposing setting values or OTPs', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    const mail = new MailService();
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      await expect(mail.sendSuperadminOtp('operator@example.invalid', '123456'))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(loggerSpy.mock.calls.flat().join(' '))
        .toContain('Required Resend email setting RESEND_API_KEY is missing.');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('123456');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      loggerSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('identifies a missing Resend sender address without calling the provider', async () => {
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    delete process.env.RESEND_FROM;
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      await expect(new MailService().sendSuperadminOtp('operator@example.invalid', '123456'))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(loggerSpy.mock.calls.flat().join(' '))
        .toContain('Required Resend email setting RESEND_FROM is missing.');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      loggerSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('fails safely and logs only the Resend status when delivery is rejected', async () => {
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.RESEND_FROM = 'LoanPlus <no-reply@example.invalid>';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: 'private provider response' }),
    } as unknown as Response);
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(new MailService().sendSuperadminOtp('operator@example.invalid', '123456'))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(loggerSpy.mock.calls.flat().join(' ')).toContain('Resend email delivery request failed (HTTP 422).');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('private provider response');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('123456');
    } finally {
      loggerSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('rejects malformed sender configuration before calling Resend', async () => {
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.RESEND_FROM = 'not-an-email-address';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(new MailService().sendSuperadminOtp('operator@example.invalid', '123456'))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(loggerSpy.mock.calls.flat().join(' ')).toContain('Required email delivery setting RESEND_FROM is invalid.');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      loggerSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('handles Resend network errors without logging provider or email data', async () => {
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.RESEND_FROM = 'LoanPlus <no-reply@example.invalid>';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private provider detail'));
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(new MailService().sendSuperadminOtp('operator@example.invalid', '654321'))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(loggerSpy.mock.calls.flat().join(' '))
        .toContain('Resend email delivery request failed (network or timeout).');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('private provider detail');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('654321');
    } finally {
      loggerSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

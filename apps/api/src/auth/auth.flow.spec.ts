import {
  ConflictException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { validate } from 'class-validator';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AuthController } from './auth.controller';
import { CustomerLoginDto, RegisterCustomerDto } from './auth.dto';
import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './request.types';
import { hashToken } from './security.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailService } from './mail.service';

describe('customer registration and login flow', () => {
  const originalEnvironment = {
    idHashKey: process.env.ID_HASH_KEY,
    encryptionKey: process.env.ID_ENCRYPTION_KEY_BASE64,
    termsVersion: process.env.TERMS_VERSION,
    privacyVersion: process.env.PRIVACY_VERSION,
    webOrigin: process.env.WEB_ORIGIN,
    nodeEnv: process.env.NODE_ENV,
  };

  let storedUser: {
    id: string;
    fullName: string;
    email: string;
    phone: string;
    nationalIdCiphertext: string;
    nationalIdHash: string;
    passwordHash: string;
    referralCode: string;
    role: 'NORMAL_USER';
    isActive: boolean;
  } | null;
  let sessionHashes: Set<string>;
  let auth: AuthService;
  let controller: AuthController;
  let cookie: jest.Mock;
  let clearCookie: jest.Mock;
  let findFirstUser: jest.Mock;

  beforeEach(() => {
    process.env.ID_HASH_KEY = randomBytes(32).toString('hex');
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    process.env.TERMS_VERSION = 'test-v1';
    process.env.PRIVACY_VERSION = 'test-v1';
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    storedUser = null;
    sessionHashes = new Set();
    cookie = jest.fn();
    clearCookie = jest.fn();
    findFirstUser = jest.fn(async () => storedUser ? { id: storedUser.id } : null);

    const principal = () => {
      if (!storedUser) throw new Error('Test user was not created.');
      return {
        id: storedUser.id,
        fullName: storedUser.fullName,
        email: storedUser.email,
        identityStatus: 'NOT_STARTED',
        referralCode: storedUser.referralCode,
      };
    };
    const tx = {
      user: {
        create: jest.fn(async ({ data }: {
          data: {
            fullName: string;
            email: string;
            phone: string;
            nationalIdCiphertext: string;
            nationalIdHash: string;
            passwordHash: string;
            referralCode: string;
          };
        }) => {
          storedUser = {
            ...data,
            id: 'test-user-id',
            role: 'NORMAL_USER',
            isActive: true,
          };
          return principal();
        }),
      },
      customerSession: {
        create: jest.fn(async ({ data }: { data: { tokenHash: string } }) => {
          sessionHashes.add(data.tokenHash);
          return { user: principal() };
        }),
      },
      authAuditLog: { create: jest.fn(async () => ({})) },
    };
    const prisma = {
      user: {
        findFirst: findFirstUser,
        findUnique: jest.fn(async () => storedUser),
      },
      customerSession: {
        updateMany: jest.fn(async ({ where }: { where: { tokenHash: string } }) => ({
          count: sessionHashes.delete(where.tokenHash) ? 1 : 0,
        })),
      },
      authAuditLog: { create: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (callback: (client: never) => Promise<unknown>) => callback(tx as never)),
    } as unknown as PrismaService;

    auth = new AuthService(prisma, {} as MailService);
    controller = new AuthController(auth);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      ID_HASH_KEY: originalEnvironment.idHashKey,
      ID_ENCRYPTION_KEY_BASE64: originalEnvironment.encryptionKey,
      TERMS_VERSION: originalEnvironment.termsVersion,
      PRIVACY_VERSION: originalEnvironment.privacyVersion,
      WEB_ORIGIN: originalEnvironment.webOrigin,
      NODE_ENV: originalEnvironment.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('registers, logs in, and issues an HttpOnly session cookie without returning credentials', async () => {
    const request = { headers: { origin: 'http://localhost:3000' } } as AuthenticatedRequest;
    const response = { cookie, clearCookie } as unknown as Response;
    const registration = await controller.register({
      fullName: ' Test Customer ',
      email: 'TEST@example.invalid',
      phone: '+254712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    }, request, response);

    expect(registration).toEqual({
      data: expect.objectContaining({ id: 'test-user-id', email: 'test@example.invalid' }),
    });
    expect(registration).not.toHaveProperty('data.passwordHash');
    expect(registration).not.toHaveProperty('data.password');
    expect(registration).not.toHaveProperty('data.nationalIdCiphertext');
    expect(registration).not.toHaveProperty('token');
    expect(storedUser?.passwordHash).toMatch(/^\$2[aby]\$12\$/);

    const registerCookie = cookie.mock.calls[0] as [string, string, { httpOnly: boolean; sameSite: string }];
    expect(registerCookie[0]).toBe('lp_customer_session');
    expect(registerCookie[2]).toMatchObject({ httpOnly: true, sameSite: 'strict' });
    expect(sessionHashes.has(hashToken(registerCookie[1]))).toBe(true);

    const login = await controller.login({
      email: 'test@example.invalid',
      password: 'a-strong-test-password',
    }, request, response);

    expect(login).toEqual({
      data: expect.objectContaining({ id: 'test-user-id', email: 'test@example.invalid' }),
    });
    expect(login).not.toHaveProperty('data.passwordHash');
    const loginCookie = cookie.mock.calls[1] as [string, string, { httpOnly: boolean; sameSite: string }];
    expect(loginCookie[0]).toBe('lp_customer_session');
    expect(loginCookie[2]).toMatchObject({ httpOnly: true, sameSite: 'strict' });
    expect(sessionHashes.has(hashToken(loginCookie[1]))).toBe(true);

    const loginSessionHash = hashToken(loginCookie[1]);
    const authenticatedRequest = {
      ...request,
      principal: {
        id: 'test-user-id',
        role: 'NORMAL_USER',
        email: 'test@example.invalid',
        fullName: 'Test Customer',
        identityStatus: 'NOT_STARTED',
        sessionHash: loginSessionHash,
      },
    } as AuthenticatedRequest;
    expect(controller.getCurrentCustomer(authenticatedRequest)).toMatchObject({
      data: { id: 'test-user-id', email: 'test@example.invalid' },
    });

    await controller.logout(authenticatedRequest, response);
    expect(sessionHashes.has(loginSessionHash)).toBe(false);
    expect(clearCookie).toHaveBeenCalledWith('lp_customer_session', expect.objectContaining({
      httpOnly: true,
      sameSite: 'strict',
    }));
  });

  it('rejects duplicate registration and incorrect passwords', async () => {
    const dto: RegisterCustomerDto = {
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '+254712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    };
    await auth.registerCustomer(dto);
    await expect(auth.registerCustomer(dto)).rejects.toBeInstanceOf(ConflictException);
    await expect(auth.loginCustomer({
      email: dto.email,
      password: 'incorrect-test-password',
    })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects missing or malformed registration fields during DTO validation', async () => {
    const errors = await validate(Object.assign(new RegisterCustomerDto(), {
      fullName: '',
      email: 'not-an-email',
      password: 'short',
    }));

    expect(errors.map(({ property }) => property)).toEqual(expect.arrayContaining([
      'fullName',
      'email',
      'phone',
      'nationalId',
      'password',
      'confirmPassword',
      'termsAccepted',
      'privacyAccepted',
    ]));

    const invalidLogin = await validate(Object.assign(new CustomerLoginDto(), {
      email: 'invalid-email',
      password: '',
    }));
    expect(invalidLogin.map(({ property }) => property)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('accepts supported phone input lengths and international prefixes', async () => {
    for (const phone of ['0712345678', '0112345678', '+254712345678', '+254112345678', '(0712) 345-678']) {
      const errors = await validate(Object.assign(new RegisterCustomerDto(), {
        fullName: 'Test Customer',
        email: 'test@example.invalid',
        phone,
        nationalId: '12345678',
        password: 'a-strong-test-password',
        confirmPassword: 'a-strong-test-password',
        termsAccepted: true,
        privacyAccepted: true,
      }));
      expect(errors.map(({ property }) => property)).not.toContain('phone');
    }

    for (const phone of ['0712', '0712345678901234567', '0712abc5678']) {
      const errors = await validate(Object.assign(new RegisterCustomerDto(), {
        fullName: 'Test Customer',
        email: 'test@example.invalid',
        phone,
        nationalId: '12345678',
        password: 'a-strong-test-password',
        confirmPassword: 'a-strong-test-password',
        termsAccepted: true,
        privacyAccepted: true,
      }));
      expect(errors.map(({ property }) => property)).toContain('phone');
    }

    await expect(auth.registerCustomer({
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '+712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects national ID formats that cannot be normalized', async () => {
    const validRegistration = {
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '0712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    };
    await expect(auth.registerCustomer({ ...validRegistration, nationalId: '123456789' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('requires both consent values and matching passwords', async () => {
    const missingConsent = await validate(Object.assign(new RegisterCustomerDto(), {
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '0712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
    }));
    expect(missingConsent.map(({ property }) => property)).toEqual(expect.arrayContaining([
      'termsAccepted',
      'privacyAccepted',
    ]));
    await expect(auth.registerCustomer({
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '0712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-different-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    })).rejects.toMatchObject({ status: 400 });
  });

  it('returns a generic internal error and identifies missing ID_HASH_KEY in server diagnostics', async () => {
    delete process.env.ID_HASH_KEY;
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(auth.registerCustomer({
        fullName: 'Test Customer',
        email: 'test@example.invalid',
        phone: '0712345678',
        nationalId: '12345678',
        password: 'a-strong-test-password',
        confirmPassword: 'a-strong-test-password',
        termsAccepted: true,
        privacyAccepted: true,
      })).rejects.toMatchObject({
        status: 500,
        message: 'A required security setting is unavailable.',
      });
      expect(loggerSpy.mock.calls.flat().join(' '))
        .toContain('Required security setting ID_HASH_KEY is missing or invalid.');
      expect(findFirstUser).not.toHaveBeenCalled();
    } finally {
      loggerSpy.mockRestore();
    }
  });

  it('reports invalid encryption configuration without exposing its value', async () => {
    process.env.ID_ENCRYPTION_KEY_BASE64 = 'invalid-test-key-material';
    await expect(auth.registerCustomer({
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '0712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    })).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(storedUser).toBeNull();
  });

  it('reports a missing encryption key without exposing configuration values', async () => {
    delete process.env.ID_ENCRYPTION_KEY_BASE64;
    await expect(auth.registerCustomer({
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '0712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    })).rejects.toMatchObject({
      status: 500,
      message: 'A required security setting is unavailable.',
    });
    expect(storedUser).toBeNull();
  });

  it('returns a generic unavailable response for Prisma database failures', async () => {
    findFirstUser.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      'sensitive database failure detail',
      { code: 'P1001', clientVersion: '6.19.3' },
    ));
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(auth.registerCustomer({
        fullName: 'Test Customer',
        email: 'test@example.invalid',
        phone: '0712345678',
        nationalId: '12345678',
        password: 'a-strong-test-password',
        confirmPassword: 'a-strong-test-password',
        termsAccepted: true,
        privacyAccepted: true,
      })).rejects.toMatchObject({
        status: 503,
        message: 'Registration service is temporarily unavailable.',
      });
      expect(loggerSpy.mock.calls.flat().join(' '))
        .toContain('Applicant registration database connectivity failed (Prisma code P1001).');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('sensitive database failure detail');
    } finally {
      loggerSpy.mockRestore();
    }
  });

  it('classifies missing Prisma tables as a schema error without exposing SQL details', async () => {
    findFirstUser.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      'sensitive schema failure detail',
      { code: 'P2021', clientVersion: '6.19.3' },
    ));
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(auth.registerCustomer({
        fullName: 'Test Customer',
        email: 'test@example.invalid',
        phone: '0712345678',
        nationalId: '12345678',
        password: 'a-strong-test-password',
        confirmPassword: 'a-strong-test-password',
        termsAccepted: true,
        privacyAccepted: true,
      })).rejects.toMatchObject({
        status: 500,
        message: 'Registration could not be completed.',
      });
      expect(loggerSpy.mock.calls.flat().join(' '))
        .toContain('Applicant registration database schema mismatch (Prisma code P2021).');
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('sensitive schema failure detail');
    } finally {
      loggerSpy.mockRestore();
    }
  });

  it('does not allow draft consent versions in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TERMS_VERSION = 'draft-v1';
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(auth.registerCustomer({
        fullName: 'Test Customer',
        email: 'test@example.invalid',
        phone: '0712345678',
        nationalId: '12345678',
        password: 'a-strong-test-password',
        confirmPassword: 'a-strong-test-password',
        termsAccepted: true,
        privacyAccepted: true,
      })).rejects.toMatchObject({
        status: 503,
        message: 'Registration is not configured.',
      });
      expect(loggerSpy.mock.calls.flat().join(' ')).toContain('approved TERMS_VERSION and PRIVACY_VERSION');
      expect(storedUser).toBeNull();
    } finally {
      loggerSpy.mockRestore();
    }
  });

  it('does not expose unexpected registration errors to the client', async () => {
    findFirstUser.mockRejectedValue(new Error('sensitive unexpected failure detail'));
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(auth.registerCustomer({
        fullName: 'Test Customer',
        email: 'test@example.invalid',
        phone: '0712345678',
        nationalId: '12345678',
        password: 'a-strong-test-password',
        confirmPassword: 'a-strong-test-password',
        termsAccepted: true,
        privacyAccepted: true,
      })).rejects.toMatchObject({
        status: 500,
        message: 'Registration could not be completed.',
      });
      expect(loggerSpy.mock.calls.flat().join(' ')).not.toContain('sensitive unexpected failure detail');
    } finally {
      loggerSpy.mockRestore();
    }
  });

  it('uses production-only secure cross-site cookies', async () => {
    process.env.NODE_ENV = 'production';
    const response = { cookie, clearCookie } as unknown as Response;

    await controller.register({
      fullName: 'Test Customer',
      email: 'test@example.invalid',
      phone: '0712345678',
      nationalId: '12345678',
      password: 'a-strong-test-password',
      confirmPassword: 'a-strong-test-password',
      termsAccepted: true,
      privacyAccepted: true,
    }, { headers: { origin: 'http://localhost:3000' } } as AuthenticatedRequest, response);

    expect(cookie.mock.calls[0][2]).toMatchObject({ secure: true, sameSite: 'none' });
  });
});

import { BadRequestException, ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { RegisterCustomerDto, SuperadminOtpDto, SuperadminPasswordDto } from './auth.dto';
import { decryptNationalId, hashToken } from './security.util';
import type { MailService } from './mail.service';
import bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'node:crypto';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = databaseUrl ? it : it.skip;

describe('authentication database integration', () => {
  let prisma: PrismaService;
  let auth: AuthService;
  let userEmail: string;
  let userId: string;
  let referredUserId: string;
  let adminEmail: string;
  let adminId: string;
  let nationalId: string;
  let phone: string;
  let deliveredCode = '';
  let failOtpDelivery = false;

  const mail = {
    sendPasswordReset: jest.fn(async () => undefined),
    sendSuperadminOtp: jest.fn(async (_recipient: string, code: string) => {
      if (failOtpDelivery) throw new Error('Mail provider unavailable');
      deliveredCode = code;
    }),
  } as unknown as MailService;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const parsedUrl = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database whose name ends in _test.');
    }
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    process.env.ID_HASH_KEY = randomBytes(32).toString('hex');
    process.env.OTP_HASH_KEY = randomBytes(32).toString('hex');
    const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    userEmail = `customer-${suffix}@example.invalid`;
    adminEmail = `admin-${suffix}@example.invalid`;
    process.env.SUPERADMIN_EMAIL = adminEmail;
    phone = `+2547${randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
    nationalId = randomInt(10_000_000, 99_999_999).toString();
    prisma = new PrismaService();
    await prisma.$connect();
    auth = new AuthService(prisma, mail);
    const passwordHash = await bcrypt.hash('test-superadmin-password', 4);
    const admin = await prisma.superadminUser.create({
      data: { email: adminEmail, passwordHash, emailVerifiedAt: new Date() },
      select: { id: true },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    if (!databaseUrl || !prisma) return;
    await prisma.superadminSession.deleteMany({ where: { superadminId: adminId } });
    await prisma.superadminOtpChallenge.deleteMany({ where: { superadminId: adminId } });
    await prisma.adminAuditLog.deleteMany({ where: { superadminId: adminId } });
    await prisma.referral.deleteMany({ where: { OR: [{ referrerId: userId }, { referredUserId: referredUserId }] } });
    await prisma.authAuditLog.deleteMany({ where: { actorId: { in: [adminId, userId, referredUserId].filter(Boolean) } } });
    await prisma.superadminUser.deleteMany({ where: { id: adminId } });
    if (userId) {
      await prisma.customerSession.deleteMany({ where: { userId } });
      await prisma.passwordResetToken.deleteMany({ where: { userId } });
      await prisma.consentRecord.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    if (referredUserId) {
      await prisma.customerSession.deleteMany({ where: { userId: referredUserId } });
      await prisma.passwordResetToken.deleteMany({ where: { userId: referredUserId } });
      await prisma.consentRecord.deleteMany({ where: { userId: referredUserId } });
      await prisma.user.deleteMany({ where: { id: referredUserId } });
    }
    await prisma.$disconnect();
  });

  databaseTest('registers a customer with encrypted ID, consent records, and a hashed session', async () => {
    const dto = Object.assign(new RegisterCustomerDto(), {
      fullName: 'Test Customer',
      email: userEmail,
      phone,
      nationalId,
      password: 'test-customer-password',
      confirmPassword: 'test-customer-password',
      termsAccepted: true,
      privacyAccepted: true,
    });
    const result = await auth.registerCustomer(dto, '127.0.0.1');
    userId = result.principal.id;
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { consents: true, sessions: true },
    });
    expect(stored.passwordHash).not.toBe(dto.password);
    expect(stored.nationalIdCiphertext).not.toContain(nationalId);
    expect(decryptNationalId(stored.nationalIdCiphertext)).toBe(nationalId);
    expect(stored.nationalIdHash).not.toBe(nationalId);
    expect(stored.consents).toHaveLength(2);
    expect(stored.sessions[0].tokenHash).toBe(hashToken(result.token));
    expect(result.principal).not.toHaveProperty('nationalIdCiphertext');

    await expect(auth.registerCustomer(dto)).rejects.toBeInstanceOf(ConflictException);
  });

  databaseTest('captures a valid referral and rejects invalid or self-referral codes', async () => {
    const referrer = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } });
    expect(referrer.referralCode).toMatch(/^[A-F0-9]{16}$/);
    const dto = Object.assign(new RegisterCustomerDto(), {
      fullName: 'Referred Customer',
      email: `referred-${Date.now()}@example.invalid`,
      phone: `+2547${randomInt(0, 100_000_000).toString().padStart(8, '0')}`,
      nationalId: randomInt(10_000_000, 99_999_999).toString(),
      password: 'referred-customer-password',
      confirmPassword: 'referred-customer-password',
      termsAccepted: true,
      privacyAccepted: true,
      referralCode: referrer.referralCode!,
    });
    const registered = await auth.registerCustomer(dto);
    referredUserId = registered.principal.id;
    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId } });
    expect(referral.referrerId).toBe(userId);
    expect(referral.code).toBe(referrer.referralCode);
    expect(referral.status).toBe('REGISTERED');

    await expect(auth.registerCustomer({ ...dto, email: `invalid-${Date.now()}@example.invalid`, referralCode: 'AAAAAAAAAAAAAAAA' } as RegisterCustomerDto)).rejects.toBeInstanceOf(BadRequestException);
    await expect(auth.registerCustomer({ ...dto, email: `self-${Date.now()}@example.invalid`, nationalId, referralCode: referrer.referralCode! } as RegisterCustomerDto)).rejects.toBeInstanceOf(BadRequestException);
  });

  databaseTest('logs in with normalized email and revokes the server-side session on logout', async () => {
    const result = await auth.loginCustomer({ email: ` ${userEmail.toUpperCase()} `, password: 'test-customer-password' });
    const sessionHash = hashToken(result.token);
    expect(await prisma.customerSession.findUnique({ where: { tokenHash: sessionHash } })).not.toBeNull();
    await expect(auth.loginCustomer({ email: userEmail, password: 'wrong-password' })).rejects.toBeInstanceOf(UnauthorizedException);
    await auth.logoutCustomer(sessionHash);
    expect((await prisma.customerSession.findUniqueOrThrow({ where: { tokenHash: sessionHash } })).revokedAt).not.toBeNull();
  });

  databaseTest('fails closed when OTP delivery fails and accepts a valid code only once', async () => {
    const passwordDto = Object.assign(new SuperadminPasswordDto(), {
      email: adminEmail,
      password: 'test-superadmin-password',
    });
    failOtpDelivery = true;
    await expect(auth.requestSuperadminOtp(passwordDto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await prisma.superadminSession.count({ where: { superadminId: adminId } })).toBe(0);
    expect((await prisma.superadminOtpChallenge.findFirstOrThrow({ where: { superadminId: adminId } })).invalidatedAt).not.toBeNull();

    failOtpDelivery = false;
    const { challengeId } = await auth.requestSuperadminOtp(passwordDto);
    const otpDto = Object.assign(new SuperadminOtpDto(), { challengeId, code: deliveredCode });
    const result = await auth.verifySuperadminOtp(otpDto);
    expect(result.principal.role).toBe('SUPERADMIN');
    expect(await prisma.superadminSession.findUnique({ where: { tokenHash: hashToken(result.token) } })).not.toBeNull();
    await expect(auth.verifySuperadminOtp(otpDto)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
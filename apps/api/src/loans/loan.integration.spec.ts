import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanService } from './loan.service';
import { AcceptLoanOfferDto, CreateLoanApplicationDto, CreateLoanProductDto, ReviewLoanApplicationDto } from './loan.dto';
import { randomInt, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = databaseUrl ? it : it.skip;

describe('loan workflow database integration', () => {
  let prisma: PrismaService;
  let loans: LoanService;
  let adminId: string;
  let userId: string;
  let productId: string;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const parsedUrl = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database whose name ends in _test.');
    }
    prisma = new PrismaService();
    await prisma.$connect();
    loans = new LoanService(prisma);
    const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const [admin, user] = await Promise.all([
      prisma.superadminUser.create({
        data: {
          email: `loan-admin-${suffix}@example.invalid`,
          passwordHash: await bcrypt.hash('loan-admin-test-password', 4),
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      }),
      prisma.user.create({
        data: {
          fullName: 'Loan Test Customer',
          email: `loan-customer-${suffix}@example.invalid`,
          phone: `+2547${randomInt(0, 100_000_000).toString().padStart(8, '0')}`,
          nationalIdCiphertext: 'test-fixture-only',
          nationalIdHash: randomBytes(32).toString('hex'),
          passwordHash: await bcrypt.hash('loan-customer-test-password', 4),
          termsVersion: 'test-v1',
          privacyVersion: 'test-v1',
        },
        select: { id: true },
      }),
    ]);
    adminId = admin.id;
    userId = user.id;
  });

  afterAll(async () => {
    if (!databaseUrl || !prisma) return;
    if (userId) {
      await prisma.loan.deleteMany({ where: { userId } });
      await prisma.loanApplication.deleteMany({ where: { userId } });
    }
    if (productId) await prisma.loanProduct.deleteMany({ where: { id: productId } });
    await prisma.adminAuditLog.deleteMany({ where: { superadminId: adminId } });
    await prisma.authAuditLog.deleteMany({ where: { actorId: { in: [userId, adminId].filter(Boolean) } } });
    await prisma.consentRecord.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.superadminUser.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  databaseTest('enforces activation, scoped applications, manual review, terms acceptance, and one-time offer conversion', async () => {
    const productDto = Object.assign(new CreateLoanProductDto(), {
      name: 'Integration Test Product',
      description: 'Test-only product configuration for automated checks.',
      minimumPrincipalKes: 500,
      maximumPrincipalKes: 5000,
      durationDays: 30,
      interestRateBps: 1000,
      flatFeeKes: 10,
      termsVersion: 'test-product-v1',
    });
    const product = await loans.createProduct(productDto, adminId);
    productId = product.id;
    expect(product.isAvailable).toBe(false);
    await loans.updateProduct(product.id, { isAvailable: true }, adminId);

    const applicationDto = Object.assign(new CreateLoanApplicationDto(), {
      productId: product.id,
      requestedPrincipalKes: 3000,
    });
    await expect(loans.createApplication(userId, applicationDto)).rejects.toBeInstanceOf(ForbiddenException);
    await prisma.user.update({ where: { id: userId }, data: { activationStatus: 'ACTIVE' } });

    const application = await loans.createApplication(userId, applicationDto);
    expect(application.status).toBe('SUBMITTED');
    expect(await loans.listMyApplications(adminId)).toHaveLength(0);

    const reviewDto = Object.assign(new ReviewLoanApplicationDto(), {
      decision: 'APPROVE',
      reason: 'Integration test approval only.',
      approvedPrincipalKes: 3000,
    });
    const reviewed = await loans.reviewApplication(application.id, reviewDto, adminId);
    expect(reviewed.status).toBe('APPROVED');
    expect(reviewed.approvedChargesKes).toBe(310);
    await expect(loans.reviewApplication(application.id, reviewDto, adminId)).rejects.toBeInstanceOf(ConflictException);

    const acceptance = Object.assign(new AcceptLoanOfferDto(), { termsAccepted: true });
    const loan = await loans.acceptOffer(userId, application.id, acceptance);
    expect(loan.principalKes).toBe(3000);
    expect(loan.totalRepayableKes).toBe(3310);
    expect(loan.status).toBe('DISBURSEMENT_PENDING');
    await expect(loans.acceptOffer(userId, application.id, acceptance)).rejects.toBeInstanceOf(ConflictException);
  });
});
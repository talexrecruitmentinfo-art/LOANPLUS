import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { LoanService } from './loan.service';
import { AcceptLoanOfferDto, ConfirmManualDisbursementDto, CreateLoanApplicationDto, CreateLoanProductDto, ReviewLoanApplicationDto } from './loan.dto';
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
  let disbursementAccountIds: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const parsedUrl = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database whose name ends in _test.');
    }
    prisma = new PrismaService();
    await prisma.$connect();
    loans = new LoanService(prisma, new LedgerService(prisma));
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
    const accounts = await Promise.all([
      prisma.ledgerAccount.create({
        data: { code: 'DISBURSEMENT_CASH', name: 'Test disbursement cash', accountType: 'ASSET' },
        select: { id: true },
      }),
      prisma.ledgerAccount.create({
        data: { code: 'LOAN_RECEIVABLE', name: 'Test loan receivables', accountType: 'ASSET' },
        select: { id: true },
      }),
    ]);
    disbursementAccountIds = accounts.map((account) => account.id);
  });

  afterAll(async () => {
    if (!databaseUrl || !prisma) return;
    if (userId) {
      const loans = await prisma.loan.findMany({ where: { userId }, select: { id: true } });
      const loanIds = loans.map((loan) => loan.id);
      if (loanIds.length) {
        await prisma.loanDisbursement.deleteMany({ where: { loanId: { in: loanIds } } });
        await prisma.repaymentSchedule.deleteMany({ where: { loanId: { in: loanIds } } });
        const transactions = await prisma.ledgerTransaction.findMany({
          where: { idempotencyKey: { in: loanIds.map((id) => `loan-disbursement:${id}`) } },
          select: { id: true },
        });
        const transactionIds = transactions.map((transaction) => transaction.id);
        if (transactionIds.length) {
          await prisma.ledgerEntry.deleteMany({ where: { ledgerTransactionId: { in: transactionIds } } });
          await prisma.ledgerTransaction.deleteMany({ where: { id: { in: transactionIds } } });
        }
      }
      await prisma.loan.deleteMany({ where: { userId } });
      await prisma.loanApplication.deleteMany({ where: { userId } });
    }
    if (disbursementAccountIds.length) {
      await prisma.ledgerAccount.deleteMany({ where: { id: { in: disbursementAccountIds } } });
    }
    if (productId) await prisma.loanProduct.deleteMany({ where: { id: productId } });
    await prisma.adminAuditLog.deleteMany({ where: { superadminId: adminId } });
    await prisma.authAuditLog.deleteMany({ where: { actorId: { in: [userId, adminId].filter(Boolean) } } });
    await prisma.consentRecord.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.superadminUser.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  databaseTest('validates draft applications, manual review, terms acceptance, and one-time offer conversion', async () => {
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
      guarantorOneName: 'First Test Guarantor',
      guarantorOnePhone: '0712345678',
      guarantorTwoName: 'Second Test Guarantor',
      guarantorTwoPhone: '0723456789',
    });
    await expect(loans.createApplication(userId, {
      ...applicationDto,
      guarantorTwoPhone: '254712345678',
    }, 'loan-invalid-guarantor-key-01')).rejects.toBeInstanceOf(UnprocessableEntityException);

    const draft = await loans.createApplication(userId, applicationDto, 'loan-application-test-key-01');
    expect(draft.status).toBe('DRAFT');
    expect((await loans.createApplication(userId, applicationDto, 'loan-application-test-key-01')).id).toBe(draft.id);
    expect(await loans.listMyApplications(adminId)).toHaveLength(0);
    const application = await prisma.loanApplication.update({
      where: { id: draft.id },
      data: { status: 'SUBMITTED' },
    });

    const reviewDto = Object.assign(new ReviewLoanApplicationDto(), {
      decision: 'APPROVE',
      reason: 'Integration test approval only.',
      approvedPrincipalKes: 3000,
    });
    const reviewed = await loans.reviewApplication(application.id, reviewDto, adminId);
    expect(reviewed.status).toBe('APPROVED');
    expect(reviewed.approvedChargesKes).toBe(310);
    expect(reviewed.approvedTermsSnapshot).toMatchObject({
      termsVersion: 'test-product-v1',
      durationDays: 30,
      interestRateBps: 1000,
      flatFeeKes: 10,
    });
    await expect(loans.reviewApplication(application.id, reviewDto, adminId)).rejects.toBeInstanceOf(ConflictException);
    await loans.updateProduct(product.id, {
      durationDays: 90,
      interestRateBps: 5000,
      flatFeeKes: 100,
      termsVersion: 'test-product-v2',
    }, adminId);

    const acceptance = Object.assign(new AcceptLoanOfferDto(), { termsAccepted: true });
    const loan = await loans.acceptOffer(userId, application.id, acceptance);
    expect(loan.principalKes).toBe(3000);
    expect(loan.totalRepayableKes).toBe(3310);
    expect(loan.acceptedTermsVersion).toBe('test-product-v1');
    expect(loan.status).toBe('DISBURSEMENT_PENDING');
    await expect(loans.acceptOffer(userId, application.id, acceptance)).rejects.toBeInstanceOf(ConflictException);

    const manualDisbursement = Object.assign(new ConfirmManualDisbursementDto(), {
      paymentReference: `TEST-DISBURSE-${randomBytes(6).toString('hex')}`,
      reason: 'Integration test records an operator-confirmed manual payout.',
    });
    const attempts = await Promise.allSettled([
      loans.confirmManualDisbursement(loan.id, manualDisbursement, adminId),
      loans.confirmManualDisbursement(loan.id, manualDisbursement, adminId),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejectedAttempt = attempts.find((attempt) => attempt.status === 'rejected');
    if (rejectedAttempt?.status !== 'rejected') throw new Error('A concurrent disbursement request was not rejected.');
    expect(rejectedAttempt.reason).toBeInstanceOf(ConflictException);
    const successfulAttempt = attempts.find((attempt) => attempt.status === 'fulfilled');
    if (successfulAttempt?.status !== 'fulfilled') throw new Error('No disbursement request succeeded.');
    const disbursed = successfulAttempt.value;
    expect(disbursed.status).toBe('DISBURSED');
    const schedule = await prisma.repaymentSchedule.findUniqueOrThrow({ where: { loanId_sequence: { loanId: loan.id, sequence: 1 } } });
    expect(schedule.amountDueKes).toBe(3310);
    expect(schedule.dueAt).toEqual(disbursed.dueAt);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).disbursedAt).not.toBeNull();
    await expect(loans.confirmManualDisbursement(loan.id, manualDisbursement, adminId)).rejects.toBeInstanceOf(ConflictException);
  });
});
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { CreateLoanApplicationDto } from '../loans/loan.dto';
import { LoanService } from '../loans/loan.service';
import { InitiateLoanProcessingFeeDto } from './payment.dto';
import { MpesaService } from './mpesa.service';
import { PaymentService } from './payment.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = databaseUrl ? it : it.skip;

describe('loan processing-fee payment database integration', () => {
  let prisma: PrismaService;
  let payments: PaymentService;
  let loans: LoanService;
  let adminId: string;
  let userId: string;
  let productId: string;
  let applicationId: string;
  let paymentId: string;
  let accountIds: string[] = [];
  let callbackUrl = '';
  let merchantRequestId = '';

  const mpesa = {
    assertConfiguredForPayments: jest.fn(),
    initiateStkPush: jest.fn(async (input: { callbackUrl: string }) => {
      callbackUrl = input.callbackUrl;
      merchantRequestId = `mr_${randomBytes(8).toString('hex')}`;
      return { checkoutRequestId: `ws_CO_${randomBytes(8).toString('hex')}`, merchantRequestId };
    }),
    queryStkStatus: jest.fn(async (checkoutRequestId: string) => ({
      checkoutRequestId,
      merchantRequestId,
      resultCode: 0,
      resultDescription: 'Test fixture provider response',
    })),
  } as unknown as MpesaService;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = 'test';
    process.env.MPESA_CALLBACK_URL = 'https://callbacks.example.com/api/v1/payments/mpesa/callback';
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED = 'true';
    process.env.LOAN_PROCESSING_FEE_POLICY_VERSION = 'test-approved-v1';
    process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE =
      'Test-only approved processing-fee policy for isolated integration verification.';
    const parsedUrl = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database whose name ends in _test.');
    }
    prisma = new PrismaService();
    await prisma.$connect();
    const ledger = new LedgerService(prisma);
    payments = new PaymentService(prisma, mpesa, ledger);
    loans = new LoanService(prisma, ledger);

    const admin = await prisma.superadminUser.create({
      data: {
        email: `processing-fee-admin-${Date.now()}-${randomBytes(4).toString('hex')}@example.invalid`,
        passwordHash: 'test-fixture-only',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    adminId = admin.id;
    const accounts = await Promise.all([
      prisma.ledgerAccount.create({
        data: { code: 'MPESA_CLEARING', name: 'Test M-Pesa clearing', accountType: 'ASSET' },
        select: { id: true },
      }),
      prisma.ledgerAccount.create({
        data: { code: 'LOAN_PROCESSING_FEES', name: 'Test loan processing-fee revenue', accountType: 'REVENUE' },
        select: { id: true },
      }),
    ]);
    accountIds = accounts.map((account) => account.id);
    const user = await prisma.user.create({
      data: {
        fullName: 'Processing Fee Test Customer',
        email: `processing-fee-${Date.now()}-${randomBytes(4).toString('hex')}@example.invalid`,
        phone: '+254712345678',
        nationalIdCiphertext: 'test-fixture-only',
        nationalIdHash: randomBytes(32).toString('hex'),
        passwordHash: 'test-fixture-only',
        termsVersion: 'test-v1',
        privacyVersion: 'test-v1',
      },
      select: { id: true },
    });
    userId = user.id;
    const product = await prisma.loanProduct.create({
      data: {
        name: 'Processing Fee Integration Product',
        description: 'Test-only configured product for isolated payment integration checks.',
        minimumPrincipalKes: 500,
        maximumPrincipalKes: 5000,
        durationDays: 30,
        interestRateBps: 1000,
        flatFeeKes: 10,
        termsVersion: 'test-product-v1',
        isAvailable: true,
      },
      select: { id: true },
    });
    productId = product.id;
    await loans.configureProcessingFeeRevenueAccount(
      'LOAN_PROCESSING_FEES',
      'Configure isolated integration-test accounting only.',
      adminId,
    );
  });

  afterAll(async () => {
    if (!databaseUrl || !prisma) return;
    if (userId) {
      const paymentsForUser = await prisma.paymentTransaction.findMany({ where: { userId }, select: { id: true } });
      const ids = paymentsForUser.map((payment) => payment.id);
      if (ids.length) {
        await prisma.paymentCallbackEvent.deleteMany({ where: { paymentTransactionId: { in: ids } } });
        await prisma.paymentReconciliationAttempt.deleteMany({ where: { paymentTransactionId: { in: ids } } });
        await prisma.ledgerEntry.deleteMany({ where: { transaction: { paymentId: { in: ids } } } });
        await prisma.ledgerTransaction.deleteMany({ where: { paymentId: { in: ids } } });
        await prisma.idempotencyRecord.deleteMany({ where: { paymentTransactionId: { in: ids } } });
        await prisma.activationPaymentRequest.deleteMany({ where: { paymentTransactionId: { in: ids } } });
        await prisma.paymentTransaction.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.loanApplication.deleteMany({ where: { userId } });
      await prisma.loanProduct.deleteMany({ where: { id: productId } });
      await prisma.ledgerEntry.deleteMany({ where: { ledgerAccountId: { in: accountIds } } });
      await prisma.ledgerAccount.deleteMany({ where: { id: { in: accountIds } } });
      await prisma.systemSetting.deleteMany({ where: { key: 'loan.processing_fee_revenue_account' } });
      await prisma.authAuditLog.deleteMany({ where: { actorId: userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    if (adminId) {
      await prisma.adminAuditLog.deleteMany({ where: { superadminId: adminId } });
      await prisma.superadminUser.deleteMany({ where: { id: adminId } });
    }
    await prisma.$disconnect();
  });

  databaseTest('submits only after confirmed fee, posts revenue without wallet credit, and settles callbacks once', async () => {
    const applicationDto = Object.assign(new CreateLoanApplicationDto(), {
      productId,
      termsAccepted: true,
      requestedPrincipalKes: 3000,
      guarantorOneName: 'First Guarantor',
      guarantorOnePhone: '0712345678',
      guarantorTwoName: 'Second Guarantor',
      guarantorTwoPhone: '0723456789',
    });
    const draft = await loans.createApplication(userId, applicationDto, 'loan-application-idempotency-01');
    applicationId = draft.id;
    expect(draft.status).toBe('DRAFT');
    expect(await prisma.loanApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: { submittedAt: true },
    })).toEqual({ submittedAt: null });

    const started = await payments.initiateLoanProcessingFee(
      userId,
      Object.assign(new InitiateLoanProcessingFeeDto(), { applicationId, reviewConfirmed: true }),
      'loan-processing-fee-idempotency-01',
    );
    expect(started).toMatchObject({ status: 'PENDING', amountKes: 50, currency: 'KES' });
    const transaction = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { internalReference: started.reference },
    });
    paymentId = transaction.id;
    expect(transaction).toMatchObject({
      type: 'LOAN_PROCESSING_FEE',
      loanApplicationId: applicationId,
      status: 'PENDING',
    });
    expect(await prisma.loanApplication.findUniqueOrThrow({ where: { id: applicationId } })).toMatchObject({
      status: 'PROCESSING_PAYMENT_PENDING',
    });

    const checkoutRequestId = new URL(callbackUrl).searchParams.get('unused') ??
      await prisma.activationPaymentRequest.findUniqueOrThrow({
        where: { paymentTransactionId: paymentId },
        select: { checkoutRequestId: true },
      }).then((request) => request.checkoutRequestId);
    if (!checkoutRequestId) throw new Error('Mock provider checkout ID was not persisted.');
    const payload = {
      Body: {
        stkCallback: {
          CheckoutRequestID: checkoutRequestId,
          MerchantRequestID: merchantRequestId,
          ResultCode: 0,
          ResultDesc: 'Payment confirmed in integration fixture.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 50 },
              { Name: 'MpesaReceiptNumber', Value: 'TESTFEE123' },
              { Name: 'PhoneNumber', Value: 254712345678 },
            ],
          },
        },
      },
    };
    const callbackToken = new URL(callbackUrl).pathname.split('/').at(-1);
    if (!callbackToken) throw new Error('Mock provider callback token was not retained.');

    await payments.handleMpesaCallback(callbackToken, payload);
    await payments.handleMpesaCallback(callbackToken, payload);

    const [confirmedPayment, submittedApplication, entries, wallet] = await Promise.all([
      prisma.paymentTransaction.findUniqueOrThrow({ where: { id: paymentId } }),
      prisma.loanApplication.findUniqueOrThrow({ where: { id: applicationId } }),
      prisma.ledgerEntry.findMany({ where: { transaction: { paymentId } }, include: { account: true } }),
      prisma.ledgerAccount.findMany({ where: { userId } }),
    ]);
    expect(confirmedPayment).toMatchObject({ status: 'CONFIRMED', amountKes: 50, receiptReference: 'TESTFEE123' });
    expect(submittedApplication.status).toBe('SUBMITTED');
    expect(submittedApplication.submittedAt).toBeInstanceOf(Date);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.account.id === accountIds[0])).toMatchObject({ debitKes: 50, creditKes: 0 });
    expect(entries.find((entry) => entry.account.id === accountIds[1])).toMatchObject({ debitKes: 0, creditKes: 50 });
    expect(wallet).toHaveLength(0);

    const secondDraft = await loans.createApplication(userId, applicationDto, 'loan-application-idempotency-02');
    const secondPayment = await payments.initiateLoanProcessingFee(
      userId,
      Object.assign(new InitiateLoanProcessingFeeDto(), {
        applicationId: secondDraft.id,
        reviewConfirmed: true,
      }),
      'loan-processing-fee-idempotency-02',
    );
    const secondTransaction = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { internalReference: secondPayment.reference },
    });
    expect(secondDraft.id).not.toBe(applicationId);
    expect(secondPayment.reference).not.toBe(started.reference);
    expect(secondTransaction).toMatchObject({
      type: 'LOAN_PROCESSING_FEE',
      loanApplicationId: secondDraft.id,
      status: 'PENDING',
      amountKes: 50,
    });
    expect(mpesa.initiateStkPush).toHaveBeenCalledTimes(2);
  });
});

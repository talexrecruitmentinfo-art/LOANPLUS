import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { ActivationSettingsService } from './activation-settings.service';
import { MpesaService } from './mpesa.service';
import { PaymentService } from './payment.service';
import { ConfigureActivationDto, InitiateActivationPaymentDto } from './payment.dto';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = databaseUrl ? it : it.skip;

describe('activation payment database integration', () => {
  let prisma: PrismaService;
  let payments: PaymentService;
  let settings: ActivationSettingsService;
  let adminId: string;
  let customerIds: string[] = [];
  let clearingAccountId: string;
  let callbackUrl = '';
  let merchantRequestId = '';
  let providerResultCode = 0;

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
      resultCode: providerResultCode,
      resultDescription: 'Test fixture provider response',
    })),
  } as unknown as MpesaService;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = 'test';
    process.env.MPESA_CALLBACK_URL = 'https://callbacks.example.invalid/api/v1/payments/mpesa/callback';
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    const parsedUrl = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database whose name ends in _test.');
    }
    prisma = new PrismaService();
    await prisma.$connect();
    const ledger = new LedgerService(prisma);
    payments = new PaymentService(prisma, mpesa, ledger);
    settings = new ActivationSettingsService(prisma);

    const admin = await prisma.superadminUser.create({
      data: {
        email: `payment-admin-${Date.now()}-${randomBytes(4).toString('hex')}@example.invalid`,
        passwordHash: 'test-fixture-only',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    adminId = admin.id;
    const clearing = await prisma.ledgerAccount.create({
      data: {
        code: `MPESA_CLEARING_${randomBytes(4).toString('hex')}`,
        name: 'Test M-Pesa clearing account',
        accountType: 'ASSET',
      },
      select: { id: true },
    });
    clearingAccountId = clearing.id;
    await prisma.ledgerAccount.update({ where: { id: clearingAccountId }, data: { code: 'MPESA_CLEARING' } });
    const userData = Array.from({ length: 2 }, (_, index) => ({
      fullName: `Payment Test Customer ${index + 1}`,
      email: `payment-${Date.now()}-${index}-${randomBytes(4).toString('hex')}@example.invalid`,
      phone: `+2547${randomInt(0, 100_000_000).toString().padStart(8, '0')}`,
      nationalIdCiphertext: 'test-fixture-only',
      nationalIdHash: randomBytes(32).toString('hex'),
      passwordHash: 'test-fixture-only',
      termsVersion: 'test-v1',
      privacyVersion: 'test-v1',
    }));
    const users = await prisma.user.createMany({ data: userData });
    if (users.count !== 2) throw new Error('Could not create isolated payment test users.');
    const createdUsers = await prisma.user.findMany({ where: { email: { in: userData.map((user) => user.email) } }, select: { id: true } });
    customerIds = createdUsers.map((user) => user.id);
  });

  afterAll(async () => {
    if (!databaseUrl || !prisma) return;
    const paymentIds = await prisma.paymentTransaction.findMany({ where: { userId: { in: customerIds } }, select: { id: true } });
    const ids = paymentIds.map((payment) => payment.id);
    if (ids.length) {
      await prisma.paymentCallbackEvent.deleteMany({ where: { paymentTransactionId: { in: ids } } });
      await prisma.ledgerEntry.deleteMany({ where: { transaction: { paymentId: { in: ids } } } });
      await prisma.ledgerTransaction.deleteMany({ where: { paymentId: { in: ids } } });
      await prisma.idempotencyRecord.deleteMany({ where: { paymentTransactionId: { in: ids } } });
      await prisma.activationPaymentRequest.deleteMany({ where: { paymentTransactionId: { in: ids } } });
      await prisma.paymentTransaction.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.ledgerEntry.deleteMany({ where: { ledgerAccountId: { in: [clearingAccountId].filter(Boolean) } } });
    await prisma.ledgerAccount.deleteMany({ where: { id: clearingAccountId } });
    await prisma.ledgerAccount.deleteMany({ where: { userId: { in: customerIds } } });
    await prisma.systemSetting.deleteMany({ where: { key: { in: ['activation.amount_kes', 'activation.payment_policy'] } } });
    await prisma.authAuditLog.deleteMany({ where: { actorId: { in: [...customerIds, adminId].filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { superadminId: adminId } });
    await prisma.superadminUser.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  databaseTest('keeps unapproved activation disabled and confirms only provider-verified successful payments', async () => {
    const unapproved = Object.assign(new ConfigureActivationDto(), {
      amountKes: 50,
      approved: false,
      purpose: 'Development test activation disclosure.',
      refundability: 'CONDITIONAL_REFUND',
      creditedToWallet: true,
      accountingTreatment: 'No live accounting configured for this test.',
      customerDisclosure: 'Development test disclosure; no live payment is performed.',
      termsVersion: 'test-activation-v1',
      reason: 'Keep test activation disabled before approval.',
    });
    await settings.configure(unapproved, adminId);
    const input = Object.assign(new InitiateActivationPaymentDto(), { phoneNumber: '0712345678', termsAccepted: true });
    await expect(payments.initiateActivationPayment(customerIds[0], input, 'activation-test-key-0001')).rejects.toBeInstanceOf(ServiceUnavailableException);

    const approved = Object.assign(new ConfigureActivationDto(), { ...unapproved, approved: true, reason: 'Approved only for the integration fixture.' });
    await settings.configure(approved, adminId);
    const started = await payments.initiateActivationPayment(customerIds[0], input, 'activation-test-key-0001');
    expect(started.status).toBe('PENDING');
    expect(started.amountKes).toBe(50);
    const repeated = await payments.initiateActivationPayment(customerIds[0], input, 'activation-test-key-0001');
    expect(repeated.reference).toBe(started.reference);
    await expect(payments.initiateActivationPayment(
      customerIds[0],
      Object.assign(new InitiateActivationPaymentDto(), { phoneNumber: '0712345679', termsAccepted: true }),
      'activation-test-key-0001',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(mpesa.initiateStkPush).toHaveBeenCalledTimes(1);

    const payment = await prisma.paymentTransaction.findUniqueOrThrow({ where: { internalReference: started.reference } });
    const request = await prisma.activationPaymentRequest.findUniqueOrThrow({ where: { paymentTransactionId: payment.id } });
    const token = new URL(callbackUrl).pathname.split('/').at(-1)!;
    const callback = {
      Body: {
        stkCallback: {
          CheckoutRequestID: request.checkoutRequestId,
          MerchantRequestID: request.merchantRequestId,
          ResultCode: 0,
          ResultDesc: 'Success',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 50 },
              { Name: 'MpesaReceiptNumber', Value: 'TESTRECEIPT1' },
              { Name: 'PhoneNumber', Value: 254712345678 },
            ],
          },
        },
      },
    };
    providerResultCode = 0;
    await payments.handleMpesaCallback(token, callback);
    await payments.handleMpesaCallback(token, callback);
    expect(mpesa.queryStkStatus).toHaveBeenCalledTimes(1);
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('CONFIRMED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customerIds[0] } })).activationStatus).toBe('ACTIVE');
    expect(await new LedgerService(prisma).getCustomerWallet(customerIds[0])).toEqual({ balanceKes: 50, currency: 'KES' });

    const failed = await payments.initiateActivationPayment(customerIds[1], input, 'activation-test-key-0002');
    const failedPayment = await prisma.paymentTransaction.findUniqueOrThrow({ where: { internalReference: failed.reference } });
    const failedRequest = await prisma.activationPaymentRequest.findUniqueOrThrow({ where: { paymentTransactionId: failedPayment.id } });
    const failedToken = new URL(callbackUrl).pathname.split('/').at(-1)!;
    providerResultCode = 1032;
    await payments.handleMpesaCallback(failedToken, {
      Body: {
        stkCallback: {
          CheckoutRequestID: failedRequest.checkoutRequestId,
          MerchantRequestID: failedRequest.merchantRequestId,
          ResultCode: 1032,
          ResultDesc: 'Cancelled by user',
        },
      },
    });
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: failedPayment.id } })).status).toBe('FAILED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customerIds[1] } })).activationStatus).toBe('PENDING');
  });
});
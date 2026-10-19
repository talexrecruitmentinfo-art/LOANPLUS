import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentType, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSensitiveValue, hashToken } from '../auth/security.util';
import { LedgerService } from '../ledger/ledger.service';
import { MpesaService } from './mpesa.service';
import { PaymentService } from './payment.service';
import { InitiateLoanProcessingFeeDto } from './payment.dto';

describe('M-Pesa payment callback reconciliation', () => {
  const originalEncryptionKey = process.env.ID_ENCRYPTION_KEY_BASE64;
  const callbackToken = 'unit-test-callback-secret';
  const checkoutRequestId = 'ws_CO_test';
  const merchantRequestId = 'mr_test';
  let paymentStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  let paymentFailureCode: string | null;
  let events: Set<string>;
  let transactionCount: number;
  let failNextTransaction: boolean;
  let providerResultCode: number;
  let providerCheckoutRequestId: string;
  let providerMerchantRequestId: string;
  let nextTransactionError: Error | null;
  let paymentUpdateData: Record<string, unknown> | undefined;
  let callbackEventData: Record<string, unknown> | undefined;
  let activationRequestRecord: Record<string, unknown>;
  let paymentService: PaymentService;
  let queryStkStatus: jest.Mock;
  let postLedger: jest.Mock;
  let userUpdate: jest.Mock;
  let transactionClient: Record<string, Record<string, jest.Mock>>;
  let prisma: PrismaService;

  function successfulCallback(overrides: Record<string, unknown> = {}) {
    return {
      Body: {
        stkCallback: {
          CheckoutRequestID: checkoutRequestId,
          MerchantRequestID: merchantRequestId,
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 50 },
              { Name: 'MpesaReceiptNumber', Value: 'TESTRECEIPT1' },
              { Name: 'PhoneNumber', Value: 254712345678 },
            ],
          },
          ...overrides,
        },
      },
    };
  }

  beforeEach(() => {
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    paymentStatus = 'PENDING';
    paymentFailureCode = null;
    events = new Set();
    transactionCount = 0;
    failNextTransaction = false;
    providerResultCode = 0;
    providerCheckoutRequestId = checkoutRequestId;
    providerMerchantRequestId = merchantRequestId;
    nextTransactionError = null;
    paymentUpdateData = undefined;
    callbackEventData = undefined;
    queryStkStatus = jest.fn(async () => ({
      checkoutRequestId: providerCheckoutRequestId,
      merchantRequestId: providerMerchantRequestId,
      resultCode: providerResultCode,
      resultDescription: 'test provider result',
    }));
    postLedger = jest.fn(async () => undefined);
    userUpdate = jest.fn(async () => ({}));
    const request = {
      id: 'activation-request-id',
      paymentTransactionId: 'payment-id',
      userId: 'user-id',
      callbackTokenHash: hashToken(callbackToken),
      checkoutRequestId,
      merchantRequestId,
      phoneNumberCiphertext: encryptSensitiveValue('+254712345678'),
      expiresAt: new Date(Date.now() - 60_000),
      policySnapshot: {
        approved: true,
        purpose: 'Activation',
        refundability: 'CONDITIONAL_REFUND',
        creditedToWallet: true,
        accountingTreatment: 'Wallet liability',
        customerDisclosure: 'Test activation policy disclosure.',
        termsVersion: 'test-v1',
        creditAccountCode: null,
      },
      paymentTransaction: {
        id: 'payment-id',
        userId: 'user-id',
        type: PaymentType.ACTIVATION,
        loanApplicationId: null,
        amountKes: 50,
        currency: 'KES',
        status: paymentStatus,
        failureCode: paymentFailureCode,
      },
    };
    activationRequestRecord = request;
    transactionClient = {
      activationPaymentRequest: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      paymentCallbackEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> & { payloadHash: string } }) => {
          callbackEventData = data;
          events.add(data.payloadHash);
          return {};
        }),
      },
      paymentTransaction: {
        updateMany: jest.fn(async ({ where, data }: {
          where: { status?: string; OR?: Array<{ status?: string }> };
          data: Record<string, unknown> & { status?: 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' };
        }) => {
          const allowedStatuses = where.status
            ? [where.status]
            : where.OR?.flatMap((condition) => condition.status ? [condition.status] : []) ?? [];
          if (!allowedStatuses.includes(paymentStatus)) return { count: 0 };
          if (typeof data.status !== 'string') {
            paymentUpdateData = data;
            paymentFailureCode = typeof data.failureCode === 'string' ? data.failureCode : null;
            return { count: 1 };
          }
          paymentUpdateData = data;
          paymentStatus = data.status;
          paymentFailureCode = typeof data.failureCode === 'string' ? data.failureCode : null;
          transactionCount += 1;
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn(async () => ({
          id: 'payment-id',
          status: paymentStatus,
        })),
      },
      ledgerAccount: {
        findUnique: jest.fn(async ({ where }: { where: { code: string } }) => {
          if (where.code === 'MPESA_CLEARING') {
            return { id: 'clearing-account', isActive: true, currency: 'KES', accountType: 'ASSET' };
          }
          if (where.code === 'LOAN_PROCESSING_FEES') {
            return { id: 'revenue-account', isActive: true, currency: 'KES', accountType: 'REVENUE' };
          }
          return { id: 'wallet-account', userId: 'user-id', isActive: true, currency: 'KES', accountType: 'LIABILITY' };
        }),
        create: jest.fn(async () => ({
          id: 'wallet-account',
          userId: 'user-id',
          isActive: true,
          currency: 'KES',
          accountType: 'LIABILITY',
        })),
      },
      loanApplication: {
        findFirst: jest.fn(async () => ({ id: 'loan-application-id' })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      systemSetting: { findUnique: jest.fn(async () => ({ value: 'LOAN_PROCESSING_FEES' })) },
      user: { update: userUpdate },
      referral: { updateMany: jest.fn(async () => ({ count: 0 })) },
      authAuditLog: { create: jest.fn(async () => ({})) },
    };
    const prismaMock = {
      activationPaymentRequest: {
        findUnique: jest.fn(async ({ where }: { where: { callbackTokenHash: string } }) =>
          where.callbackTokenHash === request.callbackTokenHash ? request : null),
      },
      paymentCallbackEvent: {
        findFirst: jest.fn(async ({ where }: { where: { payloadHash: string } }) =>
          events.has(where.payloadHash) ? { id: 'existing-event' } : null),
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown> & { payloadHash: string }> }) => {
          for (const entry of data) {
            callbackEventData = entry;
            events.add(entry.payloadHash);
          }
          return { count: data.length };
        }),
      },
      $transaction: jest.fn(async (callback: (tx: never) => Promise<unknown>) => {
        if (nextTransactionError) {
          const error = nextTransactionError;
          nextTransactionError = null;
          throw error;
        }
        if (failNextTransaction) {
          failNextTransaction = false;
          throw new Error('test database unavailable');
        }
        return callback(transactionClient as never);
      }),
    } as unknown as PrismaService;
    prisma = prismaMock;
    paymentService = new PaymentService(
      prisma,
      { queryStkStatus } as unknown as MpesaService,
      { postWithinTransaction: postLedger } as unknown as LedgerService,
    );
  });

  it('keeps an unverified nonzero callback unresolved and allows later verified success', async () => {
    providerResultCode = 1032;
    await paymentService.handleMpesaCallback(callbackToken, {
      Body: {
        stkCallback: {
          CheckoutRequestID: checkoutRequestId,
          MerchantRequestID: merchantRequestId,
          ResultCode: 1032,
          ResultDesc: 'Request cancelled by user.',
        },
      },
    });
    expect(paymentStatus).toBe('PENDING');
    expect(paymentFailureCode).toBe('MPESA_RESULT_1032');

    providerResultCode = 0;
    await paymentService.handleMpesaCallback(callbackToken, successfulCallback());
    expect(paymentStatus).toBe('CONFIRMED');
    expect(paymentFailureCode).toBeNull();
    expect(postLedger).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['checkout', 'different-checkout', merchantRequestId],
    ['merchant', checkoutRequestId, 'different-merchant'],
  ])('rejects a query response with an unexpected %s request ID', async (_name, queryCheckoutId, queryMerchantId) => {
    providerCheckoutRequestId = queryCheckoutId;
    providerMerchantRequestId = queryMerchantId;
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();
  });

  it('leaves a callback pending when the STK query fails', async () => {
    queryStkStatus.mockRejectedValueOnce(new ServiceUnavailableException('Provider query failed.'));
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();
  });

  it('acknowledges a concurrent duplicate only when the matching callback event exists', async () => {
    nextTransactionError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '6.19.3' },
    );
    const payload = successfulCallback();
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    events.add(payloadHash);
    await expect(paymentService.handleMpesaCallback(callbackToken, payload))
      .resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();
  });

  it('does not acknowledge unrelated database unique violations as duplicate callbacks', async () => {
    nextTransactionError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '6.19.3' },
    );
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ID_ENCRYPTION_KEY_BASE64;
    else process.env.ID_ENCRYPTION_KEY_BASE64 = originalEncryptionKey;
  });

  describe('loan processing-fee initiation', () => {
    const originalEnvironment = {
      nodeEnv: process.env.NODE_ENV,
      encryptionKey: process.env.ID_ENCRYPTION_KEY_BASE64,
      callbackUrl: process.env.MPESA_CALLBACK_URL,
      policyApproved: process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED,
      policyVersion: process.env.LOAN_PROCESSING_FEE_POLICY_VERSION,
      policyDisclosure: process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE,
    };

    afterEach(() => {
      for (const [name, value] of Object.entries({
        NODE_ENV: originalEnvironment.nodeEnv,
        ID_ENCRYPTION_KEY_BASE64: originalEnvironment.encryptionKey,
        MPESA_CALLBACK_URL: originalEnvironment.callbackUrl,
        LOAN_PROCESSING_FEE_POLICY_APPROVED: originalEnvironment.policyApproved,
        LOAN_PROCESSING_FEE_POLICY_VERSION: originalEnvironment.policyVersion,
        LOAN_PROCESSING_FEE_POLICY_DISCLOSURE: originalEnvironment.policyDisclosure,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('reports policy, accounting, and M-Pesa blockers in the authoritative fee quote', async () => {
      delete process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED;
      delete process.env.LOAN_PROCESSING_FEE_POLICY_VERSION;
      delete process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE;
      const prisma = {
        systemSetting: { findUnique: jest.fn(async () => null) },
        ledgerAccount: { findUnique: jest.fn(async () => null) },
      } as unknown as PrismaService;
      const service = new PaymentService(
        prisma,
        { assertConfiguredForPayments: jest.fn(() => {
          throw new ServiceUnavailableException('MPESA_SHORT_CODE must be configured.');
        }) } as unknown as MpesaService,
        {} as LedgerService,
      );

      await expect(service.getLoanProcessingFeeQuote()).resolves.toMatchObject({
        paymentAvailable: false,
        unavailableReasons: expect.arrayContaining([
          'Approved processing-fee policy approval, version, or customer disclosure is not configured.',
          'An active KES M-Pesa clearing asset account is required.',
          'An active KES processing-fee revenue account has not been configured by an administrator.',
          'MPESA_SHORT_CODE must be configured.',
        ]),
      });
    });

    it('creates one KSh 50 application-linked payment without activating or crediting the wallet', async () => {
      process.env.NODE_ENV = 'test';
      process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
      process.env.MPESA_CALLBACK_URL = 'https://api.example.com/api/v1/payments/mpesa/callback';
      process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED = 'true';
      process.env.LOAN_PROCESSING_FEE_POLICY_VERSION = 'approved-v1';
      process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE = 'Refunds follow the approved loan processing-fee policy.';
      const create = jest.fn(async () => ({
        id: 'payment-id',
        internalReference: `LPP${'A'.repeat(32)}`,
      }));
      const updateRequest = jest.fn(async () => ({}));
      const prisma = {
        paymentTransaction: {
          findUnique: jest.fn(async () => null),
          findFirst: jest.fn(async () => null),
          create,
        },
        user: { findUnique: jest.fn(async () => ({ phone: '+254712345678', isActive: true })) },
        loanApplication: {
          findFirst: jest.fn(async () => ({
            id: 'application-id',
            productId: 'product-id',
            requestedPrincipalKes: 3000,
            applicationData: {
              termsAccepted: true,
              termsAcceptedAt: '2026-10-18T20:00:00.000Z',
              productTermsSnapshot: {
                productId: 'product-id',
                termsVersion: 'product-v1',
                requestedPrincipalKes: 3000,
              },
            },
            status: 'DRAFT',
            processingFeePayment: null,
          })),
        },
        systemSetting: { findUnique: jest.fn(async () => ({ value: 'LOAN_PROCESSING_FEES' })) },
        ledgerAccount: { findUnique: jest.fn(async ({ where }: { where: { code: string } }) => ({
          id: where.code,
          isActive: true,
          currency: 'KES',
          accountType: where.code === 'MPESA_CLEARING' ? 'ASSET' : 'REVENUE',
        })) },
        $transaction: jest.fn(async (callback: (tx: never) => Promise<unknown>) => callback({
          loanApplication: { updateMany: jest.fn(async () => ({ count: 1 })) },
          paymentTransaction: { findFirst: jest.fn(async () => null), create },
          idempotencyRecord: { create: jest.fn(async () => ({})) },
        } as never)),
        activationPaymentRequest: { update: updateRequest },
      } as unknown as PrismaService;
      const initiateStkPush = jest.fn(async (_input: {
        amountKes: number;
        phoneNumber: string;
        accountReference: string;
        description: string;
        callbackUrl: string;
      }) => ({
        checkoutRequestId: 'ws_CO_test',
        merchantRequestId: 'mr_test',
      }));
      const postWithinTransaction = jest.fn(async () => undefined);
      const paymentService = new PaymentService(
        prisma,
        {
          assertConfiguredForPayments: jest.fn(),
          initiateStkPush,
        } as unknown as MpesaService,
        { postWithinTransaction } as unknown as LedgerService,
      );

      const response = await paymentService.initiateLoanProcessingFee(
        'user-id',
        Object.assign(new InitiateLoanProcessingFeeDto(), { applicationId: 'application-id', reviewConfirmed: true }),
        'loan-fee-idempotency-0001',
      );

      expect(response).toMatchObject({ status: 'PENDING', amountKes: 50, currency: 'KES' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          amountKes: 50,
          type: PaymentType.LOAN_PROCESSING_FEE,
          loanApplicationId: 'application-id',
          activationRequest: { create: expect.objectContaining({ phoneNumberCiphertext: expect.any(String) }) },
        }),
      }));
      expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-id',
          type: PaymentType.LOAN_PROCESSING_FEE,
        }),
      }));
      expect(initiateStkPush).toHaveBeenCalledWith(expect.objectContaining({
        amountKes: 50,
        phoneNumber: '254712345678',
        description: 'Loan processing fee',
      }));
      const stkInput = initiateStkPush.mock.calls[0][0] as {
        accountReference: string;
        callbackUrl: string;
      };
      expect(stkInput.accountReference).toHaveLength(12);
      const callbackUrl = new URL(stkInput.callbackUrl);
      const callbackToken = callbackUrl.pathname.split('/').at(-1)!;
      expect(callbackUrl.origin).toBe('https://api.example.com');
      expect(callbackUrl.pathname).toBe(`/api/v1/payments/mpesa/callback/${callbackToken}`);
      expect(callbackUrl.search).toBe('');
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          activationRequest: {
            create: expect.objectContaining({ callbackTokenHash: hashToken(callbackToken) }),
          },
        }),
      }));
      expect(updateRequest).toHaveBeenCalledWith(expect.objectContaining({
        where: { paymentTransactionId: 'payment-id' },
        data: { checkoutRequestId: 'ws_CO_test', merchantRequestId: 'mr_test' },
      }));
      expect(postWithinTransaction).not.toHaveBeenCalled();
    });

    it('blocks a second fee payment while another application fee remains unresolved', async () => {
      process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED = 'true';
      process.env.LOAN_PROCESSING_FEE_POLICY_VERSION = 'approved-v1';
      process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE = 'Refunds follow the approved loan processing-fee policy.';
      const prisma = {
        paymentTransaction: {
          findUnique: jest.fn(async () => null),
          findFirst: jest.fn(async () => ({ internalReference: 'LPPUNRESOLVED01' })),
        },
        user: { findUnique: jest.fn(async () => ({ phone: '+254712345678', isActive: true })) },
        loanApplication: {
          findFirst: jest.fn(async () => ({
            id: 'application-id',
            productId: 'product-id',
            requestedPrincipalKes: 3000,
            applicationData: {
              termsAccepted: true,
              termsAcceptedAt: '2026-10-18T20:00:00.000Z',
              productTermsSnapshot: { productId: 'product-id', termsVersion: 'terms-v1', requestedPrincipalKes: 3000 },
            },
            status: 'DRAFT',
            processingFeePayment: null,
          })),
        },
        systemSetting: { findUnique: jest.fn(async () => ({ value: 'LOAN_PROCESSING_FEES' })) },
      } as unknown as PrismaService;
      const initiateStkPush = jest.fn();
      const paymentService = new PaymentService(
        prisma,
        { assertConfiguredForPayments: jest.fn(), initiateStkPush } as unknown as MpesaService,
        {} as LedgerService,
      );

      await expect(paymentService.initiateLoanProcessingFee(
        'user-id',
        Object.assign(new InitiateLoanProcessingFeeDto(), { applicationId: 'application-id', reviewConfirmed: true }),
        'loan-fee-idempotency-0002',
      )).rejects.toThrow('LPPUNRESOLVED01 is unresolved');
      expect(initiateStkPush).not.toHaveBeenCalled();
    });

    it('does not begin fee payment without an explicit reviewed-application confirmation', async () => {
      const paymentService = new PaymentService(
        {} as PrismaService,
        {} as MpesaService,
        {} as LedgerService,
      );
      await expect(paymentService.initiateLoanProcessingFee(
        'user-id',
        Object.assign(new InitiateLoanProcessingFeeDto(), { applicationId: 'application-id', reviewConfirmed: false }),
        'loan-fee-idempotency-0001',
      )).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not initiate a fee payment without an approved refund policy', async () => {
      delete process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED;
      delete process.env.LOAN_PROCESSING_FEE_POLICY_VERSION;
      delete process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE;
      const initiateStkPush = jest.fn();
      const paymentService = new PaymentService(
        { paymentTransaction: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService,
        { initiateStkPush } as unknown as MpesaService,
        {} as LedgerService,
      );

      await expect(paymentService.initiateLoanProcessingFee(
        'user-id',
        Object.assign(new InitiateLoanProcessingFeeDto(), { applicationId: 'application-id', reviewConfirmed: true }),
        'loan-fee-idempotency-0001',
      )).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(initiateStkPush).not.toHaveBeenCalled();
    });
  });

  it.each([
    [0, 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.'],
    [4999, 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.'],
    [999999, 'Safaricom returned a result that does not conclusively resolve this payment. It remains pending; do not submit another payment.'],
  ] as const)('keeps STK Query result %s pending until a verified callback is received', async (resultCode, statusCheckMessage) => {
    const request = {
      id: 'activation-request-id',
      paymentTransactionId: 'payment-id',
      userId: 'user-id',
      checkoutRequestId,
      merchantRequestId,
      phoneNumberCiphertext: encryptSensitiveValue('+254712345678'),
      policySnapshot: {
        approved: true,
        purpose: 'Activation',
        refundability: 'CONDITIONAL_REFUND',
        creditedToWallet: true,
        accountingTreatment: 'Wallet liability',
        customerDisclosure: 'Test activation policy disclosure.',
        termsVersion: 'test-v1',
        creditAccountCode: null,
      },
    };
    const payment = {
      id: 'payment-id',
      internalReference: 'LPA_TEST_REFERENCE',
      userId: 'user-id',
      type: PaymentType.ACTIVATION,
      amountKes: 50,
      currency: 'KES',
      status: 'PENDING' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      failureCode: null,
      receiptReference: null,
      activationRequest: request,
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ activationStatus: 'PENDING' })) },
      paymentTransaction: { findFirst: jest.fn(async () => payment) },
    } as unknown as PrismaService;
    const query = jest.fn(async () => ({
      checkoutRequestId,
      merchantRequestId,
      resultCode,
      resultDescription: 'Provider confirmed payment.',
    }));
    const post = jest.fn(async () => undefined);
    const service = new PaymentService(
      prisma,
      { queryStkStatus: query } as unknown as MpesaService,
      { postWithinTransaction: post } as unknown as LedgerService,
    );

    await expect(service.getCustomerActivationStatus('user-id')).resolves.toMatchObject({
      activationStatus: 'PENDING',
      payment: {
        paymentId: 'payment-id',
        type: 'ACTIVATION',
        purpose: 'Account activation',
        reference: 'LPA_TEST_REFERENCE',
        status: 'PENDING',
        amountKes: 50,
        currency: 'KES',
        providerResult: { code: null, receiptReference: null },
        accountActivated: false,
        statusCheckMessage,
      },
    });
    expect(query).toHaveBeenCalledWith(checkoutRequestId);
    expect(post).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-id', type: PaymentType.ACTIVATION },
      include: { activationRequest: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns no payment for the authenticated customer when no activation record exists', async () => {
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ activationStatus: 'PENDING' })) },
      paymentTransaction: { findFirst: jest.fn(async () => null) },
    } as unknown as PrismaService;
    const service = new PaymentService(
      prisma,
      { queryStkStatus: jest.fn() } as unknown as MpesaService,
      {} as LedgerService,
    );

    await expect(service.getCustomerActivationStatus('current-user')).resolves.toEqual({
      activationStatus: 'PENDING',
      payment: null,
    });
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledWith({
      where: { userId: 'current-user', type: PaymentType.ACTIVATION },
      include: { activationRequest: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns the legacy 4999 payment as pending in the customer payment list', async () => {
    const findMany = jest.fn(async () => [{
      internalReference: 'LPA_LEGACY_4999',
      type: PaymentType.ACTIVATION,
      amountKes: 50,
      currency: 'KES',
      status: 'FAILED',
      failureCode: 'MPESA_RESULT_4999',
      providerReference: 'checkout-id',
      receiptReference: null,
      confirmedAt: null,
      createdAt: new Date(),
    }]);
    const service = new PaymentService({
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    await expect(service.listCustomerPayments('current-user')).resolves.toMatchObject([{
      internalReference: 'LPA_LEGACY_4999',
      status: 'PENDING',
      providerResult: {
        code: 4999,
        message: 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.',
      },
    }]);
  });

  it('returns the persisted pending payment when a status refresh times out', async () => {
    const request = {
      id: 'activation-request-id',
      paymentTransactionId: 'payment-id',
      userId: 'current-user',
      checkoutRequestId,
      merchantRequestId,
    };
    const payment = {
      id: 'payment-id',
      internalReference: 'LPA_REAL_REFERENCE',
      userId: 'current-user',
      type: PaymentType.ACTIVATION,
      amountKes: 50,
      currency: 'KES',
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
      failureCode: null,
      receiptReference: null,
      activationRequest: request,
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ activationStatus: 'PENDING' })) },
      paymentTransaction: { findFirst: jest.fn(async () => payment) },
    } as unknown as PrismaService;
    const query = jest.fn().mockRejectedValue(new ServiceUnavailableException('Provider query failed.'));
    const service = new PaymentService(
      prisma,
      { queryStkStatus: query } as unknown as MpesaService,
      {} as LedgerService,
    );

    await expect(service.getCustomerActivationStatus('current-user')).resolves.toMatchObject({
      activationStatus: 'PENDING',
      payment: {
        paymentId: 'payment-id',
        reference: 'LPA_REAL_REFERENCE',
        status: 'PENDING',
        accountActivated: false,
        statusCheckMessage: 'Payment remains pending. Provider status could not be refreshed; try refreshing again.',
      },
    });
    expect(query).toHaveBeenCalledWith(checkoutRequestId);
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledTimes(2);
  });

  it('exposes the legacy 4999 failure as pending while provider status is still processing', async () => {
    const payment = {
      id: 'payment-id',
      internalReference: 'LPA_LEGACY_PROCESSING',
      userId: 'current-user',
      type: PaymentType.ACTIVATION,
      amountKes: 50,
      currency: 'KES',
      status: 'FAILED',
      createdAt: new Date(),
      updatedAt: new Date(),
      failureCode: 'MPESA_RESULT_4999',
      receiptReference: null,
      activationRequest: {
        id: 'activation-request-id',
        paymentTransactionId: 'payment-id',
        userId: 'current-user',
        checkoutRequestId,
        merchantRequestId,
      },
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ activationStatus: 'PENDING' })) },
      paymentTransaction: { findFirst: jest.fn(async () => payment) },
    } as unknown as PrismaService;
    const query = jest.fn(async () => ({
      checkoutRequestId,
      merchantRequestId,
      resultCode: 4999,
      resultDescription: 'Request is still processing.',
    }));
    const service = new PaymentService(
      prisma,
      { queryStkStatus: query } as unknown as MpesaService,
      {} as LedgerService,
    );

    const result = await service.getCustomerActivationStatus('current-user');

    expect(result.payment).toMatchObject({
      status: 'PENDING',
      providerResult: {
        code: 4999,
        message: 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.',
      },
      statusCheckMessage: 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.',
      accountActivated: false,
    });
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(checkoutRequestId);
  });

  it('explains missing provider identifiers while keeping the payment pending', async () => {
    const payment = {
      id: 'payment-id',
      internalReference: 'LPA_NO_PROVIDER_IDS',
      userId: 'current-user',
      type: PaymentType.ACTIVATION,
      amountKes: 50,
      currency: 'KES',
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      receiptReference: null,
      activationRequest: {
        id: 'activation-request-id',
        paymentTransactionId: 'payment-id',
        userId: 'current-user',
        checkoutRequestId: null,
        merchantRequestId: null,
      },
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ activationStatus: 'PENDING' })) },
      paymentTransaction: { findFirst: jest.fn(async () => payment) },
    } as unknown as PrismaService;
    const query = jest.fn();
    const service = new PaymentService(
      prisma,
      { queryStkStatus: query } as unknown as MpesaService,
      {} as LedgerService,
    );

    await expect(service.getCustomerActivationStatus('current-user')).resolves.toMatchObject({
      activationStatus: 'PENDING',
      payment: {
        status: 'PENDING',
        statusCheckMessage: 'Payment remains pending because provider identifiers are not available for a status check.',
        accountActivated: false,
      },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['FAILED', 'MPESA_RESULT_1', 'Safaricom reported that this payment failed (result 1).'],
    ['CANCELLED', 'MPESA_RESULT_1032', 'The M-Pesa payment was cancelled.'],
    ['EXPIRED', 'MPESA_RESULT_1037', 'The M-Pesa payment expired without confirmation.'],
    ['REVERSED', null, 'This payment was reversed.'],
  ] as const)('returns the truthful customer message for persisted %s payments', async (
    status,
    failureCode,
    message,
  ) => {
    const payment = {
      id: 'payment-id',
      internalReference: 'LPA_PERSISTED_REFERENCE',
      userId: 'current-user',
      type: PaymentType.ACTIVATION,
      amountKes: 50,
      currency: 'KES',
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
      failureCode,
      receiptReference: null,
      activationRequest: null,
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ activationStatus: 'PENDING' })) },
      paymentTransaction: { findFirst: jest.fn(async () => payment) },
    } as unknown as PrismaService;
    const service = new PaymentService(prisma, {} as MpesaService, {} as LedgerService);

    await expect(service.getCustomerActivationStatus('current-user')).resolves.toMatchObject({
      payment: {
        status,
        reference: 'LPA_PERSISTED_REFERENCE',
        providerResult: {
          code: failureCode ? Number(failureCode.slice('MPESA_RESULT_'.length)) : null,
          message,
        },
        accountActivated: false,
      },
    });
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledWith({
      where: { userId: 'current-user', type: PaymentType.ACTIVATION },
      include: { activationRequest: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('accepts a delayed callback and confirms only a queried success matching checkout, merchant, amount, and phone', async () => {
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });

    expect(queryStkStatus).toHaveBeenCalledWith(checkoutRequestId);
    expect(paymentStatus).toBe('CONFIRMED');
    expect(transactionCount).toBe(1);
    expect(postLedger).toHaveBeenCalledTimes(1);
    expect(paymentUpdateData).toMatchObject({ status: 'CONFIRMED', receiptReference: 'TESTRECEIPT1' });
    expect(callbackEventData).toMatchObject({ providerReceiptReference: 'TESTRECEIPT1' });
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-id' },
      data: { activationStatus: 'ACTIVE' },
    }));
  });

  it('keeps a 4999 callback unresolved and later settles its verified success once', async () => {
    providerResultCode = 4999;
    await expect(paymentService.handleMpesaCallback(callbackToken, {
      Body: { stkCallback: {
        CheckoutRequestID: checkoutRequestId,
        MerchantRequestID: merchantRequestId,
        ResultCode: 4999,
        ResultDesc: 'Request is still processing.',
      } },
    })).resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(paymentStatus).toBe('PENDING');
    expect(callbackEventData).toMatchObject({ providerResultCode: '4999', providerReceiptReference: null });
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();

    providerResultCode = 0;
    await paymentService.handleMpesaCallback(callbackToken, successfulCallback());
    await paymentService.handleMpesaCallback(callbackToken, successfulCallback());
    expect(paymentStatus).toBe('CONFIRMED');
    expect(queryStkStatus).toHaveBeenCalledTimes(2);
    expect(postLedger).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy 4999 transactions unchanged after verified success pending an approved recovery procedure', async () => {
    paymentStatus = 'FAILED';
    paymentFailureCode = 'MPESA_RESULT_4999';
    (activationRequestRecord.paymentTransaction as { status: string }).status = 'FAILED';
    (activationRequestRecord.paymentTransaction as { failureCode: string }).failureCode = 'MPESA_RESULT_4999';

    await paymentService.handleMpesaCallback(callbackToken, successfulCallback());

    expect(paymentStatus).toBe('FAILED');
    expect(paymentFailureCode).toBe('MPESA_RESULT_4999');
    expect(transactionCount).toBe(0);
    expect(callbackEventData).toMatchObject({
      providerResultCode: '0',
      providerReceiptReference: 'TESTRECEIPT1',
    });
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('does not settle if a legacy 4999 state races an in-flight successful callback', async () => {
    queryStkStatus.mockImplementationOnce(async () => {
      paymentStatus = 'FAILED';
      paymentFailureCode = 'MPESA_RESULT_4999';
      return {
        checkoutRequestId,
        merchantRequestId,
        resultCode: 0,
        resultDescription: 'test provider result',
      };
    });

    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toBeInstanceOf(ConflictException);

    expect(paymentStatus).toBe('FAILED');
    expect(paymentFailureCode).toBe('MPESA_RESULT_4999');
    expect(transactionCount).toBe(0);
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('recovers missing initiation request IDs from the token-bound callback and provider query atomically', async () => {
    activationRequestRecord.checkoutRequestId = null;
    activationRequestRecord.merchantRequestId = null;

    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });

    expect(queryStkStatus).toHaveBeenCalledWith(checkoutRequestId);
    expect(transactionClient.activationPaymentRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'activation-request-id',
        paymentTransactionId: 'payment-id',
        userId: 'user-id',
        OR: [
          { checkoutRequestId: null, merchantRequestId: null },
          { checkoutRequestId, merchantRequestId },
        ],
      },
      data: { checkoutRequestId, merchantRequestId },
    });
    expect(paymentStatus).toBe('CONFIRMED');
    expect(postLedger).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-id' },
      data: { activationStatus: 'ACTIVE' },
    }));
  });

  it('recovers an uncertain processing-fee initiation only once through a verified callback', async () => {
    activationRequestRecord.checkoutRequestId = null;
    activationRequestRecord.merchantRequestId = null;
    const linkedPayment = activationRequestRecord.paymentTransaction as Record<string, unknown>;
    linkedPayment.type = PaymentType.LOAN_PROCESSING_FEE;
    linkedPayment.loanApplicationId = 'loan-application-id';

    await paymentService.handleMpesaCallback(callbackToken, successfulCallback());
    await paymentService.handleMpesaCallback(callbackToken, successfulCallback());

    expect(paymentStatus).toBe('CONFIRMED');
    expect(paymentUpdateData).toMatchObject({
      status: 'CONFIRMED',
      providerReference: checkoutRequestId,
      receiptReference: 'TESTRECEIPT1',
    });
    expect(queryStkStatus).toHaveBeenCalledTimes(1);
    expect(postLedger).toHaveBeenCalledTimes(1);
    expect(postLedger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      idempotencyKey: 'loan-processing-fee:payment-id',
      transactionType: 'LOAN_PROCESSING_FEE',
      paymentId: 'payment-id',
    }));
    expect(transactionClient.loanApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'loan-application-id', userId: 'user-id', status: 'PROCESSING_PAYMENT_PENDING' },
      data: { status: 'SUBMITTED', submittedAt: expect.any(Date) },
    }));
  });

  it('does not bind recovered identifiers when provider status disagrees with the callback', async () => {
    activationRequestRecord.checkoutRequestId = null;
    activationRequestRecord.merchantRequestId = null;
    providerCheckoutRequestId = 'different-checkout';

    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(queryStkStatus).toHaveBeenCalledWith(checkoutRequestId);
    expect(transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('rejects malformed, unknown, and mismatched callback identifiers without crediting', async () => {
    await expect(paymentService.handleMpesaCallback(callbackToken, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(paymentService.handleMpesaCallback('unknown-token', successfulCallback()))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback({
      CheckoutRequestID: 'different-checkout',
    }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback({
      MerchantRequestID: 'different-merchant',
    }))).rejects.toBeInstanceOf(ForbiddenException);

    expect(queryStkStatus).not.toHaveBeenCalled();
    expect(postLedger).not.toHaveBeenCalled();
  });

  it.each([
    ['ownership', 'userId', 'different-user'],
    ['currency', 'currency', 'USD'],
  ] as const)('rejects a successful callback with mismatched payment %s', async (_field, field, value) => {
    const linkedPayment = activationRequestRecord.paymentTransaction as Record<string, string>;
    linkedPayment[field] = value;

    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toBeInstanceOf(ForbiddenException);

    expect(queryStkStatus).not.toHaveBeenCalled();
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['string amount', [{ Name: 'Amount', Value: '50' }, { Name: 'MpesaReceiptNumber', Value: 'TESTRECEIPT1' }, { Name: 'PhoneNumber', Value: 254712345678 }]],
    ['wrong amount', [{ Name: 'Amount', Value: 49 }, { Name: 'MpesaReceiptNumber', Value: 'TESTRECEIPT1' }, { Name: 'PhoneNumber', Value: 254712345678 }]],
    ['wrong phone', [{ Name: 'Amount', Value: 50 }, { Name: 'MpesaReceiptNumber', Value: 'TESTRECEIPT1' }, { Name: 'PhoneNumber', Value: 254112345678 }]],
    ['invalid receipt', [{ Name: 'Amount', Value: 50 }, { Name: 'MpesaReceiptNumber', Value: 'NOT A RECEIPT' }, { Name: 'PhoneNumber', Value: 254712345678 }]],
    ['missing receipt', [{ Name: 'Amount', Value: 50 }, { Name: 'PhoneNumber', Value: 254712345678 }]],
  ])('does not credit a success callback with %s', async (_caseName, items) => {
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback({
      CallbackMetadata: { Item: items },
    }))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it.each([
    1032,
    1037,
    1,
  ])('keeps provider result %s unresolved until its semantics are verified', async (resultCode) => {
    providerResultCode = resultCode;
    await expect(paymentService.handleMpesaCallback(callbackToken, {
      Body: {
        stkCallback: {
          CheckoutRequestID: checkoutRequestId,
          MerchantRequestID: merchantRequestId,
          ResultCode: resultCode,
          ResultDesc: 'Request cancelled by user.',
        },
      },
    })).resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(paymentStatus).toBe('PENDING');
    expect(callbackEventData).toMatchObject({ providerResultCode: String(resultCode), providerReceiptReference: null });
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('records an unknown callback result without resolving or crediting the payment', async () => {
    providerResultCode = 999999;
    await paymentService.handleMpesaCallback(callbackToken, {
      Body: { stkCallback: {
        CheckoutRequestID: checkoutRequestId,
        MerchantRequestID: merchantRequestId,
        ResultCode: 999999,
        ResultDesc: 'Unrecognized provider result.',
      } },
    });

    expect(paymentStatus).toBe('PENDING');
    expect(callbackEventData).toMatchObject({ providerResultCode: '999999', providerReceiptReference: null });
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('does not confirm based only on a successful callback when the provider query disagrees', async () => {
    providerResultCode = 1032;
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('does not repeat financial effects for duplicate callbacks', async () => {
    const callback = successfulCallback();
    await paymentService.handleMpesaCallback(callbackToken, callback);
    await paymentService.handleMpesaCallback(callbackToken, callback);

    expect(queryStkStatus).toHaveBeenCalledTimes(1);
    expect(transactionCount).toBe(1);
    expect(postLedger).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves callbacks retryable when the database transaction fails', async () => {
    failNextTransaction = true;
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toThrow('test database unavailable');
    expect(paymentStatus).toBe('PENDING');
    expect(postLedger).not.toHaveBeenCalled();

    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(paymentStatus).toBe('CONFIRMED');
    expect(postLedger).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed callback result fields before querying or changing payment state', async () => {
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback({
      ResultCode: '0',
    }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback({
      CallbackMetadata: { Item: [{ Name: 'Amount', Value: { amount: 50 } }] },
    }))).rejects.toBeInstanceOf(BadRequestException);
    expect(queryStkStatus).not.toHaveBeenCalled();
    expect(paymentStatus).toBe('PENDING');
  });
});

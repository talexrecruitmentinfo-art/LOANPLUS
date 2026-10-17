import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
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

describe('M-Pesa payment callback reconciliation', () => {
  const originalEncryptionKey = process.env.ID_ENCRYPTION_KEY_BASE64;
  const callbackToken = 'unit-test-callback-secret';
  const checkoutRequestId = 'ws_CO_test';
  const merchantRequestId = 'mr_test';
  let paymentStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
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
        amountKes: 50,
        currency: 'KES',
        status: paymentStatus,
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
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> & { status: 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' } }) => {
          if (paymentStatus !== 'PENDING') return { count: 0 };
          paymentUpdateData = data;
          paymentStatus = data.status;
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
          return null;
        }),
        create: jest.fn(async () => ({
          id: 'wallet-account',
          userId: 'user-id',
          isActive: true,
          currency: 'KES',
          accountType: 'LIABILITY',
        })),
      },
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

  describe('activation payment disclosure availability', () => {
    const originalCallbackUrl = process.env.MPESA_CALLBACK_URL;
    const policy = {
      approved: true,
      purpose: 'Account activation only',
      refundability: 'CONDITIONAL_REFUND',
      creditedToWallet: true,
      accountingTreatment: 'Customer wallet liability',
      customerDisclosure: 'Payment activates the account only.',
      termsVersion: 'activation-v1',
      creditAccountCode: null,
    };

    function createService(
      amount: number | null,
      configuredPolicy: typeof policy | null,
      destination: {
        businessShortCode: string;
        tillNumber: string | null;
        transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
      } | null,
    ) {
      const prisma = {
        systemSetting: {
          findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
            where.key === 'activation.amount_kes'
              ? amount === null ? null : { value: amount }
              : configuredPolicy === null ? null : { value: configuredPolicy }),
        },
      } as unknown as PrismaService;
      const service = new PaymentService(
        prisma,
        { getCustomerPaymentDestination: jest.fn(() => destination) } as unknown as MpesaService,
        {} as LedgerService,
      );
      return service;
    }

    afterEach(() => {
      if (originalCallbackUrl === undefined) delete process.env.MPESA_CALLBACK_URL;
      else process.env.MPESA_CALLBACK_URL = originalCallbackUrl;
    });

    it.each([
      ['missing policy', 50, null],
      ['unapproved policy', 50, { ...policy, approved: false }],
      ['draft policy', 50, { ...policy, termsVersion: 'draft-v1' }],
      ['wrong amount', 49, policy],
    ] as const)('keeps payment unavailable for %s', async (_name, amount, configuredPolicy) => {
      const service = createService(amount, configuredPolicy, null);
      await expect(service.getActivationTerms()).resolves.toMatchObject({
        available: false,
        amountKes: 50,
        currency: 'KES',
        terms: null,
      });
    });

    it('shows approved terms but keeps payment unavailable without an M-Pesa destination', async () => {
      const service = createService(50, policy, null);
      await expect(service.getActivationTerms()).resolves.toMatchObject({
        available: false,
        availabilityReason: null,
        terms: { termsVersion: 'activation-v1', customerDisclosure: policy.customerDisclosure },
      });
    });

    it('surfaces a safe, actionable provider configuration reason to the activation page', async () => {
      const prisma = {
        systemSetting: {
          findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
            where.key === 'activation.amount_kes' ? { value: 50 } : { value: policy }),
        },
      } as unknown as PrismaService;
      const service = new PaymentService(
        prisma,
        {
          getCustomerPaymentDestination: jest.fn(() => {
            throw new InternalServerErrorException('MPESA_CONSUMER_KEY must be configured in the API environment.');
          }),
        } as unknown as MpesaService,
        {} as LedgerService,
      );

      await expect(service.getActivationTerms()).resolves.toMatchObject({
        available: false,
        availabilityReason: 'MPESA_CONSUMER_KEY must be configured in the API environment.',
        terms: { termsVersion: 'activation-v1' },
      });
    });

    it('reports the live-payment gate after validating the production destination settings', async () => {
      const prisma = {
        systemSetting: {
          findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
            where.key === 'activation.amount_kes' ? { value: 50 } : { value: policy }),
        },
      } as unknown as PrismaService;
      const service = new PaymentService(
        prisma,
        {
          getCustomerPaymentDestination: jest.fn(() => {
            throw new ServiceUnavailableException(
              'Production M-Pesa payments are disabled. Set MPESA_LIVE_ENABLED=true only after production configuration and deployment verification.',
            );
          }),
        } as unknown as MpesaService,
        {} as LedgerService,
      );

      await expect(service.getActivationTerms()).resolves.toMatchObject({
        available: false,
        availabilityReason: expect.stringContaining('MPESA_LIVE_ENABLED=true'),
        amountKes: 50,
        currency: 'KES',
        terms: { termsVersion: 'activation-v1' },
      });
    });

    it('does not expose configured destination details when approved terms are available', async () => {
      process.env.MPESA_CALLBACK_URL = 'https://api.example.com/api/v1/payments/mpesa/callback';
      const service = createService(50, policy, {
        businessShortCode: '174379',
        tillNumber: null,
        transactionType: 'CustomerPayBillOnline',
      });
      const response = await service.getActivationTerms();
      expect(response).toMatchObject({
        available: true,
        amountKes: 50,
        currency: 'KES',
        terms: { termsVersion: 'activation-v1' },
      });
      expect(response).not.toHaveProperty('destination');
      expect(JSON.stringify(response)).not.toMatch(/174379|Till|Paybill/i);
    });

    it('keeps the confirmed Buy Goods shortcode and Till internal', async () => {
      process.env.MPESA_CALLBACK_URL = 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback';
      const service = createService(50, policy, {
        businessShortCode: '5526990',
        tillNumber: '3400188',
        transactionType: 'CustomerBuyGoodsOnline',
      });
      const response = await service.getActivationTerms();
      expect(response.available).toBe(true);
      expect(response).not.toHaveProperty('destination');
      expect(JSON.stringify(response)).not.toMatch(/5526990|3400188|Till/i);
    });
  });

  it('does not allow a later success to credit a payment already failed or cancelled', async () => {
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
    expect(paymentStatus).toBe('CANCELLED');

    providerResultCode = 0;
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toThrow('Payment has already been reconciled.');
    expect(paymentStatus).toBe('CANCELLED');
    expect(postLedger).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
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

  describe('activation payment initiation', () => {
    const originalEnvironment = {
      nodeEnv: process.env.NODE_ENV,
      encryptionKey: process.env.ID_ENCRYPTION_KEY_BASE64,
      callbackUrl: process.env.MPESA_CALLBACK_URL,
    };

    afterEach(() => {
      for (const [name, value] of Object.entries({
        NODE_ENV: originalEnvironment.nodeEnv,
        ID_ENCRYPTION_KEY_BASE64: originalEnvironment.encryptionKey,
        MPESA_CALLBACK_URL: originalEnvironment.callbackUrl,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('keeps the payment pending after Safaricom accepts the STK request', async () => {
      process.env.NODE_ENV = 'test';
      process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
      process.env.MPESA_CALLBACK_URL = 'https://api.example.com/api/v1/payments/mpesa/callback';

      const create = jest.fn(async () => ({
        id: 'payment-id',
        internalReference: `LPA${'A'.repeat(32)}`,
      }));
      const updateRequest = jest.fn(async () => ({}));
      const prisma = {
        paymentTransaction: {
          findUnique: jest.fn(async () => null),
          findFirst: jest.fn(async () => null),
          create,
        },
        user: {
          findUnique: jest.fn(async () => ({
            phone: '+254712345678',
            isActive: true,
            activationStatus: 'PENDING',
          })),
        },
        systemSetting: {
          findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
            where.key === 'activation.amount_kes'
              ? { value: 50 }
              : { value: {
                  approved: true,
                  purpose: 'Activation',
                  refundability: 'CONDITIONAL_REFUND',
                  creditedToWallet: true,
                  accountingTreatment: 'Wallet liability',
                  customerDisclosure: 'Test activation disclosure.',
                  termsVersion: 'test-v1',
                  creditAccountCode: null,
                } }),
        },
        $transaction: jest.fn(async (callback: (tx: never) => Promise<unknown>) => callback({
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

      await expect(paymentService.initiateActivationPayment(
        'user-id',
        { phoneNumber: '0712345678', termsAccepted: true, termsVersion: 'stale-v0' },
        'activation-stale-policy-001',
      )).rejects.toBeInstanceOf(ConflictException);
      expect(create).not.toHaveBeenCalled();

      const response = await paymentService.initiateActivationPayment(
        'user-id',
        { phoneNumber: '0712345678', termsAccepted: true, termsVersion: 'test-v1' },
        'activation-test-idempotency-001',
      );

      expect(response).toMatchObject({ status: 'PENDING', amountKes: 50, currency: 'KES' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          amountKes: 50,
          activationRequest: { create: expect.objectContaining({
            termsAcceptedVersion: 'test-v1',
            termsAcceptedAt: expect.any(Date),
          }) },
        }),
        include: { activationRequest: true },
      }));
      expect(initiateStkPush).toHaveBeenCalledWith(expect.objectContaining({
        amountKes: 50,
        phoneNumber: '254712345678',
        description: 'Activation',
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

      updateRequest.mockRejectedValueOnce(new Error('Provider request identifiers could not be persisted.'));
      await expect(paymentService.initiateActivationPayment(
        'user-id',
        { phoneNumber: '0712345678', termsAccepted: true, termsVersion: 'test-v1' },
        'activation-test-idempotency-002',
      )).rejects.toThrow('Provider request identifiers could not be persisted.');
      expect(create).toHaveBeenCalledTimes(2);
      expect(initiateStkPush).toHaveBeenCalledTimes(2);
      expect(create.mock.invocationCallOrder[1]).toBeLessThan(initiateStkPush.mock.invocationCallOrder[1]);
      expect(postWithinTransaction).not.toHaveBeenCalled();
    });
  });

  it('keeps a query-only success pending until a verified callback is received', async () => {
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
      resultCode: 0,
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
    [1032, 'CANCELLED'],
    [1037, 'EXPIRED'],
    [1, 'FAILED'],
  ] as const)('records provider result %s as %s without ledger effects', async (resultCode, expectedStatus) => {
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
    expect(paymentStatus).toBe(expectedStatus);
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

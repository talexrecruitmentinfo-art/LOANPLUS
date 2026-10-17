import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  let paymentStatus: 'PENDING' | 'CONFIRMED' | 'FAILED';
  let events: Set<string>;
  let transactionCount: number;
  let failNextTransaction: boolean;
  let providerResultCode: number;
  let providerCheckoutRequestId: string;
  let providerMerchantRequestId: string;
  let nextTransactionError: Error | null;
  let paymentUpdateData: Record<string, unknown> | undefined;
  let callbackEventData: Record<string, unknown> | undefined;
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
        amountKes: 50,
        currency: 'KES',
        status: paymentStatus,
      },
    };
    transactionClient = {
      paymentCallbackEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> & { payloadHash: string } }) => {
          callbackEventData = data;
          events.add(data.payloadHash);
          return {};
        }),
      },
      paymentTransaction: {
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> & { status: 'CONFIRMED' | 'FAILED' } }) => {
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
    expect(paymentStatus).toBe('FAILED');

    providerResultCode = 0;
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .rejects.toThrow('Payment has already been reconciled.');
    expect(paymentStatus).toBe('FAILED');
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
      process.env.MPESA_CALLBACK_URL = 'https://api.example.invalid/api/v1/payments/mpesa/callback';

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

      const response = await paymentService.initiateActivationPayment(
        'user-id',
        { phoneNumber: '0712345678', termsAccepted: true },
        'activation-test-idempotency-001',
      );

      expect(response).toMatchObject({ status: 'PENDING', amountKes: 50, currency: 'KES' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amountKes: 50 }),
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
      expect(stkInput.callbackUrl).toMatch(/^https:\/\/api\.example\.invalid\/api\/v1\/payments\/mpesa\/callback\//);
      expect(updateRequest).toHaveBeenCalledWith(expect.objectContaining({
        where: { paymentTransactionId: 'payment-id' },
        data: { checkoutRequestId: 'ws_CO_test', merchantRequestId: 'mr_test' },
      }));
      expect(postWithinTransaction).not.toHaveBeenCalled();
    });
  });

  it('accepts a delayed callback and confirms only a queried success matching checkout, merchant, amount, and phone', async () => {
    await expect(paymentService.handleMpesaCallback(callbackToken, successfulCallback()))
      .resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });

    expect(queryStkStatus).toHaveBeenCalledWith(checkoutRequestId);
    expect(paymentStatus).toBe('CONFIRMED');
    expect(transactionCount).toBe(1);
    expect(postLedger).toHaveBeenCalledTimes(1);
    expect(paymentUpdateData).toMatchObject({ status: 'CONFIRMED', receiptReference: null });
    expect(callbackEventData).toMatchObject({ providerReceiptReference: null });
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-id' },
      data: { activationStatus: 'ACTIVE' },
    }));
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

  it('records a failed provider result without creating ledger effects', async () => {
    providerResultCode = 1032;
    await expect(paymentService.handleMpesaCallback(callbackToken, {
      Body: {
        stkCallback: {
          CheckoutRequestID: checkoutRequestId,
          MerchantRequestID: merchantRequestId,
          ResultCode: 1032,
          ResultDesc: 'Request cancelled by user.',
        },
      },
    })).resolves.toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(paymentStatus).toBe('FAILED');
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

import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PaymentStatus, PaymentType } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from '../ledger/ledger.service';
import { MpesaService, StkPushInitiationError } from './mpesa.service';
import { WalletDepositDto } from './payment.dto';
import { PaymentService } from './payment.service';
import {
  CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
  MPESA_CLEARING_ACCOUNT_CODE,
  WALLET_DEPOSIT_SETTING_KEY,
} from './wallet-deposit.config';

describe('M-Pesa wallet deposit initiation', () => {
  const environment = {
    encryptionKey: process.env.ID_ENCRYPTION_KEY_BASE64,
    callbackUrl: process.env.MPESA_CALLBACK_URL,
  };
  let payment: Record<string, unknown> | null;
  let unresolvedPayment: Record<string, unknown> | null;
  let stkRequest: jest.Mock;
  let service: PaymentService;
  let activationRequestUpdate: jest.Mock;

  beforeEach(() => {
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    process.env.MPESA_CALLBACK_URL = 'https://api.example.test/api/v1/payments/mpesa/callback';
    payment = null;
    unresolvedPayment = null;
    activationRequestUpdate = jest.fn(async () => ({ count: 1 }));
    stkRequest = jest.fn(async () => ({
      checkoutRequestId: 'checkout-test',
      merchantRequestId: 'merchant-test',
    }));
    const transactionClient = {
      paymentTransaction: {
        findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
          payment?.idempotencyKey === where.idempotencyKey ? payment : null),
        findFirst: jest.fn(async () => unresolvedPayment),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          payment = {
            id: 'wallet-payment-id',
            internalReference: 'LPD000000000000000000000000000001',
            userId: 'customer-id',
            status: 'PENDING',
            ...data,
          };
          unresolvedPayment = payment;
          return { id: payment.id, internalReference: payment.internalReference };
        }),
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (payment) payment = { ...payment, ...data };
          return { count: 1 };
        }),
      },
      activationPaymentRequest: { updateMany: activationRequestUpdate },
    };
    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
          payment?.idempotencyKey === where.idempotencyKey ? payment : null),
        findFirst: jest.fn(async () => unresolvedPayment),
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (payment) payment = { ...payment, ...data };
          return { count: 1 };
        }),
      },
      user: { findUnique: jest.fn(async () => ({ isActive: true })) },
      ledgerAccount: {
        findUnique: jest.fn(async ({ where }: { where: { code: string } }) => ({
          id: where.code,
          isActive: true,
          currency: 'KES',
          accountType: where.code === MPESA_CLEARING_ACCOUNT_CODE ? 'ASSET' : 'LIABILITY',
        })),
      },
      systemSetting: {
        findUnique: jest.fn(async ({ where }: { where: { key: string } }) => where.key === WALLET_DEPOSIT_SETTING_KEY
          ? { value: {
            minimumAmountKes: 100,
            maximumAmountKes: 20000,
            productApproved: true,
            approvalReference: 'TEST-APPROVAL-REFERENCE',
            customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
            mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
          } }
          : null),
      },
      $transaction: (() => {
        let transactionQueue = Promise.resolve();
        return jest.fn((callback: (tx: typeof transactionClient) => Promise<unknown>) => {
          const result = transactionQueue.then(() => callback(transactionClient));
          transactionQueue = result.then(() => undefined, () => undefined);
          return result;
        });
      })(),
    } as unknown as PrismaService;
    const mpesa = {
      assertConfiguredForPayments: jest.fn(),
      initiateStkPush: stkRequest,
    } as unknown as MpesaService;
    service = new PaymentService(prisma, mpesa, {} as LedgerService);
  });

  afterEach(() => {
    if (environment.encryptionKey === undefined) delete process.env.ID_ENCRYPTION_KEY_BASE64;
    else process.env.ID_ENCRYPTION_KEY_BASE64 = environment.encryptionKey;
    if (environment.callbackUrl === undefined) delete process.env.MPESA_CALLBACK_URL;
    else process.env.MPESA_CALLBACK_URL = environment.callbackUrl;
  });

  const depositRequest = () => Object.assign(new WalletDepositDto(), {
    amountKes: 500,
    mpesaPhoneNumber: '+254712345678',
  });

  it('persists a distinct wallet deposit before issuing one STK request', async () => {
    const result = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-001');

    expect(result).toMatchObject({ status: 'PENDING', amountKes: 500, currency: 'KES' });
    expect(payment).toMatchObject({
      type: PaymentType.WALLET_DEPOSIT,
      amountKes: 500,
      currency: 'KES',
      status: 'PENDING',
      initiationPhase: 'PROVIDER_ACCEPTED',
    });
    expect(stkRequest).toHaveBeenCalledTimes(1);
    expect(stkRequest).toHaveBeenCalledWith(expect.objectContaining({
      amountKes: 500,
      phoneNumber: '254712345678',
      accountReference: (payment?.internalReference as string).slice(-12),
      description: 'Wallet topup',
      callbackUrl: expect.stringMatching(/^https:\/\/api\.example\.test\/api\/v1\/payments\/mpesa\/callback\//),
    }), expect.any(Function));
    expect(activationRequestUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { checkoutRequestId: 'checkout-test', merchantRequestId: 'merchant-test' },
    }));
  });

  it('replays the same idempotency key without creating another STK request', async () => {
    const first = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-replay');
    const replay = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-replay');

    expect(replay).toMatchObject({ reference: first.reference, status: 'PENDING' });
    expect(stkRequest).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent attempts and issues only one STK request while a payment is pending', async () => {
    const results = await Promise.all([
      service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-concurrent-1'),
      service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-concurrent-2'),
    ]);

    expect(results[0].reference).toBe(results[1].reference);
    expect(payment).toMatchObject({ status: 'PENDING' });
    expect(unresolvedPayment).toMatchObject({ status: 'PENDING', internalReference: results[0].reference });
    expect(stkRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending deposit ineligible despite the separate wallet-product approval reference', async () => {
    unresolvedPayment = {
      id: 'existing-payment',
      internalReference: 'LPDF2A72DD1F0B7231E1B2FF524CA050A7D',
      amountKes: 65,
      currency: 'KES',
      status: 'PENDING',
      createdAt: new Date(),
    };
    const eligibility = await service.getWalletDepositEligibility('customer-id');

    expect(eligibility).toMatchObject({
      canInitiateNewDeposit: false,
      pendingDeposit: {
        reference: 'LPDF2A72DD1F0B7231E1B2FF524CA050A7D',
        amountKes: 65,
        status: 'PENDING',
      },
    });
    expect(unresolvedPayment).toMatchObject({ status: 'PENDING' });
  });

  it('keeps a legacy 4999 deposit ineligible and exposes it as pending without rewriting it', async () => {
    unresolvedPayment = {
      id: 'legacy-unresolved-payment',
      internalReference: 'LPD_LEGACY_4999',
      amountKes: 65,
      currency: 'KES',
      status: 'FAILED',
      failureCode: 'MPESA_RESULT_4999',
      receiptReference: null,
      createdAt: new Date(),
    };

    await expect(service.getWalletDepositEligibility('customer-id')).resolves.toMatchObject({
      canInitiateNewDeposit: false,
      pendingDeposit: { reference: 'LPD_LEGACY_4999', status: 'PENDING' },
    });
    const initiation = await service.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-legacy-4999',
    );
    expect(initiation).toMatchObject({ reference: 'LPD_LEGACY_4999', status: 'PENDING' });
    expect(unresolvedPayment).toMatchObject({ status: 'FAILED', failureCode: 'MPESA_RESULT_4999' });
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('keeps failed deposits with missing or unknown evidence unresolved without rewriting them', async () => {
    unresolvedPayment = {
      id: 'legacy-unknown-payment',
      internalReference: 'LPD_LEGACY_UNKNOWN',
      amountKes: 65,
      currency: 'KES',
      status: 'FAILED',
      failureCode: null,
      receiptReference: null,
      createdAt: new Date(),
    };

    await expect(service.getWalletDepositEligibility('customer-id')).resolves.toMatchObject({
      canInitiateNewDeposit: false,
      pendingDeposit: { reference: 'LPD_LEGACY_UNKNOWN', status: 'PENDING' },
    });
    const initiation = await service.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-unknown-outcome',
    );
    expect(initiation).toMatchObject({ reference: 'LPD_LEGACY_UNKNOWN', status: 'PENDING' });
    expect(unresolvedPayment).toMatchObject({ status: 'FAILED', failureCode: null });
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('encodes only explicit definitive provider failures as retryable in backend eligibility', async () => {
    const findFirst = jest.fn(async (_args: { where: object }) => null);
    const eligibilityService = new PaymentService({
      paymentTransaction: { findFirst },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    await expect(eligibilityService.getWalletDepositEligibility('customer-id')).resolves.toMatchObject({
      canInitiateNewDeposit: true,
      pendingDeposit: null,
    });
    expect(JSON.stringify(findFirst.mock.calls[0][0])).toContain(
      '"notIn":["MPESA_OAUTH_FAILED","MPESA_CONFIGURATION_FAILED","MPESA_STK_REJECTED"]',
    );
  });

  it('projects a legacy 4999 deposit as pending in payment status and history without exposing failure internals', async () => {
    const legacyPayment = {
      internalReference: 'LPD_LEGACY_4999',
      type: PaymentType.WALLET_DEPOSIT,
      amountKes: 65,
      currency: 'KES',
      status: PaymentStatus.FAILED,
      failureCode: 'MPESA_RESULT_4999',
      receiptReference: null,
      confirmedAt: null,
      createdAt: new Date(),
    };
    const findFirst = jest.fn(async () => legacyPayment);
    const findMany = jest.fn(async () => [legacyPayment]);
    const legacyService = new PaymentService({
      paymentTransaction: { findFirst, findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    await expect(legacyService.getWalletDepositStatus('customer-id', 'LPD_LEGACY_4999'))
      .resolves.toMatchObject({ status: 'PENDING', receiptReference: null });
    await expect(legacyService.listCustomerPayments('customer-id')).resolves.toMatchObject([{
      internalReference: 'LPD_LEGACY_4999',
      status: 'PENDING',
      unresolved: true,
    }]);
  });

  it('authorizes a new attempt only after backend records no pending deposit', async () => {
    unresolvedPayment = null;

    await expect(service.getWalletDepositEligibility('customer-id')).resolves.toEqual({
      canInitiateNewDeposit: true,
      pendingDeposit: null,
      message: null,
    });
  });

  it.each([0, 99, 20001, 10.5])('rejects invalid wallet deposit amount %s before M-Pesa initiation', async (amountKes) => {
    await expect(service.initiateWalletDeposit('customer-id', {
      ...depositRequest(),
      amountKes,
    }, 'wallet-deposit-key-invalid')).rejects.toBeInstanceOf(BadRequestException);
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('rejects a customer without an active account before M-Pesa initiation', async () => {
    const inactivePrisma = {
      paymentTransaction: { findUnique: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => ({ isActive: false })) },
      ledgerAccount: { findUnique: jest.fn(async () => ({ isActive: true, currency: 'KES', accountType: 'ASSET' })) },
      systemSetting: {
        findUnique: jest.fn(async () => ({ value: {
          minimumAmountKes: 100,
          maximumAmountKes: 20000,
          productApproved: true,
          approvalReference: 'TEST-APPROVAL-REFERENCE',
          customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
          mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
        } })),
      },
    } as unknown as PrismaService;
    const inactiveService = new PaymentService(
      inactivePrisma,
      { assertConfiguredForPayments: jest.fn(), initiateStkPush: stkRequest } as unknown as MpesaService,
      {} as LedgerService,
    );
    await expect(inactiveService.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-inactive'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it.each([100, 20000])('allows an authorized boundary amount of %s KES', async (amountKes) => {
    await service.initiateWalletDeposit('customer-id', {
      ...depositRequest(),
      amountKes,
    }, `wallet-deposit-boundary-${amountKes}`);
    expect(stkRequest).toHaveBeenCalledTimes(1);
    expect(stkRequest).toHaveBeenCalledWith(expect.objectContaining({ amountKes }), expect.any(Function));
  });

  it.each([
    [99, 'outside the configured wallet limits'],
    [20001, 'outside the configured wallet limits'],
    [2_147_483_648, 'positive whole-KSh'],
  ])('rejects amount-specific quotes outside approved limits (%s KES)', async (amountKes, message) => {
    await expect(service.getWalletDepositQuote(amountKes)).rejects.toThrow(
      message,
    );
  });

  it('accepts an amount-specific quote at both approved boundaries', async () => {
    await expect(service.getWalletDepositQuote(100)).resolves.toMatchObject({
      currency: 'KES',
      minimumAmountKes: 100,
      maximumAmountKes: 20000,
      depositAvailable: true,
    });
    await expect(service.getWalletDepositQuote(20000)).resolves.toMatchObject({
      depositAvailable: true,
    });
  });

  it('rejects initiation when saved limits or production approval are absent', async () => {
    const configurationMissing = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => null) },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);
    await expect(configurationMissing.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-missing-config',
    )).rejects.toThrow('Approved wallet-deposit amount limits are not configured.');

    const approvalMissing = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => ({ value: {
        minimumAmountKes: 100,
        maximumAmountKes: 20000,
        productApproved: false,
        customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
        mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      } })) },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);
    await expect(approvalMissing.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-unapproved-product',
    )).rejects.toThrow('confirmed for customer wallet deposits');
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('does not issue another STK request while a previous deposit remains unresolved', async () => {
    unresolvedPayment = {
      internalReference: 'LPD000000000000000000000000000009',
      amountKes: 900,
      currency: 'KES',
      status: 'PENDING',
    };
    const result = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-002');
    expect(result).toMatchObject({ reference: unresolvedPayment.internalReference, status: 'PENDING' });
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('keeps uncertain STK outcomes pending and blocks a replacement request', async () => {
    stkRequest.mockRejectedValueOnce(new StkPushInitiationError('STK_REQUEST'));
    const result = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-003');
    expect(result).toMatchObject({ status: 'PENDING' });
    expect(payment).toMatchObject({
      status: 'PENDING',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      initiationPhase: 'STK_REQUEST_OUTCOME_UNCERTAIN',
    });
    unresolvedPayment = payment;
    const retry = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-004');
    expect(retry).toMatchObject({ status: 'PENDING' });
    expect(stkRequest).toHaveBeenCalledTimes(1);
  });

  it('marks an explicit Safaricom STK rejection failed and retains only safe provider diagnostics', async () => {
    const logger = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    stkRequest.mockRejectedValueOnce(new StkPushInitiationError(
      'STK_REJECTED',
      '1',
      200,
      'Invalid phone 254712345678.',
    ));

    try {
      const result = await service.initiateWalletDeposit(
        'customer-id',
        depositRequest(),
        'wallet-deposit-provider-rejection',
      );

      expect(result).toMatchObject({
        status: 'FAILED',
        message: 'The M-Pesa request was rejected before a payment could be confirmed. Review the payment details before retrying.',
      });
      expect(payment).toMatchObject({
        status: 'FAILED',
        failureCode: 'MPESA_STK_REJECTED',
        initiationPhase: 'STK_REJECTED',
      });
      const diagnostic = logger.mock.calls
        .map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
        .find((entry) => entry.event === 'wallet_deposit_initiation_failed');
      expect(diagnostic).toMatchObject({
        paymentReference: payment?.internalReference,
        failureStage: 'STK_REJECTED',
        providerHttpStatus: 200,
        providerResponseCode: '1',
        providerDescription: 'Invalid phone [REDACTED].',
      });
      expect(JSON.stringify(diagnostic)).not.toContain('254712345678');
    } finally {
      logger.mockRestore();
    }
  });

  it('fails authentication errors before STK without leaving a false pending deposit', async () => {
    stkRequest.mockRejectedValueOnce(new StkPushInitiationError(
      'OAUTH',
      'unauthorized',
      401,
      'Invalid credentials.',
      'HTTP',
    ));

    const result = await service.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-oauth-failure',
    );

    expect(result).toMatchObject({ status: 'FAILED' });
    expect(payment).toMatchObject({
      status: 'FAILED',
      failureCode: 'MPESA_OAUTH_FAILED',
      initiationPhase: 'OAUTH',
    });
  });

  it('keeps STK HTTP errors and malformed responses pending because acceptance is ambiguous', async () => {
    stkRequest.mockRejectedValueOnce(new StkPushInitiationError(
      'STK_REQUEST',
      'temporarily_unavailable',
      503,
      'Service unavailable.',
      'HTTP',
    ));
    const result = await service.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-http-uncertain',
    );
    expect(result).toMatchObject({ status: 'PENDING' });
    expect(payment).toMatchObject({
      status: 'PENDING',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      initiationPhase: 'STK_REQUEST_OUTCOME_UNCERTAIN',
    });

    payment = null;
    unresolvedPayment = null;
    stkRequest.mockRejectedValueOnce(new StkPushInitiationError('STK_RESPONSE', undefined, 200));
    const malformed = await service.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-malformed-response',
    );
    expect(malformed).toMatchObject({ status: 'PENDING' });
    expect(payment).toMatchObject({
      status: 'PENDING',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      initiationPhase: 'STK_RESPONSE_UNCERTAIN',
    });
  });

  it('shows customers the failure stage without exposing internal failure codes', async () => {
    const findMany = jest.fn(async () => [
      {
        internalReference: 'LPD_LOCAL',
        type: PaymentType.WALLET_DEPOSIT,
        amountKes: 500,
        currency: 'KES',
        status: PaymentStatus.FAILED,
        failureCode: 'MPESA_PREFLIGHT_INVALID_DESCRIPTION',
        initiationPhase: 'LOCAL_PREFLIGHT',
        providerReference: null,
        receiptReference: null,
        confirmedAt: null,
        createdAt: new Date(),
      },
      {
        internalReference: 'LPD_OAUTH',
        type: PaymentType.WALLET_DEPOSIT,
        amountKes: 500,
        currency: 'KES',
        status: PaymentStatus.FAILED,
        failureCode: 'MPESA_OAUTH_FAILED',
        initiationPhase: 'OAUTH',
        providerReference: null,
        receiptReference: null,
        confirmedAt: null,
        createdAt: new Date(),
      },
      {
        internalReference: 'LPD_REJECTED',
        type: PaymentType.WALLET_DEPOSIT,
        amountKes: 500,
        currency: 'KES',
        status: PaymentStatus.FAILED,
        failureCode: 'MPESA_STK_REJECTED',
        initiationPhase: 'STK_REJECTED',
        providerReference: null,
        receiptReference: null,
        confirmedAt: null,
        createdAt: new Date(),
      },
    ]);
    const listingService = new PaymentService({
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    const payments = await listingService.listCustomerPayments('customer-id');

    expect(payments.map((item) => item.providerResult.message)).toEqual([
      'Payment details failed local validation. No request was sent to Safaricom; review the amount and phone number before retrying.',
      'The request could not be sent to Safaricom, so no payment prompt was issued. Try again later or contact support.',
      'Safaricom rejected the STK request before a payment could be confirmed. Review the payment details or contact support.',
    ]);
    expect(payments.every((item) => !('failureCode' in item))).toBe(true);
  });
});

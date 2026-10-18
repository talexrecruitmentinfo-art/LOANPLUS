import { ConflictException } from '@nestjs/common';
import { PaymentType, type PaymentStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from '../ledger/ledger.service';
import type { MpesaService } from './mpesa.service';
import { PaymentService } from './payment.service';

describe('PaymentService provider reconciliation', () => {
  const paymentId = 'payment-id';
  const request = {
    id: 'activation-request-id',
    paymentTransactionId: paymentId,
    userId: 'customer-id',
    loanApplicationId: null,
    checkoutRequestId: 'checkout-id',
    merchantRequestId: 'merchant-id',
    callbackTokenHash: 'hashed-callback-token',
    phoneNumberCiphertext: 'encrypted-phone',
    policySnapshot: {},
    expiresAt: new Date(Date.now() + 60_000),
  };
  const payment = {
    id: paymentId,
    userId: 'customer-id',
    type: PaymentType.ACTIVATION,
    loanApplicationId: null,
    amountKes: 50,
    currency: 'KES',
    status: 'PENDING' as PaymentStatus,
    failureCode: null,
    receiptReference: null,
    activationRequest: request,
  };
  const startedAttempt = {
    id: 'attempt-id',
    outcome: 'STARTED',
    providerResultCode: null,
    reasonCode: null,
    operatorNote: 'Investigating missing callback',
  };

  function createService(resultCode = 4999) {
    const createAttempt = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...startedAttempt,
      ...data,
      id: 'attempt-id',
      requestedAt: new Date(),
      completedAt: data.completedAt ?? null,
    }));
    const updateAttempt = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...startedAttempt,
      ...data,
      requestedAt: new Date(),
      completedAt: new Date(),
    }));
    const paymentUpdate = jest.fn(async () => ({ count: 1 }));
    const findPriorAttempt = jest.fn(async (): Promise<{
      id: string;
      outcome: string;
      providerResultCode: string | null;
      reasonCode: string | null;
      operatorNote: string;
      superadminId: string;
    } | null> => null);
    const findRecentAttempt = jest.fn(async (): Promise<{ id: string } | null> => null);
    const transactionClient = {
      paymentReconciliationAttempt: {
        findUnique: findPriorAttempt,
        findFirst: findRecentAttempt,
        create: createAttempt,
        update: updateAttempt,
      },
      paymentTransaction: {
        findUnique: jest.fn(async () => payment),
        updateMany: paymentUpdate,
        findUniqueOrThrow: jest.fn(async () => ({ id: paymentId, status: 'PENDING' })),
      },
      activationPaymentRequest: { updateMany: jest.fn(async () => ({ count: 1 })) },
      paymentCallbackEvent: { create: jest.fn(async () => ({})) },
      adminAuditLog: { create: jest.fn(async () => ({})) },
      ledgerAccount: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})) },
      referral: { updateMany: jest.fn(async () => ({ count: 0 })) },
      user: { update: jest.fn(async () => ({})) },
      authAuditLog: { create: jest.fn(async () => ({})) },
    };
  const transaction = jest.fn(async (callback: (tx: never) => Promise<unknown>) => callback(transactionClient as never));
    const prisma = {
      systemSetting: { findUnique: jest.fn(async () => null) },
      paymentTransaction: {
        findUnique: jest.fn(async () => payment),
        findMany: jest.fn(async () => []),
      },
      paymentReconciliationAttempt: { findUnique: findPriorAttempt },
      adminAuditLog: { findMany: jest.fn(async () => []) },
      $transaction: transaction,
    } as unknown as PrismaService;
    const queryStkStatus = jest.fn(async () => ({
      checkoutRequestId: request.checkoutRequestId,
      merchantRequestId: request.merchantRequestId,
      resultCode,
      resultDescription: 'sanitized fixture description',
    }));
    const service = new PaymentService(
      prisma,
      { queryStkStatus } as unknown as MpesaService,
      { postWithinTransaction: jest.fn() } as unknown as LedgerService,
    );
    return { service, prisma, queryStkStatus, createAttempt, updateAttempt, paymentUpdate, findPriorAttempt, findRecentAttempt };
  }

  it('records 4999 as unresolved without changing payment or ledger state', async () => {
    const fixture = createService(4999);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-request-0001',
      'superadmin-id',
      'Investigating delayed activation callback',
      '127.0.0.1',
    );

    expect(result).toMatchObject({ outcome: 'UNRESOLVED_4999', providerResultCode: '4999', reasonCode: 'RESULT_4999_REMAINS_UNRESOLVED' });
    expect(fixture.createAttempt).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ operatorNote: 'Investigating delayed activation callback' }),
    }));
    expect(fixture.queryStkStatus).toHaveBeenCalledWith(request.checkoutRequestId);
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
  });

  it('lists legacy 4999 records as pending while preserving their stored database status', async () => {
    const findMany = jest.fn(async () => [{
      ...payment,
      status: 'FAILED',
      failureCode: 'MPESA_RESULT_4999',
      providerReference: request.checkoutRequestId,
      createdAt: new Date(Date.now() - 10 * 60_000),
      updatedAt: new Date(),
      activationRequest: {
        ...request,
        callbackEvents: [],
        reconciliationAttempts: [],
        _count: { reconciliationAttempts: 0 },
      },
      reconciliationAttempts: [],
      _count: { reconciliationAttempts: 0 },
    }]);
    const service = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => null) },
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    const result = await service.listReconciliationQueue(undefined, 25);

    expect(result.items[0]).toMatchObject({
      status: 'PENDING',
      recordedStatus: 'FAILED',
      reconciliationStatus: 'LEGACY_UNRESOLVED_4999',
      _count: { reconciliationAttempts: 0 },
    });
    expect(result.items[0]).not.toHaveProperty('failureCode');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 26, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
  });

  it('surfaces a recorded escalation in the queue status', async () => {
    const findMany = jest.fn(async () => [{
      ...payment,
      createdAt: new Date(Date.now() - 10 * 60_000),
      updatedAt: new Date(),
      activationRequest: { ...request, callbackEvents: [] },
      reconciliationAttempts: [{
        id: 'escalation-id',
        outcome: 'ESCALATED',
        providerResultCode: null,
        reasonCode: 'PROVIDER_INVESTIGATION_REQUIRED',
        operatorNote: 'Provider investigation requested',
        requestedAt: new Date(),
        completedAt: new Date(),
        superadmin: { email: 'admin@example.invalid' },
      }],
      _count: { reconciliationAttempts: 1 },
    }]);
    const service = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => null) },
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    const result = await service.listReconciliationQueue(undefined, 25);

    expect(result.items[0].reconciliationStatus).toBe('ESCALATED');
    expect(result.items[0].reasonForInclusion).toBe('ESCALATED');
  });

  it('renders historical 4999 attempt labels without asserting provider semantics', async () => {
    const findMany = jest.fn(async () => [{
      ...payment,
      createdAt: new Date(Date.now() - 10 * 60_000),
      updatedAt: new Date(),
      activationRequest: { ...request, callbackEvents: [] },
      reconciliationAttempts: [{
        id: 'legacy-attempt-id',
        outcome: 'UNRESOLVED_PROCESSING',
        providerResultCode: '4999',
        reasonCode: 'PROVIDER_STILL_PROCESSING',
        operatorNote: 'Legacy investigation note',
        requestedAt: new Date(),
        completedAt: new Date(),
        superadmin: { email: 'admin@example.invalid' },
      }],
      _count: { reconciliationAttempts: 1 },
    }]);
    const service = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => null) },
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    const result = await service.listReconciliationQueue(undefined, 25);

    expect(result.items[0]).toMatchObject({
      reconciliationStatus: 'UNRESOLVED_4999',
      reconciliationAttempts: [{
        outcome: 'UNRESOLVED_4999',
        reasonCode: 'RESULT_4999_REMAINS_UNRESOLVED',
      }],
    });
  });

  it('includes fresh unresolved provider exceptions independently of the age threshold', async () => {
    const findMany = jest.fn(async () => []);
    const service = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => ({ value: 1440 })) },
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    await service.listReconciliationQueue(undefined, 25, undefined, 'PROVIDER_REVIEW');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        type: { in: [PaymentType.ACTIVATION, PaymentType.LOAN_PROCESSING_FEE] },
        status: 'PENDING',
        reconciliationAttempts: {
          some: {
            outcome: {
              in: expect.arrayContaining(['UNRESOLVED_UNKNOWN_RESULT', 'UNRESOLVED_IDENTIFIER_MISMATCH', 'ESCALATED']),
            },
          },
        },
      }),
    }));
  });

  it('filters by exact internal, provider, or receipt reference without selecting customer identity', async () => {
    const findMany = jest.fn(async (_query: { select?: Record<string, unknown> }) => []);
    const service = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => null) },
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    await service.listReconciliationQueue(undefined, 25, 'LPA123', 'LEGACY_4999');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        type: PaymentType.ACTIVATION,
        status: 'FAILED',
        failureCode: 'MPESA_RESULT_4999',
        OR: [
          { internalReference: 'LPA123' },
          { providerReference: 'LPA123' },
          { receiptReference: 'LPA123' },
        ],
      }),
      take: 26,
    }));
    expect(findMany.mock.calls[0]?.[0].select).not.toHaveProperty('user');
  });

  it('rejects an overlong payment-reference search before querying records', async () => {
    const findMany = jest.fn();
    const service = new PaymentService({
      systemSetting: { findUnique: jest.fn() },
      paymentTransaction: { findMany },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);

    await expect(service.listReconciliationQueue(undefined, 25, 'x'.repeat(41)))
      .rejects.toThrow('40 characters or fewer');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('records query success as awaiting a validated callback instead of settling from the query', async () => {
    const fixture = createService(0);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-request-0002',
      'superadmin-id',
      'Verify provider success and callback metadata',
      '127.0.0.1',
    );

    expect(result).toMatchObject({ outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK', reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED' });
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
  });

  it('returns the existing outcome for a repeated idempotency key without another provider query', async () => {
    const fixture = createService(4999);
    fixture.findPriorAttempt.mockResolvedValueOnce({
      id: 'existing-attempt',
      outcome: 'UNRESOLVED_PROCESSING',
      providerResultCode: '4999',
      reasonCode: 'PROVIDER_STILL_PROCESSING',
      operatorNote: 'Previously investigated attempt',
      superadminId: 'superadmin-id',
    });

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-request-0003',
      'superadmin-id',
      'Repeat the same idempotent request',
      '127.0.0.1',
    );

    expect(result.outcome).toBe('UNRESOLVED_PROCESSING');
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.createAttempt).not.toHaveBeenCalled();
  });

  it('does not allow another Superadmin to replay an attempt key', async () => {
    const fixture = createService();
    fixture.findPriorAttempt.mockResolvedValueOnce({
      id: 'existing-attempt',
      outcome: 'UNRESOLVED_PROCESSING',
      providerResultCode: '4999',
      reasonCode: 'PROVIDER_STILL_PROCESSING',
      operatorNote: 'Previously investigated attempt',
      superadminId: 'different-superadmin',
    });

    await expect(fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-request-0006',
      'superadmin-id',
      'Repeat the same idempotent request',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
  });

  it('blocks concurrent status refreshes while a recent attempt is still running', async () => {
    const fixture = createService();
    fixture.findRecentAttempt.mockResolvedValueOnce({ id: 'active-attempt' });

    await expect(fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-request-0004',
      'superadmin-id',
      'Investigate current unresolved provider status',
      '127.0.0.1',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.createAttempt).not.toHaveBeenCalled();
  });

  it('rejects missing investigation notes before creating an attempt', async () => {
    const fixture = createService();

    await expect(fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-request-0005',
      'superadmin-id',
      'short',
      '127.0.0.1',
    )).rejects.toThrow('investigation note');
    expect(fixture.createAttempt).not.toHaveBeenCalled();
  });

  it('records an idempotent escalation without querying the provider or changing payment state', async () => {
    const fixture = createService();

    const result = await fixture.service.escalateActivationPayment(
      paymentId,
      'reconciliation-escalation-0001',
      'superadmin-id',
      'Escalate unresolved payment for provider investigation',
      '127.0.0.1',
    );

    expect(result).toMatchObject({ outcome: 'ESCALATED', reasonCode: 'PROVIDER_INVESTIGATION_REQUIRED' });
    expect(fixture.createAttempt).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'ESCALATED', operatorNote: 'Escalate unresolved payment for provider investigation' }),
    }));
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
  });

  it('rejects an escalation replay key already used for a provider refresh', async () => {
    const fixture = createService();
    fixture.findPriorAttempt.mockResolvedValueOnce({
      id: 'existing-attempt',
      outcome: 'UNRESOLVED_PROCESSING',
      providerResultCode: '4999',
      reasonCode: 'PROVIDER_STILL_PROCESSING',
      operatorNote: 'Previously refreshed provider status',
      superadminId: 'superadmin-id',
    });

    await expect(fixture.service.escalateActivationPayment(
      paymentId,
      'reconciliation-refresh-replay-0001',
      'superadmin-id',
      'Escalate unresolved payment for provider investigation',
      '127.0.0.1',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.createAttempt).not.toHaveBeenCalled();
  });
});

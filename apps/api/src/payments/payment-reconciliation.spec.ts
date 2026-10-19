import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentType, Prisma, type PaymentStatus } from '@prisma/client';
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
    internalReference: 'LPP123456789012',
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

  function createService(
    resultCode = 4999,
    paymentRecord: unknown = payment,
    verifiedReceiptReference: string | null = null,
  ) {
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
    const evidenceAttempt = {
      id: 'attempt-id',
      paymentTransactionId: paymentId,
      superadminId: 'submitting-superadmin-id',
      outcome: 'EVIDENCE_SUBMITTED_AWAITING_REVIEW',
      providerResultCode: null,
      reasonCode: 'INDEPENDENT_EVIDENCE_REVIEW_REQUIRED',
      operatorNote: 'Safaricom record supplied for independent review',
      submittedAccountReference: '123456789012',
      submittedCheckoutRequestId: request.checkoutRequestId,
      submittedMerchantRequestId: request.merchantRequestId,
      evidenceSource: 'SAFARICOM_PORTAL',
      evidenceReference: 'CASE-123456',
    };
    const findPriorAttempt = jest.fn(async ({ where }: { where?: { id?: string } }): Promise<{
      id: string;
      outcome: string;
      providerResultCode: string | null;
      reasonCode: string | null;
      operatorNote: string;
      superadminId: string;
      submittedAccountReference?: string | null;
      submittedCheckoutRequestId?: string | null;
      submittedMerchantRequestId?: string | null;
      evidenceSource?: string | null;
      evidenceReference?: string | null;
    } | null> => where?.id === evidenceAttempt.id ? evidenceAttempt : null);
    const findRecentAttempt = jest.fn(async (): Promise<{ id: string } | null> => null);
    const transactionClient = {
      paymentReconciliationAttempt: {
        findUnique: findPriorAttempt,
        findFirst: findRecentAttempt,
        create: createAttempt,
        update: updateAttempt,
      },
      paymentTransaction: {
        findUnique: jest.fn(async () => paymentRecord),
        updateMany: paymentUpdate,
        findUniqueOrThrow: jest.fn(async () => ({ id: paymentId, status: 'PENDING' })),
      },
      activationPaymentRequest: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => null),
      },
      paymentCallbackEvent: {
        create: jest.fn(async () => ({})),
        findFirst: jest.fn(async () => verifiedReceiptReference
          ? { id: 'verified-callback-event' }
          : null),
      },
      loanApplication: {
        findFirst: jest.fn(async () => ({ id: 'loan-application-id' })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      adminAuditLog: { create: jest.fn(async () => ({})) },
      ledgerAccount: {
        findUnique: jest.fn(async ({ where }: { where: { code: string } }) => where.code === 'MPESA_CLEARING'
          ? { id: 'clearing-account', isActive: true, currency: 'KES', accountType: 'ASSET' }
          : { id: 'revenue-account', isActive: true, currency: 'KES', accountType: 'REVENUE' }),
        create: jest.fn(async () => ({})),
      },
      systemSetting: { findUnique: jest.fn(async () => ({ value: 'LOAN_PROCESSING_FEES' })) },
      referral: { updateMany: jest.fn(async () => ({ count: 0 })) },
      user: { update: jest.fn(async () => ({})) },
      authAuditLog: { create: jest.fn(async () => ({})) },
    };
  const transaction = jest.fn(async (callback: (tx: never) => Promise<unknown>) => callback(transactionClient as never));
    const prisma = {
      systemSetting: { findUnique: jest.fn(async () => null) },
      paymentTransaction: {
        findUnique: jest.fn(async () => paymentRecord),
        findMany: jest.fn(async () => []),
      },
      paymentCallbackEvent: {
        findFirst: jest.fn(async () => verifiedReceiptReference
          ? { providerReceiptReference: verifiedReceiptReference }
          : null),
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
    const postWithinTransaction = jest.fn(async () => undefined);
    const service = new PaymentService(
      prisma,
      { queryStkStatus } as unknown as MpesaService,
      { postWithinTransaction } as unknown as LedgerService,
    );
    return { service, prisma, queryStkStatus, createAttempt, updateAttempt, paymentUpdate, postWithinTransaction, transactionClient, findPriorAttempt, findRecentAttempt, transaction };
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

  it('keeps nonzero provider results unresolved when no authoritative terminal mapping is configured', async () => {
    const fixture = createService(1032);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'unverified-terminal-result-01',
      'superadmin-id',
      'Provider result mapping requires verification',
      '127.0.0.1',
    );

    expect(result).toMatchObject({
      outcome: 'UNRESOLVED_UNKNOWN_RESULT',
      providerResultCode: '1032',
      reasonCode: 'UNRECOGNIZED_PROVIDER_RESULT',
    });
    expect(fixture.queryStkStatus).toHaveBeenCalledWith(request.checkoutRequestId);
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('records missing identifiers without querying Safaricom or changing the payment', async () => {
    const paymentWithoutProviderIds = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      activationRequest: {
        ...request,
        loanApplicationId: 'loan-application-id',
        checkoutRequestId: null,
        merchantRequestId: null,
      },
    };
    const fixture = createService(0, paymentWithoutProviderIds);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'missing-provider-ids-0001',
      'superadmin-id',
      'No provider request identifiers are stored',
      '127.0.0.1',
    );

    expect(result).toMatchObject({
      outcome: 'UNRESOLVED_MISSING_IDENTIFIERS',
      reasonCode: 'PROVIDER_IDENTIFIERS_MISSING',
    });
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('records provider identifiers and evidence without querying Safaricom before independent review', async () => {
    const uncertainPayment = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      activationRequest: {
        ...request,
        loanApplicationId: 'loan-application-id',
        checkoutRequestId: null,
        merchantRequestId: null,
      },
    };
    const fixture = createService(0, uncertainPayment);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'uncertain-initiation-refresh-01',
      'superadmin-id',
      'Safaricom identifiers supplied from official records',
      '127.0.0.1',
      { accountReference: '123456789012', checkoutRequestId: request.checkoutRequestId, merchantRequestId: request.merchantRequestId, evidenceSource: 'SAFARICOM_PORTAL', evidenceReference: 'CASE-123456' },
    );

    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();
    expect(fixture.createAttempt).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        submittedCheckoutRequestId: request.checkoutRequestId,
        submittedMerchantRequestId: request.merchantRequestId,
        submittedAccountReference: '123456789012',
        evidenceSource: 'SAFARICOM_PORTAL',
        evidenceReference: 'CASE-123456',
      }),
    }));
    expect(result).toMatchObject({
      outcome: 'EVIDENCE_SUBMITTED_AWAITING_REVIEW',
      reasonCode: 'INDEPENDENT_EVIDENCE_REVIEW_REQUIRED',
    });
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('returns the original evidence submission for an exact idempotent replay', async () => {
    const fixture = createService();
    const evidenceAttempt = {
      id: 'evidence-attempt-id',
      outcome: 'EVIDENCE_SUBMITTED_AWAITING_REVIEW',
      providerResultCode: null,
      reasonCode: 'INDEPENDENT_EVIDENCE_REVIEW_REQUIRED',
      operatorNote: 'Original evidence submission',
      superadminId: 'superadmin-id',
      submittedAccountReference: '123456789012',
      submittedCheckoutRequestId: request.checkoutRequestId,
      submittedMerchantRequestId: request.merchantRequestId,
      evidenceSource: 'SAFARICOM_PORTAL',
      evidenceReference: 'CASE-123456',
    };
    fixture.findPriorAttempt.mockResolvedValueOnce(evidenceAttempt);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'evidence-submission-replay-01',
      'superadmin-id',
      'Retried evidence submission with the same IDs',
      '127.0.0.1',
      {
        accountReference: '123456789012',
        checkoutRequestId: request.checkoutRequestId,
        merchantRequestId: request.merchantRequestId,
        evidenceSource: 'SAFARICOM_PORTAL',
        evidenceReference: 'CASE-123456',
      },
    );

    expect(result).toEqual(evidenceAttempt);
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.createAttempt).not.toHaveBeenCalled();
  });

  it('requires a different Superadmin and matching provider IDs before binding, without settling from query success', async () => {
    const uncertainPayment = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      activationRequest: { ...request, loanApplicationId: 'loan-application-id', checkoutRequestId: null, merchantRequestId: null },
    };
    const fixture = createService(0, uncertainPayment);

    await expect(fixture.service.verifyUncertainProcessingFeeEvidence(
      paymentId,
      'attempt-id',
      'evidence-review-same-admin-001',
      'submitting-superadmin-id',
      'Independently checking official provider record',
      true,
      '127.0.0.1',
    )).rejects.toThrow('A different Superadmin must independently review');
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();

    const result = await fixture.service.verifyUncertainProcessingFeeEvidence(
      paymentId,
      'attempt-id',
      'evidence-review-second-admin-001',
      'reviewing-superadmin-id',
      'Independently checked official provider record',
      true,
      '127.0.0.1',
    );

    expect(fixture.queryStkStatus).toHaveBeenCalledWith(request.checkoutRequestId);
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: request.id, checkoutRequestId: null, merchantRequestId: null }),
      data: { checkoutRequestId: request.checkoutRequestId, merchantRequestId: request.merchantRequestId },
    }));
    expect(result).toMatchObject({
      outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK',
      providerResultCode: '0',
      reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED',
    });
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('returns the original evidence-review outcome for a same-reviewer replay', async () => {
    const fixture = createService();
    const reviewedAttempt = {
      id: 'review-attempt-id',
      outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK',
      providerResultCode: '0',
      reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED',
      operatorNote: 'Reviewed evidence attempt-id: Independent provider review complete',
      superadminId: 'reviewing-superadmin-id',
    };
    fixture.findPriorAttempt.mockResolvedValueOnce(reviewedAttempt);

    const result = await fixture.service.verifyUncertainProcessingFeeEvidence(
      paymentId,
      'attempt-id',
      'evidence-review-replay-0001',
      'reviewing-superadmin-id',
      'Independent provider review complete',
      true,
      '127.0.0.1',
    );

    expect(result).toEqual(reviewedAttempt);
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
  });

  it('conflicts when an evidence-review key is reused for a different evidence attempt', async () => {
    const fixture = createService();
    fixture.findPriorAttempt.mockResolvedValueOnce({
      id: 'review-attempt-id',
      outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK',
      providerResultCode: '0',
      reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED',
      operatorNote: 'Reviewed evidence another-attempt: Original review',
      superadminId: 'reviewing-superadmin-id',
    });

    await expect(fixture.service.verifyUncertainProcessingFeeEvidence(
      paymentId,
      'attempt-id',
      'evidence-review-replay-0002',
      'reviewing-superadmin-id',
      'Review a different submission',
      true,
      '127.0.0.1',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
  });

  it('returns a committed evidence-review attempt after a concurrent serialization race', async () => {
    const fixture = createService();
    const reviewedAttempt = {
      id: 'review-attempt-id',
      outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK',
      providerResultCode: '0',
      reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED',
      operatorNote: 'Reviewed evidence attempt-id: Same review',
      superadminId: 'reviewing-superadmin-id',
    };
    fixture.transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError(
      'Concurrent evidence-review transaction',
      { code: 'P2034', clientVersion: '6.19.3' },
    ));
    fixture.findPriorAttempt.mockResolvedValueOnce(reviewedAttempt);

    const result = await fixture.service.verifyUncertainProcessingFeeEvidence(
      paymentId,
      'attempt-id',
      'evidence-review-race-0001',
      'reviewing-superadmin-id',
      'Same review',
      true,
      '127.0.0.1',
    );

    expect(result).toEqual(reviewedAttempt);
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
  });

  it('does not bind evidence IDs when the independent review query returns mismatched identifiers', async () => {
    const uncertainPayment = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      activationRequest: { ...request, loanApplicationId: 'loan-application-id', checkoutRequestId: null, merchantRequestId: null },
    };
    const fixture = createService(0, uncertainPayment);
    fixture.queryStkStatus.mockResolvedValueOnce({
      checkoutRequestId: request.checkoutRequestId,
      merchantRequestId: 'different-merchant-id',
      resultCode: 0,
      resultDescription: 'Sanitized fixture response',
    });

    const result = await fixture.service.verifyUncertainProcessingFeeEvidence(
      paymentId,
      'attempt-id',
      'evidence-review-mismatch-001',
      'reviewing-superadmin-id',
      'Safaricom IDs do not match the official evidence',
      true,
      '127.0.0.1',
    );

    expect(result).toMatchObject({ outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH', reasonCode: 'PROVIDER_IDENTIFIERS_MISMATCH' });
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('leaves payment and identifiers unchanged when the independent review query is unavailable', async () => {
    const uncertainPayment = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      activationRequest: { ...request, loanApplicationId: 'loan-application-id', checkoutRequestId: null, merchantRequestId: null },
    };
    const fixture = createService(0, uncertainPayment);
    fixture.queryStkStatus.mockRejectedValueOnce(new ServiceUnavailableException('Provider unavailable.'));

    const result = await fixture.service.verifyUncertainProcessingFeeEvidence(
      paymentId,
      'attempt-id',
      'evidence-review-unavailable-01',
      'reviewing-superadmin-id',
      'Provider status query is unavailable',
      true,
      '127.0.0.1',
    );

    expect(result).toMatchObject({ outcome: 'UNRESOLVED_PROVIDER_UNAVAILABLE', reasonCode: 'PROVIDER_UNAVAILABLE_DURING_EVIDENCE_REVIEW' });
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('does not query or bind evidence submitted by one Superadmin when Safaricom identifiers might mismatch', async () => {
    const uncertainPayment = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      activationRequest: {
        ...request,
        loanApplicationId: 'loan-application-id',
        checkoutRequestId: null,
        merchantRequestId: null,
      },
    };
    const fixture = createService(0, uncertainPayment);
    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'uncertain-initiation-refresh-02',
      'superadmin-id',
      'Safaricom response does not match supplied request identifiers',
      '127.0.0.1',
      { accountReference: '123456789012', checkoutRequestId: request.checkoutRequestId, merchantRequestId: request.merchantRequestId, evidenceSource: 'SAFARICOM_PORTAL', evidenceReference: 'CASE-123457' },
    );

    expect(result).toMatchObject({ outcome: 'EVIDENCE_SUBMITTED_AWAITING_REVIEW', reasonCode: 'INDEPENDENT_EVIDENCE_REVIEW_REQUIRED' });
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('rejects an AccountReference that does not match the payment before querying Safaricom', async () => {
    const uncertainPayment = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      activationRequest: {
        ...request,
        loanApplicationId: 'loan-application-id',
        checkoutRequestId: null,
        merchantRequestId: null,
      },
    };
    const fixture = createService(0, uncertainPayment);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'uncertain-initiation-refresh-04',
      'superadmin-id',
      'Safaricom AccountReference does not match payment',
      '127.0.0.1',
      { accountReference: 'OTHERREF0001', checkoutRequestId: request.checkoutRequestId, merchantRequestId: request.merchantRequestId, evidenceSource: 'SAFARICOM_PORTAL', evidenceReference: 'CASE-123458' },
    );

    expect(result).toMatchObject({
      outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
      reasonCode: 'SAFARICOM_ACCOUNT_REFERENCE_MISMATCH',
    });
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
  });

  it('rejects incomplete operator-supplied Safaricom identifiers', async () => {
    const fixture = createService();

    await expect(fixture.service.reconcileActivationPayment(
      paymentId,
      'invalid-provider-identifiers-01',
      'superadmin-id',
      'Safaricom identifiers are incomplete',
      '127.0.0.1',
      { accountReference: '123456789012', checkoutRequestId: request.checkoutRequestId, merchantRequestId: '', evidenceSource: 'SAFARICOM_PORTAL', evidenceReference: 'CASE-123459' },
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.createAttempt).not.toHaveBeenCalled();
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
  });

  it('leaves submitted identifiers unbound and does not query until independent review', async () => {
    const uncertainPayment = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      activationRequest: {
        ...request,
        loanApplicationId: 'loan-application-id',
        checkoutRequestId: null,
        merchantRequestId: null,
      },
    };
    const fixture = createService(0, uncertainPayment);
    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'uncertain-initiation-refresh-03',
      'superadmin-id',
      'Safaricom query unavailable for official request IDs',
      '127.0.0.1',
      { accountReference: '123456789012', checkoutRequestId: request.checkoutRequestId, merchantRequestId: request.merchantRequestId, evidenceSource: 'SAFARICOM_PORTAL', evidenceReference: 'CASE-123460' },
    );

    expect(result).toMatchObject({ outcome: 'EVIDENCE_SUBMITTED_AWAITING_REVIEW', reasonCode: 'INDEPENDENT_EVIDENCE_REVIEW_REQUIRED' });
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.transactionClient.activationPaymentRequest.updateMany).not.toHaveBeenCalled();
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
  });

  it('recovers a legacy processing fee only with matching Safaricom success and verified callback receipt evidence', async () => {
    const legacyProcessingFee = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      status: 'FAILED' as PaymentStatus,
      failureCode: 'MPESA_RESULT_4999',
      activationRequest: { ...request, loanApplicationId: 'loan-application-id' },
    };
    const fixture = createService(0, legacyProcessingFee, 'TESTRECEIPT1');

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'processing-fee-recovery-0001',
      'superadmin-id',
      'Verified callback and Safaricom success evidence',
      '127.0.0.1',
    );

    expect(result).toMatchObject({
      outcome: 'RESOLVED_CONFIRMED',
      providerResultCode: '0',
      reasonCode: 'VERIFIED_CALLBACK_AND_SUCCESS_QUERY',
    });
    expect(fixture.queryStkStatus).toHaveBeenCalledWith(request.checkoutRequestId);
    expect(fixture.paymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: paymentId,
        status: 'FAILED',
        failureCode: 'MPESA_RESULT_4999',
        receiptReference: null,
      },
      data: expect.objectContaining({
        status: 'CONFIRMED',
        receiptReference: 'TESTRECEIPT1',
        providerReference: request.checkoutRequestId,
      }),
    }));
    expect(fixture.postWithinTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      idempotencyKey: `loan-processing-fee:${paymentId}`,
      transactionType: 'LOAN_PROCESSING_FEE',
      paymentId,
    }));
  });

  it('keeps a legacy processing fee unresolved when a successful query has no verified callback receipt', async () => {
    const legacyProcessingFee = {
      ...payment,
      type: PaymentType.LOAN_PROCESSING_FEE,
      loanApplicationId: 'loan-application-id',
      status: 'FAILED' as PaymentStatus,
      failureCode: 'MPESA_RESULT_4999',
      activationRequest: { ...request, loanApplicationId: 'loan-application-id' },
    };
    const fixture = createService(0, legacyProcessingFee);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'processing-fee-recovery-0002',
      'superadmin-id',
      'Successful query lacks verified callback receipt',
      '127.0.0.1',
    );

    expect(result).toMatchObject({
      outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK',
      reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED',
    });
    expect(fixture.paymentUpdate).not.toHaveBeenCalled();
    expect(fixture.postWithinTransaction).not.toHaveBeenCalled();
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

  it('conflicts when a replay key is reused for a different reconciliation action', async () => {
    const fixture = createService();
    fixture.findPriorAttempt.mockResolvedValueOnce({
      id: 'existing-attempt',
      outcome: 'EVIDENCE_SUBMITTED_AWAITING_REVIEW',
      providerResultCode: null,
      reasonCode: 'INDEPENDENT_EVIDENCE_REVIEW_REQUIRED',
      operatorNote: 'Safaricom record supplied for independent review',
      superadminId: 'superadmin-id',
      submittedAccountReference: '123456789012',
      submittedCheckoutRequestId: request.checkoutRequestId,
      submittedMerchantRequestId: request.merchantRequestId,
      evidenceSource: 'SAFARICOM_PORTAL',
      evidenceReference: 'CASE-123456',
    });

    await expect(fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-request-0007',
      'superadmin-id',
      'Refresh provider status instead of submitting evidence',
      '127.0.0.1',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.queryStkStatus).not.toHaveBeenCalled();
    expect(fixture.createAttempt).not.toHaveBeenCalled();
  });

  it.each(['P2002', 'P2034'])('returns the stored attempt after a concurrent %s insert race', async (code) => {
    const fixture = createService();
    const existingAttempt = {
      id: 'existing-attempt',
      outcome: 'UNRESOLVED_PROCESSING',
      providerResultCode: '4999',
      reasonCode: 'PROVIDER_STILL_PROCESSING',
      operatorNote: 'Same reconciliation action and note',
      superadminId: 'superadmin-id',
      submittedAccountReference: null,
      submittedCheckoutRequestId: null,
      submittedMerchantRequestId: null,
      evidenceSource: null,
      evidenceReference: null,
    };
    fixture.transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError(
      'Concurrent reconciliation insert',
      { code, clientVersion: '6.19.3' },
    ));
    fixture.findPriorAttempt.mockResolvedValueOnce(existingAttempt);

    const result = await fixture.service.reconcileActivationPayment(
      paymentId,
      'reconciliation-race-request-01',
      'superadmin-id',
      'Same reconciliation action and note',
      '127.0.0.1',
    );

    expect(result).toMatchObject({ id: 'existing-attempt', outcome: 'UNRESOLVED_PROCESSING' });
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

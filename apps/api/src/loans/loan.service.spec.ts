import { BadRequestException, ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { LoanService } from './loan.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from '../ledger/ledger.service';
import type { ConfirmManualDisbursementDto, CreateLoanApplicationDto } from './loan.dto';

const approvedTermsSnapshot = {
  productName: 'Snapshot product',
  termsVersion: 'terms-v1',
  durationDays: 30,
  interestRateBps: 1000,
  flatFeeKes: 10,
  approvedPrincipalKes: 3000,
  approvedChargesKes: 310,
  totalRepayableKes: 3310,
};

describe('LoanService Admin approval', () => {
  const application = {
    id: 'application-id',
    userId: 'customer-id',
    status: 'SUBMITTED',
    requestedPrincipalKes: 3000,
    applicationData: {
      productTermsSnapshot: {
        productName: 'Snapshot product',
        termsVersion: 'terms-v1',
        minimumPrincipalKes: 500,
        maximumPrincipalKes: 5000,
        durationDays: 30,
        interestRateBps: 1000,
        flatFeeKes: 10,
      },
    },
    user: { isActive: true, identityStatus: 'VERIFIED' },
    processingFeePayments: [{ status: 'CONFIRMED', amountKes: 50, currency: 'KES', receiptReference: 'TESTRECEIPT1' }],
  };

  function setup(options: {
    updateCount?: number;
    identityStatus?: string;
    isActive?: boolean;
    fee?: typeof application.processingFeePayments[number] | null;
    existingLoan?: { id: string } | null;
  } = {}) {
    const updateMany = jest.fn(async () => ({ count: options.updateCount ?? 1 }));
    const loanCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'loan-id', ...data }));
    const auditCreate = jest.fn(async () => ({}));
    const transactionClient = {
      loanApplication: {
        findUnique: jest.fn(async () => ({
          ...application,
          user: {
            ...application.user,
            identityStatus: options.identityStatus ?? 'VERIFIED',
            isActive: options.isActive ?? true,
          },
          processingFeePayments: options.fee === null ? [] : [options.fee ?? application.processingFeePayments[0]],
        })),
        updateMany,
      },
      loan: {
        findFirst: jest.fn(async () => options.existingLoan ?? null),
        create: loanCreate,
      },
      adminAuditLog: { create: auditCreate },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
    } as unknown as PrismaService;
    return { service: new LoanService(prisma, {} as LedgerService), updateMany, loanCreate, auditCreate };
  }

  const approve = {
    decision: 'APPROVE',
    reason: 'Verified identity and eligibility.',
    approvedPrincipalKes: 3000,
  } as const;

  it('moves Admin approval directly to disbursement pending and audits the approved amount', async () => {
    const { service, loanCreate, auditCreate, updateMany } = setup();
    const result = await service.reviewApplication('application-id', approve, 'admin-id');
    expect(result.status).toBe('WAITING_FOR_DISBURSEMENT');
    expect(loanCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        applicationId: 'application-id',
        userId: 'customer-id',
        principalKes: 3000,
        totalRepayableKes: 3310,
        acceptedTermsVersion: 'terms-v1',
        status: 'DISBURSEMENT_PENDING',
      }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        superadminId: 'admin-id',
        reason: approve.reason,
        details: expect.objectContaining({ approvedPrincipalKes: 3000 }),
      }),
    }));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reviewerId: 'admin-id',
        reviewedAt: expect.any(Date),
        status: 'WAITING_FOR_DISBURSEMENT',
      }),
    }));
    expect(loanCreate.mock.calls[0]?.[0].data).not.toHaveProperty('disbursedAt');
  });

  it('prevents duplicate loan creation after a repeated approval request', async () => {
    const state = setup();
    state.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await state.service.reviewApplication('application-id', approve, 'admin-id');
    await expect(state.service.reviewApplication('application-id', approve, 'admin-id'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(state.loanCreate).toHaveBeenCalledTimes(1);
    expect(state.auditCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unverified identity', { identityStatus: 'PENDING' }],
    ['inactive customer account', { isActive: false }],
    ['missing fee', { fee: null }],
    ['existing active loan', { existingLoan: { id: 'existing-loan' } }],
  ])('refuses approval with %s', async (_label, options) => {
    const state = setup(options);
    await expect(state.service.reviewApplication('application-id', approve, 'admin-id'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(state.updateMany).not.toHaveBeenCalled();
    expect(state.loanCreate).not.toHaveBeenCalled();
  });

  it.each([499, 3001, 5001])('refuses invalid approved principal %i without changing application state', async (approvedPrincipalKes) => {
    const state = setup();
    await expect(state.service.reviewApplication('application-id', {
      ...approve,
      approvedPrincipalKes,
    }, 'admin-id')).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(state.service.reviewApplication('application-id', {
      decision: 'APPROVE',
      reason: approve.reason,
    }, 'admin-id')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(state.updateMany).not.toHaveBeenCalled();
    expect(state.loanCreate).not.toHaveBeenCalled();
  });

  it('preserves rejection and does not create a loan', async () => {
    const state = setup({ identityStatus: 'PENDING', fee: null });
    const result = await state.service.reviewApplication('application-id', {
      decision: 'REJECT',
      reason: 'Eligibility criteria were not met.',
    }, 'admin-id');
    expect(result.status).toBe('REJECTED');
    expect(state.loanCreate).not.toHaveBeenCalled();
  });

  describe('LoanService application validation', () => {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    let unresolvedPaymentLookup: jest.Mock;
    let activeLoanLookup: jest.Mock;
    let matchingDraftLookup: jest.Mock;
    let service: LoanService;

    beforeEach(() => {
      jest.clearAllMocks();
      unresolvedPaymentLookup = jest.fn(async () => ({
        internalReference: 'LPP2A26FAA44E67AFED44C9E13F79547C4E',
        status: 'PENDING',
      }));
      activeLoanLookup = jest.fn(async () => null);
      matchingDraftLookup = jest.fn(async () => null);
      const transactionClient = {
        loan: { findFirst: activeLoanLookup },
        loanApplication: {
          findUnique: jest.fn(async () => null),
          findFirst: matchingDraftLookup,
          create,
        },
      };
      const prisma = {
        user: { findUnique: jest.fn(async () => ({ isActive: true })) },
        loanProduct: { findFirst: jest.fn(async () => ({
          id: 'product-id',
          name: 'Configured product',
          termsVersion: 'product-v1',
          minimumPrincipalKes: 500,
          maximumPrincipalKes: 5000,
          durationDays: 30,
          interestRateBps: 1000,
          flatFeeKes: 10,
        })) },
        loan: { findFirst: activeLoanLookup },
        paymentTransaction: { findFirst: unresolvedPaymentLookup },
        loanApplication: {
          findUnique: jest.fn(async () => null),
          findFirst: matchingDraftLookup,
          create,
        },
        $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
      } as unknown as PrismaService;
      service = new LoanService(prisma, {} as LedgerService);
    });

    const application = (overrides: Partial<CreateLoanApplicationDto> = {}) => ({
      productId: 'product-id',
      termsAccepted: true,
      requestedPrincipalKes: 3000,
      guarantorOneName: '  First   Guarantor  ',
      guarantorOnePhone: '0712345678',
      guarantorTwoName: 'Second Guarantor',
      guarantorTwoPhone: '+254723456789',
      ...overrides,
    }) as CreateLoanApplicationDto;

    it('trims guarantor names and stores canonical phone numbers', async () => {
      await service.createApplication('customer-id', application(), 'loan-application-key-0001');

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          userId: 'customer-id',
          status: 'DRAFT',
          requestedPrincipalKes: 3000,
          applicationData: expect.objectContaining({
            termsAccepted: true,
            termsAcceptedAt: expect.any(String),
            guarantorOneName: 'First Guarantor',
            guarantorOnePhone: '+254712345678',
            guarantorTwoName: 'Second Guarantor',
            guarantorTwoPhone: '+254723456789',
            productTermsSnapshot: {
              productId: 'product-id',
              productName: 'Configured product',
              termsVersion: 'product-v1',
              minimumPrincipalKes: 500,
              maximumPrincipalKes: 5000,
              durationDays: 30,
              interestRateBps: 1000,
              flatFeeKes: 10,
              requestedPrincipalKes: 3000,
              estimatedInterestKes: 300,
              estimatedTotalRepaymentKes: 3310,
            },
          }),
        }),
      }));
    });

    it('allows another eligible application while a previous application fee remains unresolved', async () => {
      await service.createApplication('customer-id', application(), 'loan-application-key-0001');
      await service.createApplication('customer-id', application({ requestedPrincipalKes: 3500 }), 'loan-application-key-0002');

      expect(create).toHaveBeenCalledTimes(2);
      expect(unresolvedPaymentLookup).not.toHaveBeenCalled();
      expect(create.mock.calls.map(([{ data }]) => data.requestedPrincipalKes)).toEqual([3000, 3500]);
    });

    it('returns an existing exact-match draft and its payment status instead of creating a duplicate', async () => {
      matchingDraftLookup.mockResolvedValue({
        id: 'existing-application-id',
        status: 'PROCESSING_PAYMENT_PENDING',
        requestedPrincipalKes: 3000,
        createdAt: new Date('2026-10-19T20:00:00Z'),
        product: { name: 'Configured product' },
        processingFeePayments: [{
          id: 'payment-id',
          internalReference: 'LPP123456789012',
          status: 'PENDING',
          amountKes: 50,
          currency: 'KES',
          failureCode: null,
          receiptReference: null,
          confirmedAt: null,
        }],
      });

      const result = await service.createApplication('customer-id', application(), 'loan-application-key-0001');

      expect(result).toMatchObject({
        id: 'existing-application-id',
        status: 'PROCESSING_PAYMENT_PENDING',
        processingFeePayments: [{ internalReference: 'LPP123456789012', status: 'PENDING' }],
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('keeps the outstanding disbursed-loan restriction without misclassifying a pending disbursement', async () => {
      activeLoanLookup.mockResolvedValue({ id: 'active-loan-id' });
      await expect(service.createApplication(
        'customer-id',
        application(),
        'loan-application-key-0001',
      )).rejects.toThrow(/outstanding disbursed loan.*My Account.*support/i);
      expect(create).not.toHaveBeenCalled();
      expect(activeLoanLookup).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['DISBURSED', 'REPAYMENT_IN_PROGRESS', 'OVERDUE'] },
        }),
      }));
    });

    it('allows an application when the only existing loan is awaiting disbursement', async () => {
      await service.createApplication('customer-id', application(), 'loan-application-key-0001');
      expect(activeLoanLookup).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['DISBURSED', 'REPAYMENT_IN_PROGRESS', 'OVERDUE'] },
        }),
      }));
    });

    it.each([
      ['unaccepted terms', { termsAccepted: false }, BadRequestException],
      ['first guarantor name', { guarantorOneName: ' ' }, UnprocessableEntityException],
      ['second guarantor name', { guarantorTwoName: ' ' }, UnprocessableEntityException],
      ['first guarantor phone', { guarantorOnePhone: '12345' }, BadRequestException],
      ['second guarantor phone', { guarantorTwoPhone: '12345' }, BadRequestException],
      ['duplicate normalized guarantor phones', { guarantorTwoPhone: '+254712345678' }, UnprocessableEntityException],
      ['zero loan amount', { requestedPrincipalKes: 0 }, UnprocessableEntityException],
      ['fractional loan amount', { requestedPrincipalKes: 3000.5 }, UnprocessableEntityException],
      ['amount below configured limit', { requestedPrincipalKes: 499 }, UnprocessableEntityException],
      ['amount above configured limit', { requestedPrincipalKes: 5001 }, UnprocessableEntityException],
    ])('rejects %s', async (_description, overrides, expectedException) => {
      await expect(service.createApplication(
        'customer-id',
        application(overrides),
        'loan-application-key-0001',
      )).rejects.toBeInstanceOf(expectedException);
      expect(create).not.toHaveBeenCalled();
    });

    it('rejects applications for inactive accounts', async () => {
      const prisma = {
        user: { findUnique: jest.fn(async () => ({ isActive: false })) },
        loanProduct: { findFirst: jest.fn(async () => ({ id: 'product-id' })) },
      } as unknown as PrismaService;
      await expect(new LoanService(prisma, {} as LedgerService).createApplication(
        'customer-id',
        application(),
        'loan-application-key-0001',
      )).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('requires an idempotency key before reading or creating an application', async () => {
      await expect(service.createApplication('customer-id', application(), undefined))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it('does not approve a legacy application against mutable current product terms', async () => {
    const transactionClient = {
      loanApplication: {
        findUnique: jest.fn(async () => ({
          id: 'application-id',
          userId: 'customer-id',
          status: 'SUBMITTED',
          requestedPrincipalKes: 3000,
          applicationData: {},
          user: { isActive: true, identityStatus: 'VERIFIED' },
          processingFeePayments: [{ status: 'CONFIRMED', amountKes: 50, currency: 'KES', receiptReference: 'TESTRECEIPT1' }],
        })),
      },
      loan: { findFirst: jest.fn(async () => null) },
    };
    const transaction = jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient));
    const prisma = {
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new LoanService(prisma, {} as LedgerService);

    await expect(service.reviewApplication('application-id', {
      decision: 'APPROVE',
      reason: 'Legacy application approval test.',
    }, 'reviewer-id')).rejects.toThrow('no accepted product-terms snapshot');
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('creates the repayment due date from approved terms, not the mutable product', async () => {
    const scheduleCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const transactionClient = {
      loan: { updateMany: jest.fn(async () => ({ count: 1 })) },
      loanDisbursement: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
      repaymentSchedule: { create: scheduleCreate },
      adminAuditLog: { create: jest.fn(async () => ({})) },
    };
    const prisma = {
      loan: {
        findUnique: jest.fn(async () => ({
          id: 'loan-id',
          principalKes: 3000,
          chargesKes: 310,
          totalRepayableKes: 3310,
          status: 'DISBURSEMENT_PENDING',
          disbursement: null,
          application: { approvedTermsSnapshot },
        })),
      },
      ledgerAccount: {
        findUnique: jest.fn(async ({ where }: { where: { code: string } }) => ({
          id: where.code,
          isActive: true,
          currency: 'KES',
          accountType: 'ASSET',
        })),
      },
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
    } as unknown as PrismaService;
    const ledger = { postWithinTransaction: jest.fn(async () => undefined) } as unknown as LedgerService;
    const service = new LoanService(prisma, ledger);
    const before = Date.now();

    const result = await service.confirmManualDisbursement(
      'loan-id',
      { paymentReference: 'TEST-REFERENCE-01', reason: 'Verified isolated test disbursement' } as ConfirmManualDisbursementDto,
      'operator-id',
    );

    const dueAt = scheduleCreate.mock.calls[0]?.[0].data.dueAt as Date;
    expect(dueAt).toEqual(result.dueAt);
    expect(dueAt.getTime() - before).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
    expect(dueAt.getTime() - before).toBeLessThan(31 * 24 * 60 * 60 * 1000);
  });
});

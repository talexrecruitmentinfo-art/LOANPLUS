import { BadRequestException, ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { LoanService } from './loan.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from '../ledger/ledger.service';
import type { AcceptLoanOfferDto, ConfirmManualDisbursementDto, CreateLoanApplicationDto } from './loan.dto';

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

describe('LoanService approved terms snapshot', () => {
  it('accepts the reviewed version even if product terms changed before customer acceptance', async () => {
    const loanCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const transactionClient = {
      loanApplication: { updateMany: jest.fn(async () => ({ count: 1 })) },
      loan: { create: loanCreate },
      authAuditLog: { create: jest.fn(async () => ({})) },
    };
    const prisma = {
      loanApplication: {
        findFirst: jest.fn(async () => ({
          id: 'application-id',
          userId: 'customer-id',
          status: 'APPROVED',
          offerExpiresAt: null,
          approvedPrincipalKes: 3000,
          approvedChargesKes: 310,
          approvedTermsSnapshot,
          product: { termsVersion: 'terms-v2', durationDays: 90 },
        })),
      },
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
    } as unknown as PrismaService;
    const service = new LoanService(prisma, {} as LedgerService);

    await service.acceptOffer(
      'customer-id',
      'application-id',
      { termsAccepted: true } as AcceptLoanOfferDto,
    );

    expect(loanCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        principalKes: 3000,
        chargesKes: 310,
        totalRepayableKes: 3310,
        acceptedTermsVersion: 'terms-v1',
      }),
    }));
  });

  describe('LoanService application validation', () => {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    let service: LoanService;

    beforeEach(() => {
      jest.clearAllMocks();
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
        loan: { findFirst: jest.fn(async () => null) },
        loanApplication: {
          findUnique: jest.fn(async () => null),
          create,
        },
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

  it('rejects acceptance of a legacy offer without a recorded terms snapshot', async () => {
    const transaction = jest.fn();
    const prisma = {
      loanApplication: {
        findFirst: jest.fn(async () => ({
          id: 'application-id',
          userId: 'customer-id',
          status: 'APPROVED',
          offerExpiresAt: null,
          approvedPrincipalKes: 3000,
          approvedChargesKes: 310,
          approvedTermsSnapshot: null,
          product: { termsVersion: 'mutable-current-version' },
        })),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new LoanService(prisma, {} as LedgerService);

    await expect(service.acceptOffer(
      'customer-id',
      'application-id',
      { termsAccepted: true } as AcceptLoanOfferDto,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not approve a legacy application against mutable current product terms', async () => {
    const transaction = jest.fn();
    const prisma = {
      loanApplication: {
        findUnique: jest.fn(async () => ({
          id: 'application-id',
          status: 'SUBMITTED',
          requestedPrincipalKes: 3000,
          applicationData: {},
          product: {
            name: 'Current product',
            termsVersion: 'current-v2',
            minimumPrincipalKes: 500,
            maximumPrincipalKes: 5000,
            durationDays: 90,
            interestRateBps: 5000,
            flatFeeKes: 100,
          },
        })),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new LoanService(prisma, {} as LedgerService);

    await expect(service.reviewApplication('application-id', {
      decision: 'APPROVE',
      reason: 'Legacy application approval test.',
    }, 'reviewer-id')).rejects.toThrow('no accepted product-terms snapshot');
    expect(transaction).not.toHaveBeenCalled();
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

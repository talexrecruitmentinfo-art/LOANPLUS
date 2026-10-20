import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IdentityStatus, LedgerAccountType, LoanApplicationStatus, LoanStatus, PaymentStatus, PaymentType, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeKenyaPhone } from '../auth/security.util';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { getLoanProcessingFeePolicy, LOAN_PROCESSING_FEE_KES } from '../payments/processing-fee.constants';
import { APPROVAL_BLOCKING_LOAN_STATUSES, OUTSTANDING_LOAN_STATUSES } from './loan-eligibility.constants';
import { ConfirmManualDisbursementDto, CreateLoanApplicationDto, CreateLoanProductDto, ReviewLoanApplicationDto, UpdateLoanProductDto } from './loan.dto';

export interface ApprovedLoanTermsSnapshot extends Prisma.InputJsonObject {
  productName: string;
  termsVersion: string;
  durationDays: number;
  interestRateBps: number;
  flatFeeKes: number;
  approvedPrincipalKes: number;
  approvedChargesKes: number;
  totalRepayableKes: number;
}

@Injectable()
export class LoanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async listAvailableProducts() {
    return this.prisma.loanProduct.findMany({
      where: { isAvailable: true },
      select: {
        id: true,
        name: true,
        description: true,
        minimumPrincipalKes: true,
        maximumPrincipalKes: true,
        durationDays: true,
        interestRateBps: true,
        flatFeeKes: true,
        termsVersion: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async listMyEligibleRepayments(userId: string) {
    const loans = await this.prisma.loan.findMany({
      where: {
        userId,
        status: { in: [LoanStatus.DISBURSED, LoanStatus.REPAYMENT_IN_PROGRESS, LoanStatus.OVERDUE] },
        disbursedAt: { not: null },
      },
      select: {
        id: true,
        status: true,
        principalKes: true,
        chargesKes: true,
        outstandingKes: true,
        totalRepayableKes: true,
        repaymentSchedules: {
          select: { dueAt: true },
          orderBy: { sequence: 'asc' },
          take: 1,
        },
        repayments: { select: { principalPaidKes: true, chargesPaidKes: true } },
      },
      orderBy: { disbursedAt: 'asc' },
    });
    return loans.map((loan) => {
      const principalPaidKes = loan.repayments.reduce((total, repayment) => total + repayment.principalPaidKes, 0);
      const chargesPaidKes = loan.repayments.reduce((total, repayment) => total + repayment.chargesPaidKes, 0);
      const principalDueKes = loan.principalKes - principalPaidKes;
      const chargesDueKes = loan.chargesKes - chargesPaidKes;
      if (!Number.isSafeInteger(principalDueKes) || !Number.isSafeInteger(chargesDueKes) ||
        principalDueKes < 0 || chargesDueKes < 0 ||
        principalDueKes + chargesDueKes !== loan.outstandingKes ||
        loan.principalKes + loan.chargesKes !== loan.totalRepayableKes) {
        throw new ConflictException('A loan balance requires reconciliation before repayment.');
      }
      return {
        id: loan.id,
        status: loan.status,
        amountDueKes: loan.outstandingKes,
        principalDueKes,
        chargesDueKes,
        currency: 'KES',
        dueAt: loan.repaymentSchedules[0]?.dueAt ?? null,
      };
    }).filter((loan) => loan.amountDueKes > 0);
  }

  async getLoanChargeRevenueSettings() {
    const [setting, processingFeeSetting] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.charges_revenue_account' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' } }),
    ]);
    const revenueAccountCode = typeof setting?.value === 'string' ? setting.value : null;
    const processingFeeCode = typeof processingFeeSetting?.value === 'string' ? processingFeeSetting.value : null;
    const revenue = revenueAccountCode
      ? await this.prisma.ledgerAccount.findUnique({ where: { code: revenueAccountCode } })
      : null;
    const ready = Boolean(revenue?.isActive && revenue.currency === 'KES' &&
      revenue.accountType === LedgerAccountType.REVENUE && revenueAccountCode !== processingFeeCode);
    return {
      revenueAccountCode,
      accountingReady: ready,
      unavailableReasons: ready ? [] : [
        revenueAccountCode
          ? 'Select an active KES loan-charges revenue account that is separate from processing-fee revenue.'
          : 'A loan-charges revenue account has not been selected.',
      ],
    };
  }

  async getWalletRepaymentReadiness() {
    const [chargeSettings, receivable] = await Promise.all([
      this.getLoanChargeRevenueSettings(),
      this.prisma.ledgerAccount.findUnique({
        where: { code: 'LOAN_RECEIVABLE' },
        select: { isActive: true, currency: true, accountType: true },
      }),
    ]);
    const unavailableReasons = [...chargeSettings.unavailableReasons];
    if (!receivable?.isActive || receivable.currency !== 'KES' ||
      receivable.accountType !== LedgerAccountType.ASSET) {
      unavailableReasons.push('An active KES loan-receivable asset account is required.');
    }
    return { repaymentAvailable: unavailableReasons.length === 0, unavailableReasons };
  }

  async configureLoanChargeRevenueAccount(accountCode: string, reason: string, reviewerId: string, ipAddress?: string) {
    const normalizedCode = accountCode.trim();
    const [account, processingFeeSetting] = await Promise.all([
      this.prisma.ledgerAccount.findUnique({ where: { code: normalizedCode } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' } }),
    ]);
    if (!account || !account.isActive || account.currency !== 'KES' ||
      account.accountType !== LedgerAccountType.REVENUE ||
      (typeof processingFeeSetting?.value === 'string' && processingFeeSetting.value === normalizedCode)) {
      throw new UnprocessableEntityException('Select an active KES revenue account separate from processing-fee revenue.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: 'loan.charges_revenue_account' },
        create: { key: 'loan.charges_revenue_account', value: normalizedCode, updatedById: reviewerId },
        update: { value: normalizedCode, updatedById: reviewerId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: reviewerId,
          action: 'LOAN_CHARGES_REVENUE_ACCOUNT_CONFIGURED',
          subjectType: 'SYSTEM_SETTING',
          subjectId: normalizedCode,
          outcome: 'SUCCESS',
          reason: reason.trim(),
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });
    return this.getLoanChargeRevenueSettings();
  }

  async repayWithWallet(userId: string, loanId: string, amountKes: number, confirmed: boolean, idempotencyKey?: string) {
    if (confirmed !== true) throw new BadRequestException('Review and confirm the loan repayment before submitting it.');
    if (!Number.isSafeInteger(amountKes) || amountKes <= 0) {
      throw new BadRequestException('Enter a positive whole-KSh repayment amount.');
    }
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    const scopedKey = `wallet-repayment:${createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex')}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ userId, loanId, amountKes, currency: 'KES' }))
      .digest('hex');
    const existing = await this.prisma.paymentTransaction.findUnique({
      where: { idempotencyKey: scopedKey },
      include: { repayments: { include: { loan: { select: { id: true, userId: true, outstandingKes: true, status: true } } } } },
    });
    if (existing) return this.walletRepaymentReplay(existing, userId, requestHash);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const raced = await tx.paymentTransaction.findUnique({
          where: { idempotencyKey: scopedKey },
          include: { repayments: { include: { loan: { select: { id: true, userId: true, outstandingKes: true, status: true } } } } },
        });
        if (raced) return this.walletRepaymentReplay(raced, userId, requestHash);

        const loan = await tx.loan.findFirst({
          where: {
            id: loanId,
            userId,
            status: { in: [LoanStatus.DISBURSED, LoanStatus.REPAYMENT_IN_PROGRESS, LoanStatus.OVERDUE] },
            disbursedAt: { not: null },
          },
          include: {
            repayments: { select: { principalPaidKes: true, chargesPaidKes: true } },
            repaymentSchedules: { orderBy: { sequence: 'asc' }, take: 1 },
          },
        });
        if (!loan) throw new NotFoundException('An eligible disbursed loan was not found.');
        if (!loan.repaymentSchedules[0]) throw new ConflictException('The loan repayment schedule is unavailable.');
        const principalPaidKes = loan.repayments.reduce((total, repayment) => total + repayment.principalPaidKes, 0);
        const chargesPaidKes = loan.repayments.reduce((total, repayment) => total + repayment.chargesPaidKes, 0);
        const principalDueKes = loan.principalKes - principalPaidKes;
        const chargesDueKes = loan.chargesKes - chargesPaidKes;
        if (!Number.isSafeInteger(principalDueKes) || !Number.isSafeInteger(chargesDueKes) ||
          principalDueKes < 0 || chargesDueKes < 0 ||
          principalDueKes + chargesDueKes !== loan.outstandingKes ||
          loan.principalKes + loan.chargesKes !== loan.totalRepayableKes ||
          loan.outstandingKes <= 0) {
          throw new ConflictException('The loan balance requires reconciliation before repayment.');
        }
        if (amountKes > loan.outstandingKes) {
          throw new BadRequestException('The repayment cannot exceed the current amount due.');
        }
        const [walletAccount, receivableAccount, chargesSetting, feeSetting] = await Promise.all([
          tx.ledgerAccount.findUnique({ where: { code: `WALLET_${userId}` } }),
          tx.ledgerAccount.findUnique({ where: { code: 'LOAN_RECEIVABLE' } }),
          tx.systemSetting.findUnique({ where: { key: 'loan.charges_revenue_account' } }),
          tx.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' } }),
        ]);
        if (!walletAccount || walletAccount.userId !== userId ||
          walletAccount.accountType !== LedgerAccountType.LIABILITY ||
          walletAccount.currency !== 'KES' || !walletAccount.isActive) {
          throw new ConflictException('The customer wallet account is unavailable.');
        }
        const revenueCode = typeof chargesSetting?.value === 'string' ? chargesSetting.value : null;
        const feeRevenueCode = typeof feeSetting?.value === 'string' ? feeSetting.value : null;
        const chargesRevenueAccount = revenueCode
          ? await tx.ledgerAccount.findUnique({ where: { code: revenueCode } })
          : null;
        if (!receivableAccount?.isActive || receivableAccount.currency !== 'KES' ||
          receivableAccount.accountType !== LedgerAccountType.ASSET ||
          !chargesRevenueAccount?.isActive || chargesRevenueAccount.currency !== 'KES' ||
          chargesRevenueAccount.accountType !== LedgerAccountType.REVENUE ||
          revenueCode === feeRevenueCode) {
          throw new ConflictException('Separate KES loan-receivable and loan-charges revenue accounts must be configured.');
        }
        const walletEntries = await tx.ledgerEntry.aggregate({
          where: { ledgerAccountId: walletAccount.id, transaction: { status: 'POSTED' } },
          _sum: { creditKes: true, debitKes: true },
        });
        const walletBalanceKes = (walletEntries._sum.creditKes ?? 0) - (walletEntries._sum.debitKes ?? 0);
        if (!Number.isSafeInteger(walletBalanceKes) || walletBalanceKes < amountKes) {
          throw new ConflictException('The available wallet balance is insufficient for this repayment.');
        }

        const chargesPaidNow = Math.min(amountKes, chargesDueKes);
        const principalPaidNow = amountKes - chargesPaidNow;
        const nextOutstandingKes = loan.outstandingKes - amountKes;
        const nextStatus = nextOutstandingKes === 0
          ? LoanStatus.REPAID
          : loan.status === LoanStatus.OVERDUE
            ? LoanStatus.OVERDUE
            : LoanStatus.REPAYMENT_IN_PROGRESS;
        const now = new Date();
        const payment = await tx.paymentTransaction.create({
          data: {
            internalReference: `LPWR${randomBytes(16).toString('hex').toUpperCase()}`,
            idempotencyKey: scopedKey,
            requestHash,
            userId,
            type: PaymentType.REPAYMENT,
            amountKes,
            currency: 'KES',
            status: PaymentStatus.CONFIRMED,
            provider: 'INTERNAL_WALLET',
            confirmedAt: now,
          },
          select: { id: true, internalReference: true },
        });
        const repayment = await tx.repayment.create({
          data: {
            loanId: loan.id,
            scheduleId: loan.repaymentSchedules[0].id,
            paymentTransactionId: payment.id,
            principalPaidKes: principalPaidNow,
            chargesPaidKes: chargesPaidNow,
            amountKes,
            outstandingAfterKes: nextOutstandingKes,
            loanStatusAfter: nextStatus,
          },
        });
        const updated = await tx.loan.updateMany({
          where: {
            id: loan.id,
            userId,
            outstandingKes: loan.outstandingKes,
            status: { in: [LoanStatus.DISBURSED, LoanStatus.REPAYMENT_IN_PROGRESS, LoanStatus.OVERDUE] },
          },
          data: {
            outstandingKes: nextOutstandingKes,
            status: nextStatus,
            ...(nextOutstandingKes === 0 ? { repaidAt: now } : {}),
          },
        });
        if (updated.count !== 1) throw new ConflictException('The loan balance changed while this repayment was being processed.');
        await this.ledger.postWithinTransaction(tx, {
          idempotencyKey: `wallet-loan-repayment:${payment.id}`,
          transactionType: 'WALLET_LOAN_REPAYMENT',
          actorType: 'CUSTOMER',
          actorId: userId,
          paymentId: payment.id,
          reason: `Wallet repayment for loan ${loan.id}`,
          lines: [
            { accountId: walletAccount.id, debitKes: amountKes, creditKes: 0 },
            ...(principalPaidNow > 0
              ? [{ accountId: receivableAccount.id, debitKes: 0, creditKes: principalPaidNow }]
              : []),
            ...(chargesPaidNow > 0
              ? [{ accountId: chargesRevenueAccount.id, debitKes: 0, creditKes: chargesPaidNow }]
              : []),
          ],
        });
        return {
          reference: payment.internalReference,
          loanId: loan.id,
          amountKes,
          principalPaidKes: principalPaidNow,
          chargesPaidKes: chargesPaidNow,
          outstandingKes: nextOutstandingKes,
          status: nextStatus,
          currency: 'KES',
          createdAt: repayment.createdAt,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
        const duplicate = await this.prisma.paymentTransaction.findUnique({
          where: { idempotencyKey: scopedKey },
          include: { repayments: { include: { loan: { select: { id: true, userId: true, outstandingKes: true, status: true } } } } },
        });
        if (duplicate) return this.walletRepaymentReplay(duplicate, userId, requestHash);
        if (error.code === 'P2034') {
          throw new ConflictException('Another wallet transaction changed the available balance. Refresh and try again.');
        }
      }
      throw error;
    }
  }

  async getMyWalletRepaymentReceipt(userId: string, reference: string) {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        userId,
        internalReference: reference,
        type: PaymentType.REPAYMENT,
        provider: 'INTERNAL_WALLET',
      },
      include: { repayments: { include: { loan: { select: { id: true, userId: true, outstandingKes: true, status: true } } } } },
    });
    if (!payment || payment.repayments.length !== 1) throw new NotFoundException('Wallet repayment receipt was not found.');
    const repayment = payment.repayments[0];
    if (repayment.outstandingAfterKes === null || repayment.loanStatusAfter === null) {
      throw new ConflictException('The repayment receipt requires reconciliation.');
    }
    return {
      reference: payment.internalReference,
      loanId: repayment.loanId,
      amountKes: repayment.amountKes,
      principalPaidKes: repayment.principalPaidKes,
      chargesPaidKes: repayment.chargesPaidKes,
      outstandingKes: repayment.outstandingAfterKes,
      status: repayment.loanStatusAfter,
      currency: payment.currency,
      createdAt: repayment.createdAt,
    };
  }

  private walletRepaymentReplay(
    payment: {
      userId: string;
      type: PaymentType;
      provider: string;
      requestHash: string | null;
      internalReference: string;
      currency: string;
      repayments: Array<{
        loanId: string;
        amountKes: number;
        principalPaidKes: number;
        chargesPaidKes: number;
        outstandingAfterKes: number | null;
        loanStatusAfter: LoanStatus | null;
        createdAt: Date;
        loan: { id: string; userId: string; outstandingKes: number; status: LoanStatus };
      }>;
    },
    userId: string,
    requestHash: string,
  ) {
    if (payment.userId !== userId || payment.type !== PaymentType.REPAYMENT ||
      payment.provider !== 'INTERNAL_WALLET' || payment.currency !== 'KES' ||
      payment.requestHash !== requestHash || payment.repayments.length !== 1 ||
      payment.repayments[0].loan.userId !== userId ||
      payment.repayments[0].loanId !== payment.repayments[0].loan.id ||
      payment.repayments[0].outstandingAfterKes === null ||
      payment.repayments[0].loanStatusAfter === null) {
      throw new ConflictException('The idempotency key has already been used.');
    }
    const repayment = payment.repayments[0];
    return {
      reference: payment.internalReference,
      loanId: repayment.loanId,
      amountKes: repayment.amountKes,
      principalPaidKes: repayment.principalPaidKes,
      chargesPaidKes: repayment.chargesPaidKes,
      outstandingKes: repayment.outstandingAfterKes,
      status: repayment.loanStatusAfter,
      currency: payment.currency,
      createdAt: repayment.createdAt,
    };
  }

  listProductsForAdmin() {
    return this.prisma.loanProduct.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createProduct(dto: CreateLoanProductDto, reviewerId: string, ipAddress?: string) {
    this.validateProductBounds(dto.minimumPrincipalKes, dto.maximumPrincipalKes);
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.loanProduct.create({
        data: {
          ...dto,
          isAvailable: dto.isAvailable ?? false,
          eligibilityRules: (dto.eligibilityRules ?? {}) as Prisma.InputJsonValue,
        },
      });
      await tx.adminAuditLog.create({
        data: { superadminId: reviewerId, action: 'LOAN_PRODUCT_CREATE', subjectType: 'LOAN_PRODUCT', subjectId: product.id, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
      });
      return product;
    });
  }

  async updateProduct(id: string, dto: UpdateLoanProductDto, reviewerId: string, ipAddress?: string) {
    const current = await this.prisma.loanProduct.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Loan product was not found.');
    this.validateProductBounds(
      dto.minimumPrincipalKes ?? current.minimumPrincipalKes,
      dto.maximumPrincipalKes ?? current.maximumPrincipalKes,
    );
    const data: Prisma.LoanProductUpdateInput = {
      ...dto,
      eligibilityRules: dto.eligibilityRules as Prisma.InputJsonValue | undefined,
    };
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.loanProduct.update({ where: { id }, data });
      await tx.adminAuditLog.create({
        data: { superadminId: reviewerId, action: 'LOAN_PRODUCT_UPDATE', subjectType: 'LOAN_PRODUCT', subjectId: id, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
      });
      return product;
    });
  }

  async createApplication(userId: string, dto: CreateLoanApplicationDto, idempotencyKey: string | undefined) {
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    if (dto.termsAccepted !== true) {
      throw new BadRequestException('Review and accept the selected product terms before continuing.');
    }
    const [user, product] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
      this.prisma.loanProduct.findFirst({ where: { id: dto.productId, isAvailable: true } }),
    ]);
    if (!user || !user.isActive) throw new ForbiddenException('This account cannot apply for a loan.');
    if (!product) throw new NotFoundException('Loan product is unavailable.');
    if (!Number.isSafeInteger(dto.requestedPrincipalKes) || dto.requestedPrincipalKes < 1) {
      throw new UnprocessableEntityException('Enter a valid positive loan amount.');
    }
    if (
      dto.requestedPrincipalKes < product.minimumPrincipalKes ||
      dto.requestedPrincipalKes > product.maximumPrincipalKes
    ) {
      throw new UnprocessableEntityException('Requested amount is outside this product\'s configured limits.');
    }
    const guarantorOneName = dto.guarantorOneName.trim().replace(/\s+/g, ' ');
    const guarantorTwoName = dto.guarantorTwoName.trim().replace(/\s+/g, ' ');
    if (guarantorOneName.length < 2 || guarantorTwoName.length < 2) {
      throw new UnprocessableEntityException('Enter both guarantors’ full names.');
    }
    const guarantorOnePhone = normalizeKenyaPhone(dto.guarantorOnePhone);
    const guarantorTwoPhone = normalizeKenyaPhone(dto.guarantorTwoPhone);
    if (guarantorOnePhone === guarantorTwoPhone) {
      throw new UnprocessableEntityException('Guarantors must have different phone numbers.');
    }
    const creationIdempotencyKey = createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex');
    const productTermsSnapshot = {
      productId: product.id,
      productName: product.name,
      termsVersion: product.termsVersion,
      minimumPrincipalKes: product.minimumPrincipalKes,
      maximumPrincipalKes: product.maximumPrincipalKes,
      durationDays: product.durationDays,
      interestRateBps: product.interestRateBps,
      flatFeeKes: product.flatFeeKes,
      requestedPrincipalKes: dto.requestedPrincipalKes,
      estimatedInterestKes: Math.ceil(dto.requestedPrincipalKes * product.interestRateBps / 10_000),
      estimatedTotalRepaymentKes:
        dto.requestedPrincipalKes +
        Math.ceil(dto.requestedPrincipalKes * product.interestRateBps / 10_000) +
        product.flatFeeKes,
    };
    if (!Number.isSafeInteger(productTermsSnapshot.estimatedTotalRepaymentKes)) {
      throw new UnprocessableEntityException('Configured product terms exceed supported monetary limits.');
    }
    const applicationData = {
      termsAccepted: true,
      termsAcceptedAt: new Date().toISOString(),
      guarantorOneName,
      guarantorOnePhone,
      guarantorTwoName,
      guarantorTwoPhone,
      productTermsSnapshot,
    };
    const creationRequestHash = createHash('sha256')
      .update(JSON.stringify({
        productId: product.id,
        requestedPrincipalKes: dto.requestedPrincipalKes,
        guarantorOneName,
        guarantorOnePhone,
        guarantorTwoName,
        guarantorTwoPhone,
        productTermsSnapshot,
      }))
      .digest('hex');
    const selectApplication = {
      id: true,
      status: true,
      requestedPrincipalKes: true,
      createdAt: true,
      product: { select: { name: true } },
      processingFeePayments: {
        where: { type: PaymentType.LOAN_PROCESSING_FEE },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          internalReference: true,
          status: true,
          amountKes: true,
          currency: true,
          failureCode: true,
          receiptReference: true,
          confirmedAt: true,
        },
      },
    } as const;
    const resume = (application: {
      id: string;
      status: LoanApplicationStatus;
      requestedPrincipalKes: number;
      createdAt: Date;
      product: { name: string };
      processingFeePayments: Array<{
        id: string;
        internalReference: string;
        status: PaymentStatus;
        amountKes: number;
        currency: string;
        failureCode: string | null;
        receiptReference: string | null;
        confirmedAt: Date | null;
      }>;
    }) => application;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingByKey = await tx.loanApplication.findUnique({
          where: { creationIdempotencyKey },
          select: { ...selectApplication, creationRequestHash: true },
        });
        if (existingByKey && existingByKey.creationRequestHash !== creationRequestHash) {
          throw new ConflictException('The idempotency key has already been used.');
        }

        const outstandingLoan = await tx.loan.findFirst({
          where: { userId, status: { in: OUTSTANDING_LOAN_STATUSES } },
          select: { id: true },
        });
        if (outstandingLoan) {
          throw new ConflictException(
            'An outstanding disbursed loan is recorded for this account. Review your loan status in My Account or contact support before applying.',
          );
        }
        if (existingByKey) return resume(existingByKey);

        const matchingDraft = await tx.loanApplication.findFirst({
          where: {
            userId,
            productId: product.id,
            requestedPrincipalKes: dto.requestedPrincipalKes,
            creationRequestHash,
            status: { in: [LoanApplicationStatus.DRAFT, LoanApplicationStatus.PROCESSING_PAYMENT_PENDING] },
          },
          orderBy: { createdAt: 'desc' },
          select: selectApplication,
        });
        if (matchingDraft) return resume(matchingDraft);

        return tx.loanApplication.create({
          data: {
            creationIdempotencyKey,
            creationRequestHash,
            userId,
            productId: product.id,
            requestedPrincipalKes: dto.requestedPrincipalKes,
            status: LoanApplicationStatus.DRAFT,
            applicationData,
          },
          select: selectApplication,
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
        const [duplicate, outstandingLoan, matchingDraft] = await Promise.all([
          this.prisma.loanApplication.findUnique({
            where: { creationIdempotencyKey },
            select: { ...selectApplication, creationRequestHash: true },
          }),
          this.prisma.loan.findFirst({
            where: { userId, status: { in: OUTSTANDING_LOAN_STATUSES } },
            select: { id: true },
          }),
          this.prisma.loanApplication.findFirst({
            where: {
              userId,
              productId: product.id,
              requestedPrincipalKes: dto.requestedPrincipalKes,
              creationRequestHash,
              status: { in: [LoanApplicationStatus.DRAFT, LoanApplicationStatus.PROCESSING_PAYMENT_PENDING] },
            },
            orderBy: { createdAt: 'desc' },
            select: selectApplication,
          }),
        ]);
        if (outstandingLoan) {
          throw new ConflictException(
            'An outstanding disbursed loan is recorded for this account. Review your loan status in My Account or contact support before applying.',
          );
        }
        if (duplicate) {
          if (duplicate.creationRequestHash !== creationRequestHash) {
            throw new ConflictException('The idempotency key has already been used.');
          }
          return resume(duplicate);
        }
        if (matchingDraft) return resume(matchingDraft);
      }
      throw error;
    }
  }

  async listMyApplications(userId: string) {
    return this.prisma.loanApplication.findMany({
      where: { userId },
      select: {
        id: true,
        productId: true,
        createdAt: true,
        requestedPrincipalKes: true,
        approvedPrincipalKes: true,
        approvedChargesKes: true,
        approvedTermsSnapshot: true,
        status: true,
        decisionReason: true,
        requestedInformation: true,
        submittedAt: true,
        reviewedAt: true,
        offerExpiresAt: true,
        applicationData: true,
        processingFeePayments: {
          where: { type: PaymentType.LOAN_PROCESSING_FEE },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            internalReference: true,
            status: true,
            amountKes: true,
            currency: true,
            createdAt: true,
            confirmedAt: true,
            receiptReference: true,
            failureCode: true,
            initiationPhase: true,
          },
        },
        loan: { select: { status: true, disbursedAt: true, disbursement: { select: { amountKes: true, status: true, paymentReference: true, confirmedAt: true } } } },
        product: { select: { name: true, durationDays: true, termsVersion: true } },
      },
      orderBy: { submittedAt: 'desc' },
    });
  }

  listApplicationsForReview() {
    return this.prisma.loanApplication.findMany({
      where: { status: { in: [LoanApplicationStatus.SUBMITTED, LoanApplicationStatus.UNDER_REVIEW, LoanApplicationStatus.ADDITIONAL_INFORMATION_REQUIRED] } },
      include: {
        product: true,
        user: { select: { id: true, fullName: true, email: true, identityStatus: true } },
        processingFeePayments: {
          where: { type: PaymentType.LOAN_PROCESSING_FEE },
          orderBy: { createdAt: 'desc' },
          select: { internalReference: true, status: true, amountKes: true, receiptReference: true, confirmedAt: true },
        },
      },
      orderBy: { submittedAt: 'asc' },
    });
  }

  async getProcessingFeeSettings() {
    const [setting, clearing, chargesSetting] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' } }),
      this.prisma.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.charges_revenue_account' } }),
    ]);
    const revenueAccountCode = typeof setting?.value === 'string' ? setting.value : null;
    const chargesRevenueCode = typeof chargesSetting?.value === 'string' ? chargesSetting.value : null;
    const revenue = revenueAccountCode
      ? await this.prisma.ledgerAccount.findUnique({ where: { code: revenueAccountCode } })
      : null;
    const policy = getLoanProcessingFeePolicy();
    const unavailableReasons: string[] = [];
    const clearingReady = Boolean(clearing?.isActive && clearing.currency === 'KES' && clearing.accountType === LedgerAccountType.ASSET);
    const revenueReady = Boolean(revenue?.isActive && revenue.currency === 'KES' &&
      revenue.accountType === LedgerAccountType.REVENUE && revenueAccountCode !== chargesRevenueCode);
    if (policy.status !== 'CONFIGURED') unavailableReasons.push('Approved processing-fee policy approval, version, or disclosure is not configured.');
    if (!clearingReady) {
      unavailableReasons.push('An active KES asset account with code MPESA_CLEARING is required.');
    }
    if (!revenueAccountCode) unavailableReasons.push('A processing-fee revenue account has not been selected.');
    else if (revenueAccountCode === chargesRevenueCode) {
      unavailableReasons.push('Processing-fee and loan-charges revenue must use separate ledger accounts.');
    }
    else if (!revenueReady) {
      unavailableReasons.push('The selected processing-fee destination must be an active KES revenue account.');
    }
    return {
      revenueAccountCode,
      amountKes: LOAN_PROCESSING_FEE_KES,
      currency: 'KES',
      policy,
      accountingReady: clearingReady && revenueReady,
      unavailableReasons,
    };
  }

  async configureProcessingFeeRevenueAccount(accountCode: string, reason: string, reviewerId: string, ipAddress?: string) {
    const normalizedCode = accountCode.trim();
    const [account, chargesSetting] = await Promise.all([
      this.prisma.ledgerAccount.findUnique({ where: { code: normalizedCode } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.charges_revenue_account' } }),
    ]);
    const clearing = await this.prisma.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } });
    if (!account || !account.isActive || account.currency !== 'KES' || account.accountType !== 'REVENUE' ||
      (typeof chargesSetting?.value === 'string' && chargesSetting.value === normalizedCode) ||
      !clearing || !clearing.isActive || clearing.currency !== 'KES' || clearing.accountType !== 'ASSET') {
      throw new UnprocessableEntityException('Select an active KES processing-fee revenue account separate from loan charges, and an active M-Pesa clearing account.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: 'loan.processing_fee_revenue_account' },
        create: { key: 'loan.processing_fee_revenue_account', value: normalizedCode, updatedById: reviewerId },
        update: { value: normalizedCode, updatedById: reviewerId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: reviewerId,
          action: 'LOAN_PROCESSING_FEE_ACCOUNT_CONFIGURED',
          subjectType: 'SYSTEM_SETTING',
          subjectId: normalizedCode,
          outcome: 'SUCCESS',
          reason: reason.trim(),
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });
    return this.getProcessingFeeSettings();
  }

  listLoansAwaitingDisbursement() {
    return this.prisma.loan.findMany({
      where: { status: LoanStatus.DISBURSEMENT_PENDING, disbursement: null },
      select: {
        id: true,
        principalKes: true,
        chargesKes: true,
        totalRepayableKes: true,
        status: true,
        acceptedTermsVersion: true,
        createdAt: true,
        user: { select: { id: true, fullName: true, email: true } },
        application: { select: { product: { select: { name: true, durationDays: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async reviewApplication(id: string, dto: ReviewLoanApplicationDto, reviewerId: string, ipAddress?: string) {
    return this.prisma.$transaction(async (tx) => {
      const application = await tx.loanApplication.findUnique({
        where: { id },
        include: {
          user: { select: { identityStatus: true, isActive: true } },
          processingFeePayments: {
            where: { type: PaymentType.LOAN_PROCESSING_FEE },
            select: { status: true, amountKes: true, currency: true, receiptReference: true },
          },
        },
      });
      if (!application) throw new NotFoundException('Loan application was not found.');
      if (
        application.status !== LoanApplicationStatus.SUBMITTED &&
        application.status !== LoanApplicationStatus.UNDER_REVIEW
      ) {
        throw new ConflictException('This application is no longer awaiting review.');
      }
      const reason = dto.reason.trim();
      if (reason.length < 10) throw new BadRequestException('A decision reason of at least 10 characters is required.');

      let status: LoanApplicationStatus;
      let approvedPrincipalKes: number | undefined;
      let approvedChargesKes: number | undefined;
      let approvedTermsSnapshot: ApprovedLoanTermsSnapshot | undefined;
      if (dto.decision === 'APPROVE') {
        if (!application.user.isActive || application.user.identityStatus !== IdentityStatus.VERIFIED) {
          throw new ConflictException('The customer identity must be verified before loan approval.');
        }
        const hasVerifiedFee = application.processingFeePayments.some((payment) =>
          payment.status === PaymentStatus.CONFIRMED &&
          payment.amountKes === LOAN_PROCESSING_FEE_KES &&
          payment.currency === 'KES' &&
          Boolean(payment.receiptReference),
        );
        if (!hasVerifiedFee) throw new ConflictException('A verified processing-fee payment is required before loan approval.');

        const existingOpenLoan = await tx.loan.findFirst({
          where: { userId: application.userId, status: { in: APPROVAL_BLOCKING_LOAN_STATUSES } },
          select: { id: true },
        });
        if (existingOpenLoan) throw new ConflictException('The customer is not eligible for another active loan.');

        const acceptedProductTerms = this.parseAcceptedProductTerms(application.applicationData);
        const requestedApproval = dto.approvedPrincipalKes;
        if (typeof requestedApproval !== 'number' ||
          !Number.isSafeInteger(requestedApproval) ||
          requestedApproval < acceptedProductTerms.minimumPrincipalKes ||
          requestedApproval > acceptedProductTerms.maximumPrincipalKes ||
          requestedApproval > application.requestedPrincipalKes) {
          throw new UnprocessableEntityException('Approved principal is required and must be within the accepted product limits.');
        }
        approvedPrincipalKes = requestedApproval;
        approvedChargesKes = Math.ceil((requestedApproval * acceptedProductTerms.interestRateBps) / 10_000) +
          acceptedProductTerms.flatFeeKes;
        if (!Number.isSafeInteger(approvedChargesKes + requestedApproval)) {
          throw new UnprocessableEntityException('Configured loan terms exceed supported monetary limits.');
        }
        approvedTermsSnapshot = {
          productName: acceptedProductTerms.productName,
          termsVersion: acceptedProductTerms.termsVersion,
          durationDays: acceptedProductTerms.durationDays,
          interestRateBps: acceptedProductTerms.interestRateBps,
          flatFeeKes: acceptedProductTerms.flatFeeKes,
          approvedPrincipalKes: requestedApproval,
          approvedChargesKes,
          totalRepayableKes: requestedApproval + approvedChargesKes,
        };
        status = LoanApplicationStatus.WAITING_FOR_DISBURSEMENT;
      } else if (dto.decision === 'REJECT') {
        status = LoanApplicationStatus.REJECTED;
      } else {
        status = LoanApplicationStatus.ADDITIONAL_INFORMATION_REQUIRED;
      }

      const now = new Date();
      const changed = await tx.loanApplication.updateMany({
        where: { id, status: { in: [LoanApplicationStatus.SUBMITTED, LoanApplicationStatus.UNDER_REVIEW] } },
        data: {
          status,
          reviewerId,
          reviewedAt: now,
          decisionReason: reason,
          requestedInformation: dto.decision === 'REQUEST_INFORMATION' ? reason : null,
          approvedPrincipalKes: approvedPrincipalKes ?? null,
          approvedChargesKes: approvedChargesKes ?? null,
          approvedTermsSnapshot: approvedTermsSnapshot ?? Prisma.JsonNull,
        },
      });
      if (changed.count !== 1) throw new ConflictException('This application is no longer awaiting review.');
      if (dto.decision === 'APPROVE') {
        await tx.loan.create({
          data: {
            applicationId: id,
            userId: application.userId,
            principalKes: approvedPrincipalKes!,
            chargesKes: approvedChargesKes!,
            totalRepayableKes: approvedPrincipalKes! + approvedChargesKes!,
            outstandingKes: approvedPrincipalKes! + approvedChargesKes!,
            acceptedTermsVersion: approvedTermsSnapshot!.termsVersion,
            status: LoanStatus.DISBURSEMENT_PENDING,
          },
        });
      }
      await tx.adminAuditLog.create({
        data: {
          superadminId: reviewerId,
          action: `LOAN_APPLICATION_${dto.decision}`,
          subjectType: 'LOAN_APPLICATION',
          subjectId: id,
          outcome: 'SUCCESS',
          reason,
          details: dto.decision === 'APPROVE' ? {
            approvedPrincipalKes: approvedPrincipalKes!,
            approvedChargesKes: approvedChargesKes!,
            totalRepayableKes: approvedPrincipalKes! + approvedChargesKes!,
            termsVersion: approvedTermsSnapshot!.termsVersion,
          } : undefined,
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return { id, status, approvedPrincipalKes, approvedChargesKes, approvedTermsSnapshot, reason };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async confirmManualDisbursement(
    loanId: string,
    dto: ConfirmManualDisbursementDto,
    reviewerId: string,
    ipAddress?: string,
  ) {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loanId },
      include: { application: true, disbursement: true },
    });
    if (!loan) throw new NotFoundException('Loan account was not found.');
    if (loan.status !== LoanStatus.DISBURSEMENT_PENDING || loan.disbursement) {
      throw new ConflictException('This loan is not awaiting manual disbursement confirmation.');
    }
    const [cashAccount, receivableAccount] = await Promise.all([
      this.prisma.ledgerAccount.findUnique({ where: { code: 'DISBURSEMENT_CASH' } }),
      this.prisma.ledgerAccount.findUnique({ where: { code: 'LOAN_RECEIVABLE' } }),
    ]);
    if (
      !cashAccount || !receivableAccount ||
      !cashAccount.isActive || !receivableAccount.isActive ||
      cashAccount.currency !== 'KES' || receivableAccount.currency !== 'KES' ||
      cashAccount.accountType !== 'ASSET' || receivableAccount.accountType !== 'ASSET'
    ) {
      throw new ConflictException('Required KES disbursement ledger accounts are not configured.');
    }
    const now = new Date();
    const approvedTerms = this.parseApprovedTermsSnapshot(loan.application.approvedTermsSnapshot);
    if (
      !approvedTerms ||
      approvedTerms.approvedPrincipalKes !== loan.principalKes ||
      approvedTerms.approvedChargesKes !== loan.chargesKes ||
      approvedTerms.totalRepayableKes !== loan.totalRepayableKes
    ) {
      throw new ConflictException('The accepted loan terms snapshot is unavailable or inconsistent.');
    }
    const dueAt = new Date(now.getTime() + approvedTerms.durationDays * 24 * 60 * 60 * 1000);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.loan.updateMany({
          where: { id: loanId, status: LoanStatus.DISBURSEMENT_PENDING },
          data: { status: LoanStatus.DISBURSED, disbursedAt: now },
        });
        if (claimed.count !== 1) throw new ConflictException('This loan has already been disbursed or cancelled.');
        const disbursement = await tx.loanDisbursement.create({
          data: {
            loanId,
            amountKes: loan.principalKes,
            status: 'CONFIRMED',
            paymentReference: dto.paymentReference.trim(),
            recordedById: reviewerId,
            reason: dto.reason.trim(),
            confirmedAt: now,
          },
        });
        await tx.repaymentSchedule.create({
          data: {
            loanId,
            sequence: 1,
            principalDueKes: loan.principalKes,
            chargesDueKes: loan.chargesKes,
            amountDueKes: loan.totalRepayableKes,
            dueAt,
          },
        });
        await this.ledger.postWithinTransaction(tx, {
          idempotencyKey: `loan-disbursement:${loanId}`,
          transactionType: 'LOAN_DISBURSEMENT',
          actorType: 'SUPERADMIN',
          actorId: reviewerId,
          reason: dto.reason.trim(),
          lines: [
            { accountId: receivableAccount.id, debitKes: loan.principalKes, creditKes: 0 },
            { accountId: cashAccount.id, debitKes: 0, creditKes: loan.principalKes },
          ],
        });
        await tx.adminAuditLog.create({
          data: {
            superadminId: reviewerId,
            action: 'LOAN_MANUAL_DISBURSEMENT_CONFIRMED',
            subjectType: 'LOAN',
            subjectId: loanId,
            outcome: 'SUCCESS',
            reason: dto.reason.trim(),
            ipAddress: ipAddress?.slice(0, 64),
          },
        });
        return { disbursement, dueAt, status: LoanStatus.DISBURSED };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      ) {
        throw new ConflictException('This loan has already been disbursed or the confirmation reference has been used.');
      }
      throw error;
    }
  }

  private validateProductBounds(minimum: number, maximum: number): void {
    if (minimum > maximum) throw new UnprocessableEntityException('Minimum principal cannot exceed maximum principal.');
  }

  private parseAcceptedProductTerms(
    applicationData: Prisma.JsonValue,
  ): {
    productName: string;
    termsVersion: string;
    minimumPrincipalKes: number;
    maximumPrincipalKes: number;
    durationDays: number;
    interestRateBps: number;
    flatFeeKes: number;
  } {
    if (!applicationData || typeof applicationData !== 'object' || Array.isArray(applicationData)) {
      throw new ConflictException('This application has no accepted product-terms snapshot and requires staff review.');
    }
    const snapshot = applicationData.productTermsSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new ConflictException('This application has no accepted product-terms snapshot and requires staff review.');
    }
    const {
      productName,
      termsVersion,
      minimumPrincipalKes,
      maximumPrincipalKes,
      durationDays,
      interestRateBps,
      flatFeeKes,
    } = snapshot;
    if (
      typeof productName !== 'string' || productName.trim().length === 0 ||
      typeof termsVersion !== 'string' || termsVersion.trim().length === 0 ||
      typeof minimumPrincipalKes !== 'number' || !Number.isSafeInteger(minimumPrincipalKes) ||
      typeof maximumPrincipalKes !== 'number' || !Number.isSafeInteger(maximumPrincipalKes) ||
      typeof durationDays !== 'number' || !Number.isSafeInteger(durationDays) ||
      typeof interestRateBps !== 'number' || !Number.isSafeInteger(interestRateBps) ||
      typeof flatFeeKes !== 'number' || !Number.isSafeInteger(flatFeeKes) ||
      minimumPrincipalKes < 1 || maximumPrincipalKes < minimumPrincipalKes ||
      durationDays < 1 || interestRateBps < 0 || flatFeeKes < 0
    ) {
      throw new ConflictException('The accepted product terms snapshot is invalid and requires staff review.');
    }
    return {
      productName,
      termsVersion,
      minimumPrincipalKes,
      maximumPrincipalKes,
      durationDays,
      interestRateBps,
      flatFeeKes,
    };
  }

  private parseApprovedTermsSnapshot(value: Prisma.JsonValue | null): ApprovedLoanTermsSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value;
    const {
      productName,
      termsVersion,
      durationDays,
      interestRateBps,
      flatFeeKes,
      approvedPrincipalKes,
      approvedChargesKes,
      totalRepayableKes,
    } = snapshot;
    if (
      typeof productName !== 'string' ||
      productName.trim().length === 0 ||
      typeof termsVersion !== 'string' ||
      termsVersion.trim().length === 0 ||
      typeof durationDays !== 'number' ||
      !Number.isSafeInteger(durationDays) ||
      typeof interestRateBps !== 'number' ||
      !Number.isSafeInteger(interestRateBps) ||
      typeof flatFeeKes !== 'number' ||
      !Number.isSafeInteger(flatFeeKes) ||
      typeof approvedPrincipalKes !== 'number' ||
      !Number.isSafeInteger(approvedPrincipalKes) ||
      typeof approvedChargesKes !== 'number' ||
      !Number.isSafeInteger(approvedChargesKes) ||
      typeof totalRepayableKes !== 'number' ||
      !Number.isSafeInteger(totalRepayableKes)
    ) return null;
    if (
      durationDays < 1 ||
      interestRateBps < 0 ||
      flatFeeKes < 0 ||
      approvedPrincipalKes < 1 ||
      approvedChargesKes < 0 ||
      totalRepayableKes !== approvedPrincipalKes + approvedChargesKes ||
      approvedChargesKes !== Math.ceil(approvedPrincipalKes * interestRateBps / 10_000) + flatFeeKes
    ) return null;
    return {
      productName,
      termsVersion,
      durationDays,
      interestRateBps,
      flatFeeKes,
      approvedPrincipalKes,
      approvedChargesKes,
      totalRepayableKes,
    };
  }
}
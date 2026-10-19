import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LedgerAccountType, LoanApplicationStatus, LoanStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { normalizeKenyaPhone } from '../auth/security.util';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { getLoanProcessingFeePolicy, LOAN_PROCESSING_FEE_KES } from '../payments/processing-fee.constants';
import { AcceptLoanOfferDto, ConfirmManualDisbursementDto, CreateLoanApplicationDto, CreateLoanProductDto, ReviewLoanApplicationDto, UpdateLoanProductDto } from './loan.dto';

const OPEN_LOAN_STATUSES = [
  LoanStatus.DISBURSEMENT_PENDING,
  LoanStatus.DISBURSED,
  LoanStatus.REPAYMENT_IN_PROGRESS,
  LoanStatus.OVERDUE,
];

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
    const openLoan = await this.prisma.loan.findFirst({
      where: { userId, status: { in: OPEN_LOAN_STATUSES } },
      select: { id: true },
    });
    if (openLoan) throw new ConflictException('An unpaid loan is already recorded for this account.');
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
    const existing = await this.prisma.loanApplication.findUnique({ where: { creationIdempotencyKey } });
    if (existing) {
      if (existing.creationRequestHash !== creationRequestHash) {
        throw new ConflictException('The idempotency key has already been used.');
      }
      return {
        id: existing.id,
        status: existing.status,
        requestedPrincipalKes: existing.requestedPrincipalKes,
        createdAt: existing.createdAt,
        product: { name: product.name },
      };
    }
    try {
      return await this.prisma.loanApplication.create({
        data: {
          creationIdempotencyKey,
          creationRequestHash,
          userId,
          productId: product.id,
          requestedPrincipalKes: dto.requestedPrincipalKes,
          status: LoanApplicationStatus.DRAFT,
          applicationData,
        },
        select: { id: true, status: true, requestedPrincipalKes: true, createdAt: true, product: { select: { name: true } } },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.loanApplication.findUnique({ where: { creationIdempotencyKey } });
        if (duplicate?.creationRequestHash === creationRequestHash) {
          return {
            id: duplicate.id,
            status: duplicate.status,
            requestedPrincipalKes: duplicate.requestedPrincipalKes,
            createdAt: duplicate.createdAt,
            product: { name: product.name },
          };
        }
        if (duplicate) throw new ConflictException('The idempotency key has already been used.');
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
        processingFeePayment: {
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
        processingFeePayment: {
          select: { internalReference: true, status: true, amountKes: true, receiptReference: true, confirmedAt: true },
        },
      },
      orderBy: { submittedAt: 'asc' },
    });
  }

  async getProcessingFeeSettings() {
    const [setting, clearing] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' } }),
      this.prisma.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } }),
    ]);
    const revenueAccountCode = typeof setting?.value === 'string' ? setting.value : null;
    const revenue = revenueAccountCode
      ? await this.prisma.ledgerAccount.findUnique({ where: { code: revenueAccountCode } })
      : null;
    const policy = getLoanProcessingFeePolicy();
    const unavailableReasons: string[] = [];
    const clearingReady = Boolean(clearing?.isActive && clearing.currency === 'KES' && clearing.accountType === LedgerAccountType.ASSET);
    const revenueReady = Boolean(revenue?.isActive && revenue.currency === 'KES' && revenue.accountType === LedgerAccountType.REVENUE);
    if (policy.status !== 'CONFIGURED') unavailableReasons.push('Approved processing-fee policy approval, version, or disclosure is not configured.');
    if (!clearingReady) {
      unavailableReasons.push('An active KES asset account with code MPESA_CLEARING is required.');
    }
    if (!revenueAccountCode) unavailableReasons.push('A processing-fee revenue account has not been selected.');
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
    const account = await this.prisma.ledgerAccount.findUnique({ where: { code: normalizedCode } });
    const clearing = await this.prisma.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } });
    if (!account || !account.isActive || account.currency !== 'KES' || account.accountType !== 'REVENUE' ||
      !clearing || !clearing.isActive || clearing.currency !== 'KES' || clearing.accountType !== 'ASSET') {
      throw new UnprocessableEntityException('An active KES revenue account and M-Pesa clearing account are required.');
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
    const application = await this.prisma.loanApplication.findUnique({
      where: { id },
    });
    if (!application) throw new NotFoundException('Loan application was not found.');
    if (
      application.status !== LoanApplicationStatus.SUBMITTED &&
      application.status !== LoanApplicationStatus.UNDER_REVIEW
    ) {
      throw new ConflictException('This application is no longer awaiting review.');
    }

    let status: LoanApplicationStatus;
    let approvedPrincipalKes: number | undefined;
    let approvedChargesKes: number | undefined;
    let approvedTermsSnapshot: ApprovedLoanTermsSnapshot | undefined;
    if (dto.decision === 'APPROVE') {
      const acceptedProductTerms = this.parseAcceptedProductTerms(application.applicationData);
      approvedPrincipalKes = dto.approvedPrincipalKes ?? application.requestedPrincipalKes;
      if (
        approvedPrincipalKes < acceptedProductTerms.minimumPrincipalKes ||
        approvedPrincipalKes > acceptedProductTerms.maximumPrincipalKes ||
        approvedPrincipalKes > application.requestedPrincipalKes
      ) {
        throw new UnprocessableEntityException('Approved principal is outside the accepted product limits.');
      }
      approvedChargesKes = Math.ceil((approvedPrincipalKes * acceptedProductTerms.interestRateBps) / 10_000) +
        acceptedProductTerms.flatFeeKes;
      if (!Number.isSafeInteger(approvedChargesKes + approvedPrincipalKes)) {
        throw new UnprocessableEntityException('Configured loan terms exceed supported monetary limits.');
      }
      approvedTermsSnapshot = {
        productName: acceptedProductTerms.productName,
        termsVersion: acceptedProductTerms.termsVersion,
        durationDays: acceptedProductTerms.durationDays,
        interestRateBps: acceptedProductTerms.interestRateBps,
        flatFeeKes: acceptedProductTerms.flatFeeKes,
        approvedPrincipalKes,
        approvedChargesKes,
        totalRepayableKes: approvedPrincipalKes + approvedChargesKes,
      };
      status = LoanApplicationStatus.APPROVED;
    } else if (dto.decision === 'REJECT') {
      status = LoanApplicationStatus.REJECTED;
    } else {
      status = LoanApplicationStatus.ADDITIONAL_INFORMATION_REQUIRED;
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.loanApplication.updateMany({
        where: { id, status: { in: [LoanApplicationStatus.SUBMITTED, LoanApplicationStatus.UNDER_REVIEW] } },
        data: {
          status,
          reviewerId,
          reviewedAt: now,
          decisionReason: dto.reason.trim(),
          requestedInformation: dto.decision === 'REQUEST_INFORMATION' ? dto.reason.trim() : null,
          approvedPrincipalKes: approvedPrincipalKes ?? null,
          approvedChargesKes: approvedChargesKes ?? null,
          approvedTermsSnapshot: approvedTermsSnapshot ?? Prisma.JsonNull,
        },
      });
      if (changed.count !== 1) throw new ConflictException('This application is no longer awaiting review.');
      await tx.adminAuditLog.create({
        data: { superadminId: reviewerId, action: `LOAN_APPLICATION_${dto.decision}`, subjectType: 'LOAN_APPLICATION', subjectId: id, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
      });
      return { id, status, approvedPrincipalKes, approvedChargesKes, approvedTermsSnapshot, reason: dto.reason.trim() };
    });
  }

  async acceptOffer(userId: string, applicationId: string, dto: AcceptLoanOfferDto) {
    if (dto.termsAccepted !== true) throw new BadRequestException('Loan terms must be accepted.');
    const application = await this.prisma.loanApplication.findFirst({
      where: { id: applicationId, userId },
      include: { product: true },
    });
    if (!application || application.status !== LoanApplicationStatus.APPROVED) {
      throw new ConflictException('No current loan offer is available for acceptance.');
    }
    if (application.offerExpiresAt && application.offerExpiresAt <= new Date()) {
      throw new ConflictException('This loan offer has expired.');
    }
    const approvedPrincipalKes = application.approvedPrincipalKes;
    const approvedChargesKes = application.approvedChargesKes;
    if (approvedPrincipalKes === null || approvedChargesKes === null) {
      throw new ConflictException('Approved loan terms are incomplete.');
    }
    const approvedTerms = this.parseApprovedTermsSnapshot(application.approvedTermsSnapshot);
    if (
      !approvedTerms ||
      approvedTerms.approvedPrincipalKes !== approvedPrincipalKes ||
      approvedTerms.approvedChargesKes !== approvedChargesKes
    ) {
      throw new ConflictException('This offer has no verified terms snapshot and cannot be accepted safely.');
    }
    const totalRepayableKes = approvedPrincipalKes + approvedChargesKes;
    if (!Number.isSafeInteger(totalRepayableKes)) {
      throw new UnprocessableEntityException('Approved loan terms exceed supported monetary limits.');
    }
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.loanApplication.updateMany({
        where: { id: applicationId, userId, status: LoanApplicationStatus.APPROVED },
        data: { status: LoanApplicationStatus.ACCEPTED, acceptedAt: now },
      });
      if (claimed.count !== 1) throw new ConflictException('This loan offer has already been accepted or withdrawn.');
      const loan = await tx.loan.create({
        data: {
          applicationId,
          userId,
          principalKes: approvedPrincipalKes,
          chargesKes: approvedChargesKes,
          totalRepayableKes,
          outstandingKes: totalRepayableKes,
          acceptedTermsVersion: approvedTerms.termsVersion,
        },
      });
      await tx.authAuditLog.create({
        data: { actorType: 'CUSTOMER', actorId: userId, action: 'LOAN_OFFER_ACCEPTED', outcome: 'SUCCESS' },
      });
      return loan;
    });
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
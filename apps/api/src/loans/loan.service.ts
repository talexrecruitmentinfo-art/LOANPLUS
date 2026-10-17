import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LoanApplicationStatus, LoanStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptLoanOfferDto, CreateLoanApplicationDto, CreateLoanProductDto, ReviewLoanApplicationDto, UpdateLoanProductDto } from './loan.dto';

const OPEN_LOAN_STATUSES = [
  LoanStatus.DISBURSEMENT_PENDING,
  LoanStatus.DISBURSED,
  LoanStatus.REPAYMENT_IN_PROGRESS,
  LoanStatus.OVERDUE,
];

@Injectable()
export class LoanService {
  constructor(private readonly prisma: PrismaService) {}

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

  async createApplication(userId: string, dto: CreateLoanApplicationDto) {
    const [user, product] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, activationStatus: true } }),
      this.prisma.loanProduct.findFirst({ where: { id: dto.productId, isAvailable: true } }),
    ]);
    if (!user || !user.isActive) throw new ForbiddenException('This account cannot apply for a loan.');
    if (user.activationStatus !== 'ACTIVE') {
      throw new ForbiddenException('Complete confirmed account activation before applying.');
    }
    if (!product) throw new NotFoundException('Loan product is unavailable.');
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
    return this.prisma.loanApplication.create({
      data: { userId, productId: product.id, requestedPrincipalKes: dto.requestedPrincipalKes, applicationData: {} },
      select: { id: true, status: true, requestedPrincipalKes: true, submittedAt: true, product: { select: { name: true } } },
    });
  }

  async listMyApplications(userId: string) {
    return this.prisma.loanApplication.findMany({
      where: { userId },
      select: {
        id: true,
        requestedPrincipalKes: true,
        approvedPrincipalKes: true,
        approvedChargesKes: true,
        status: true,
        decisionReason: true,
        requestedInformation: true,
        submittedAt: true,
        reviewedAt: true,
        offerExpiresAt: true,
        product: { select: { name: true, durationDays: true, termsVersion: true } },
      },
      orderBy: { submittedAt: 'desc' },
    });
  }

  listApplicationsForReview() {
    return this.prisma.loanApplication.findMany({
      include: {
        product: true,
        user: { select: { id: true, fullName: true, email: true, activationStatus: true, identityStatus: true } },
      },
      orderBy: { submittedAt: 'asc' },
    });
  }

  async reviewApplication(id: string, dto: ReviewLoanApplicationDto, reviewerId: string, ipAddress?: string) {
    const application = await this.prisma.loanApplication.findUnique({
      where: { id },
      include: { product: true },
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
    if (dto.decision === 'APPROVE') {
      approvedPrincipalKes = dto.approvedPrincipalKes ?? application.requestedPrincipalKes;
      if (
        approvedPrincipalKes < application.product.minimumPrincipalKes ||
        approvedPrincipalKes > application.product.maximumPrincipalKes ||
        approvedPrincipalKes > application.requestedPrincipalKes
      ) {
        throw new UnprocessableEntityException('Approved principal is outside the requested or configured limits.');
      }
      approvedChargesKes = Math.ceil((approvedPrincipalKes * application.product.interestRateBps) / 10_000) +
        application.product.flatFeeKes;
      if (!Number.isSafeInteger(approvedChargesKes + approvedPrincipalKes)) {
        throw new UnprocessableEntityException('Configured loan terms exceed supported monetary limits.');
      }
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
        },
      });
      if (changed.count !== 1) throw new ConflictException('This application is no longer awaiting review.');
      await tx.adminAuditLog.create({
        data: { superadminId: reviewerId, action: `LOAN_APPLICATION_${dto.decision}`, subjectType: 'LOAN_APPLICATION', subjectId: id, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
      });
      return { id, status, approvedPrincipalKes, approvedChargesKes, reason: dto.reason.trim() };
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
          acceptedTermsVersion: application.product.termsVersion,
        },
      });
      await tx.authAuditLog.create({
        data: { actorType: 'CUSTOMER', actorId: userId, action: 'LOAN_OFFER_ACCEPTED', outcome: 'SUCCESS' },
      });
      return loan;
    });
  }

  private validateProductBounds(minimum: number, maximum: number): void {
    if (minimum > maximum) throw new UnprocessableEntityException('Minimum principal cannot exceed maximum principal.');
  }
}
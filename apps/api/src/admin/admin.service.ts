import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  IdentityStatus,
  LoanApplicationStatus,
  LoanStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
  ReferralStatus,
  SupportTicketStatus,
  WithdrawalStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 3 ? `***${digits.slice(-3)}` : '***';
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard() {
    const [
      totalCustomers,
      activeCustomers,
      pendingIdentityReviews,
      pendingProcessingFees,
      confirmedProcessingFees,
      pendingPayments,
      failedPayments,
      submittedApplications,
      approvedApplications,
      rejectedApplications,
      disbursedLoans,
      overdueLoans,
      repaidLoans,
      pendingWithdrawals,
      completedWithdrawals,
      referralRegistrations,
      qualifiedReferrals,
      pendingRewards,
      openSupportTickets,
      pendingLegacyProcessing,
      verifiedPaymentTotals,
      walletLiabilityEntries,
      recentActivity,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { identityStatus: { in: [IdentityStatus.PENDING, IdentityStatus.NEEDS_REVIEW] } } }),
      this.prisma.paymentTransaction.count({ where: { type: PaymentType.LOAN_PROCESSING_FEE, status: PaymentStatus.PENDING } }),
      this.prisma.paymentTransaction.count({ where: { type: PaymentType.LOAN_PROCESSING_FEE, status: PaymentStatus.CONFIRMED } }),
      this.prisma.paymentTransaction.count({ where: { status: PaymentStatus.PENDING } }),
      this.prisma.paymentTransaction.count({ where: { status: PaymentStatus.FAILED } }),
      this.prisma.loanApplication.count({ where: { status: { in: [LoanApplicationStatus.SUBMITTED, LoanApplicationStatus.UNDER_REVIEW] } } }),
      this.prisma.loanApplication.count({ where: { status: { in: [LoanApplicationStatus.APPROVED, LoanApplicationStatus.WAITING_FOR_DISBURSEMENT] } } }),
      this.prisma.loanApplication.count({ where: { status: LoanApplicationStatus.REJECTED } }),
      this.prisma.loan.count({ where: { status: { in: [LoanStatus.DISBURSED, LoanStatus.REPAYMENT_IN_PROGRESS] } } }),
      this.prisma.loan.count({ where: { status: LoanStatus.OVERDUE } }),
      this.prisma.loan.count({ where: { status: LoanStatus.REPAID } }),
      this.prisma.withdrawalRequest.count({ where: { status: { in: [WithdrawalStatus.REQUESTED, WithdrawalStatus.UNDER_REVIEW] } } }),
      this.prisma.withdrawalRequest.count({ where: { status: WithdrawalStatus.COMPLETED } }),
      this.prisma.referral.count({ where: { status: { in: [ReferralStatus.REGISTERED, ReferralStatus.ACTIVATION_PENDING] } } }),
      this.prisma.referral.count({ where: { status: { in: [ReferralStatus.QUALIFIED, ReferralStatus.REWARDED] } } }),
      this.prisma.referralReward.count({ where: { status: 'PENDING' } }),
      this.prisma.supportTicket.count({ where: { status: { in: [SupportTicketStatus.OPEN, SupportTicketStatus.IN_PROGRESS, SupportTicketStatus.WAITING_FOR_CUSTOMER] } } }),
      this.prisma.paymentTransaction.count({ where: { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' } }),
      this.prisma.paymentTransaction.aggregate({
        where: {
          status: PaymentStatus.CONFIRMED,
          currency: 'KES',
          type: { in: [PaymentType.ACTIVATION, PaymentType.LOAN_PROCESSING_FEE, PaymentType.REPAYMENT] },
        },
        _sum: { amountKes: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: {
          account: { userId: { not: null }, accountType: 'LIABILITY', currency: 'KES', isActive: true },
          transaction: { status: 'POSTED' },
        },
        _sum: { creditKes: true, debitKes: true },
      }),
      this.prisma.adminAuditLog.findMany({
        select: { id: true, action: true, subjectType: true, subjectId: true, outcome: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      metrics: {
        customers: { total: totalCustomers, active: activeCustomers },
        pendingIdentityReviews,
        loanProcessingFees: {
          pending: pendingProcessingFees,
          confirmed: confirmedProcessingFees,
        },
        paymentReconciliation: {
          pending: pendingPayments + pendingLegacyProcessing,
          failed: failedPayments - pendingLegacyProcessing,
        },
        verifiedPaymentsKes: verifiedPaymentTotals._sum.amountKes ?? 0,
        walletLiabilitiesKes: (walletLiabilityEntries._sum.creditKes ?? 0) - (walletLiabilityEntries._sum.debitKes ?? 0),
        loanApplications: { pending: submittedApplications, approved: approvedApplications, rejected: rejectedApplications },
        loans: { disbursed: disbursedLoans, overdue: overdueLoans, repaid: repaidLoans },
        withdrawals: { pending: pendingWithdrawals, completed: completedWithdrawals },
        referrals: { registered: referralRegistrations, qualified: qualifiedReferrals },
        pendingReferralRewards: pendingRewards,
        openSupportTickets,
      },
      recentActivity,
    };
  }

  async listCustomers(options: {
    search?: string;
    page: number;
    pageSize: number;
    accountStatus?: 'ACTIVE' | 'DISABLED';
    identityStatus?: IdentityStatus;
    registeredFrom?: Date;
    registeredTo?: Date;
  }) {
    const query = options.search?.trim().slice(0, 100);
    const filters: Prisma.UserWhereInput[] = [];
    if (query) {
      filters.push({
        OR: [
          { id: { contains: query, mode: 'insensitive' } },
          { fullName: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
      });
    }
    if (options.accountStatus) filters.push({ isActive: options.accountStatus === 'ACTIVE' });
    if (options.identityStatus) filters.push({ identityStatus: options.identityStatus });
    if (options.registeredFrom || options.registeredTo) {
      filters.push({
        createdAt: {
          ...(options.registeredFrom ? { gte: options.registeredFrom } : {}),
          ...(options.registeredTo ? { lte: options.registeredTo } : {}),
        },
      });
    }
    const where: Prisma.UserWhereInput = filters.length ? { AND: filters } : {};
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          identityStatus: true,
          isActive: true,
          createdAt: true,
          _count: { select: { paymentTransactions: true, loans: true, loanApplications: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
    ]);
    const items = rows.map(({ phone, ...customer }) => ({
      ...customer,
      phoneMasked: maskPhoneNumber(phone),
    }));
    return {
      items,
      total,
      page: options.page,
      pageSize: options.pageSize,
      pageCount: Math.ceil(total / options.pageSize),
    };
  }

  async listPayments(options: {
    search?: string;
    status?: PaymentStatus;
    type?: PaymentType;
    page: number;
    pageSize: number;
    from?: Date;
    to?: Date;
  }) {
    const query = options.search?.trim().slice(0, 100);
    const filters: Prisma.PaymentTransactionWhereInput[] = [];
    if (options.status === PaymentStatus.PENDING) {
      filters.push({
        OR: [
          { status: PaymentStatus.PENDING },
          { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
        ],
      });
    } else if (options.status) {
      filters.push({ status: options.status });
    }
    if (options.type) filters.push({ type: options.type });
    if (options.from || options.to) {
      filters.push({
        createdAt: {
          ...(options.from ? { gte: options.from } : {}),
          ...(options.to ? { lte: options.to } : {}),
        },
      });
    }
    if (query) {
      filters.push({
        OR: [
          { internalReference: { contains: query, mode: 'insensitive' } },
          { providerReference: { contains: query, mode: 'insensitive' } },
          { receiptReference: { contains: query, mode: 'insensitive' } },
          { failureCode: { contains: query, mode: 'insensitive' } },
          { activationRequest: { is: { checkoutRequestId: { contains: query, mode: 'insensitive' } } } },
          { activationRequest: { is: { merchantRequestId: { contains: query, mode: 'insensitive' } } } },
          { user: { is: { id: { contains: query, mode: 'insensitive' } } } },
          { user: { is: { fullName: { contains: query, mode: 'insensitive' } } } },
          { user: { is: { email: { contains: query, mode: 'insensitive' } } } },
        ],
      });
    }
    const where: Prisma.PaymentTransactionWhereInput = filters.length ? { AND: filters } : {};
    const [total, items] = await Promise.all([
      this.prisma.paymentTransaction.count({ where }),
      this.prisma.paymentTransaction.findMany({
        where,
        select: {
          internalReference: true,
          type: true,
          amountKes: true,
          currency: true,
          status: true,
          providerReference: true,
          receiptReference: true,
          failureCode: true,
          confirmedAt: true,
          createdAt: true,
          user: { select: { fullName: true, email: true } },
          activationRequest: {
            select: {
              checkoutRequestId: true,
              merchantRequestId: true,
              callbackEvents: { select: { providerResultCode: true, providerReceiptReference: true, receivedAt: true }, orderBy: { receivedAt: 'desc' }, take: 5 },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { internalReference: 'desc' }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
    ]);
    return {
      items,
      total,
      page: options.page,
      pageSize: options.pageSize,
      pageCount: Math.ceil(total / options.pageSize),
    };
  }

  async getCustomerDetails(id: string) {
    const customer = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        identityStatus: true,
        activationStatus: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            loanApplications: true,
            loans: true,
            paymentTransactions: true,
            referralsSent: true,
            supportTickets: true,
            withdrawalRequests: true,
          },
        },
        loanApplications: {
          select: {
            id: true,
            status: true,
            requestedPrincipalKes: true,
            approvedPrincipalKes: true,
            decisionReason: true,
            submittedAt: true,
            createdAt: true,
            product: { select: { name: true } },
            processingFeePayments: {
              where: { type: PaymentType.LOAN_PROCESSING_FEE },
              orderBy: { createdAt: 'desc' },
              select: { internalReference: true, status: true, amountKes: true, receiptReference: true, confirmedAt: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        loans: {
          select: {
            id: true,
            status: true,
            principalKes: true,
            outstandingKes: true,
            totalRepayableKes: true,
            disbursedAt: true,
            repaidAt: true,
            createdAt: true,
            repayments: {
              select: {
                amountKes: true,
                createdAt: true,
                paymentTransaction: { select: { internalReference: true } },
              },
              orderBy: { createdAt: 'desc' },
              take: 10,
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        paymentTransactions: {
          select: {
            internalReference: true,
            type: true,
            amountKes: true,
            currency: true,
            status: true,
            providerReference: true,
            receiptReference: true,
            failureCode: true,
            createdAt: true,
            confirmedAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        referralsSent: {
          select: {
            id: true,
            status: true,
            createdAt: true,
            qualifiedAt: true,
            reward: { select: { amountKes: true, status: true, createdAt: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        supportTickets: {
          select: { reference: true, subject: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer account was not found.');
    const identityReview = await this.prisma.adminAuditLog.findFirst({
      where: {
        subjectType: 'CUSTOMER',
        subjectId: id,
        action: { in: ['CUSTOMER_IDENTITY_VERIFIED', 'CUSTOMER_IDENTITY_REJECTED'] },
        outcome: 'SUCCESS',
      },
      select: {
        action: true,
        createdAt: true,
        superadmin: { select: { email: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return {
      ...customer,
      identityReview: identityReview
        ? {
          status: identityReview.action === 'CUSTOMER_IDENTITY_VERIFIED' ? IdentityStatus.VERIFIED : IdentityStatus.REJECTED,
          reviewerEmail: identityReview.superadmin?.email ?? null,
          reviewedAt: identityReview.createdAt,
        }
        : null,
    };
  }

  async updateCustomerIdentityStatus(
    id: string,
    status: IdentityStatus,
    reason: string,
    reviewConfirmed: boolean,
    adminId: string,
    ip?: string,
  ) {
    const normalizedReason = reason.trim().replace(/\s+/g, ' ');
    if (status !== IdentityStatus.VERIFIED && status !== IdentityStatus.REJECTED) {
      throw new BadRequestException('Identity status decisions must be VERIFIED or REJECTED.');
    }
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw new BadRequestException('A decision reason between 10 and 500 characters is required.');
    }
    if (/\b\d(?:[\s-]*\d){6,11}\b/.test(normalizedReason)) {
      throw new BadRequestException('Do not include identity or contact numbers in the review note.');
    }
    if (reviewConfirmed !== true) {
      throw new BadRequestException('Confirm that the required identity review has been completed.');
    }

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, identityStatus: true },
      });
      if (!customer || customer.role !== 'NORMAL_USER') {
        throw new NotFoundException('Customer account was not found.');
      }
      if (customer.identityStatus === status) {
        return { id, identityStatus: status, changed: false };
      }
      if (customer.identityStatus === IdentityStatus.VERIFIED) {
        throw new ConflictException('A verified identity cannot be changed through this decision workflow.');
      }
      if (status === IdentityStatus.REJECTED &&
        customer.identityStatus !== IdentityStatus.PENDING &&
        customer.identityStatus !== IdentityStatus.NEEDS_REVIEW) {
        throw new ConflictException('Only an identity review awaiting a decision can be rejected.');
      }

      const updated = await tx.user.updateMany({
        where: { id, role: 'NORMAL_USER', identityStatus: customer.identityStatus },
        data: { identityStatus: status },
      });
      if (updated.count !== 1) {
        const current = await tx.user.findUnique({
          where: { id },
          select: { id: true, role: true, identityStatus: true },
        });
        if (current?.role === 'NORMAL_USER' && current.identityStatus === status) {
          return { id, identityStatus: status, changed: false };
        }
        throw new ConflictException('Identity status changed during review. Reload the customer and try again.');
      }

      await tx.adminAuditLog.create({
        data: {
          superadminId: adminId,
          action: status === IdentityStatus.VERIFIED ? 'CUSTOMER_IDENTITY_VERIFIED' : 'CUSTOMER_IDENTITY_REJECTED',
          subjectType: 'CUSTOMER',
          subjectId: id,
          outcome: 'SUCCESS',
          reason: normalizedReason,
          createdAt: new Date(),
          details: {
            before: { identityStatus: customer.identityStatus },
            after: { identityStatus: status },
          },
          ipAddress: ip,
        },
      });
      return { id, identityStatus: status, changed: true };
    });
  }

  async updateCustomerStatus(id: string, isActive: boolean, reason: string, adminId: string, ip?: string) {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw new BadRequestException('A customer account status change reason is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, isActive: true },
      });
      if (!customer || customer.role !== 'NORMAL_USER') {
        throw new NotFoundException('Customer account was not found.');
      }
      if (customer.isActive === isActive) return { id, isActive, changed: false };

      const updated = await tx.user.update({ where: { id }, data: { isActive }, select: { id: true, isActive: true } });
      await tx.customerSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: adminId,
          action: isActive ? 'CUSTOMER_REACTIVATED' : 'CUSTOMER_SUSPENDED',
          subjectType: 'CUSTOMER',
          subjectId: id,
          outcome: 'SUCCESS',
          reason: normalizedReason,
          details: { before: { isActive: customer.isActive }, after: { isActive } },
          ipAddress: ip,
        },
      });
      return { ...updated, changed: true };
    });
  }

  async updateCustomerProfile(
    id: string,
    fullName: string,
    expectedUpdatedAt: string,
    reason: string,
    adminId: string,
    ip?: string,
  ) {
    const normalizedName = fullName.trim().replace(/\s+/g, ' ');
    const normalizedReason = reason.trim();
    const expectedDate = new Date(expectedUpdatedAt);
    if (normalizedName.length < 2 || normalizedName.length > 160) {
      throw new BadRequestException('Customer name must be between 2 and 160 characters.');
    }
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw new BadRequestException('A reason between 10 and 500 characters is required.');
    }
    if (Number.isNaN(expectedDate.getTime())) {
      throw new BadRequestException('The customer record version is invalid. Reload and try again.');
    }
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, fullName: true, updatedAt: true },
      });
      if (!customer || customer.role !== 'NORMAL_USER') {
        throw new NotFoundException('Customer account was not found.');
      }
      if (customer.updatedAt.getTime() !== expectedDate.getTime()) {
        throw new ConflictException('Customer details changed. Reload the record before editing.');
      }
      if (customer.fullName === normalizedName) {
        return { id, fullName: normalizedName, updatedAt: customer.updatedAt.toISOString(), changed: false };
      }
      const updated = await tx.user.updateMany({
        where: { id, role: 'NORMAL_USER', updatedAt: expectedDate },
        data: { fullName: normalizedName },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Customer details changed. Reload the record before editing.');
      }
      const saved = await tx.user.findUnique({
        where: { id },
        select: { id: true, fullName: true, updatedAt: true },
      });
      if (!saved) throw new NotFoundException('Customer account was not found.');
      await tx.adminAuditLog.create({
        data: {
          superadminId: adminId,
          action: 'CUSTOMER_PROFILE_UPDATED',
          subjectType: 'CUSTOMER',
          subjectId: id,
          outcome: 'SUCCESS',
          reason: normalizedReason,
          details: { before: { fullName: customer.fullName }, after: { fullName: saved.fullName } },
          ipAddress: ip,
        },
      });
      return { ...saved, updatedAt: saved.updatedAt.toISOString(), changed: true };
    });
  }

  async getAuditEvents(options: {
    search?: string;
    actorId?: string;
    action?: string;
    resourceType?: string;
    outcome?: string;
    from?: Date;
    to?: Date;
    page: number;
    pageSize: number;
  }) {
    const filters: Prisma.AdminAuditLogWhereInput[] = [];
    const query = options.search?.trim().slice(0, 100);
    if (query) {
      filters.push({
        OR: [
          { action: { contains: query, mode: 'insensitive' } },
          { subjectType: { contains: query, mode: 'insensitive' } },
          { subjectId: { contains: query, mode: 'insensitive' } },
          { reason: { contains: query, mode: 'insensitive' } },
          { superadmin: { is: { email: { contains: query, mode: 'insensitive' } } } },
        ],
      });
    }
    if (options.actorId?.trim()) filters.push({ superadminId: options.actorId.trim().slice(0, 80) });
    if (options.action?.trim()) filters.push({ action: { contains: options.action.trim().slice(0, 80), mode: 'insensitive' } });
    if (options.resourceType?.trim()) filters.push({ subjectType: options.resourceType.trim().slice(0, 80) });
    if (options.outcome?.trim()) filters.push({ outcome: options.outcome.trim().slice(0, 40) });
    if (options.from || options.to) {
      filters.push({
        createdAt: {
          ...(options.from ? { gte: options.from } : {}),
          ...(options.to ? { lte: options.to } : {}),
        },
      });
    }
    const where: Prisma.AdminAuditLogWhereInput = filters.length ? { AND: filters } : {};
    const [total, items] = await Promise.all([
      this.prisma.adminAuditLog.count({ where }),
      this.prisma.adminAuditLog.findMany({
        where,
        select: {
          id: true,
          action: true,
          subjectType: true,
          subjectId: true,
          outcome: true,
          reason: true,
          details: true,
          createdAt: true,
          superadmin: { select: { id: true, email: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
    ]);
    return {
      items: items.map((item) => item.action === 'CUSTOMER_IDENTITY_VERIFIED' || item.action === 'CUSTOMER_IDENTITY_REJECTED'
        ? { ...item, reason: null }
        : item),
      total,
      page: options.page,
      pageSize: options.pageSize,
      pageCount: Math.ceil(total / options.pageSize),
    };
  }
}
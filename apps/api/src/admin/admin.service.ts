import { Injectable } from '@nestjs/common';
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

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard() {
    const [
      totalCustomers,
      activeCustomers,
      pendingIdentityReviews,
      pendingActivations,
      confirmedActivations,
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
      this.prisma.user.count({ where: { isActive: true, activationStatus: 'ACTIVE' } }),
      this.prisma.user.count({ where: { identityStatus: { in: [IdentityStatus.PENDING, IdentityStatus.NEEDS_REVIEW] } } }),
      this.prisma.paymentTransaction.count({ where: { type: PaymentType.ACTIVATION, status: PaymentStatus.PENDING } }),
      this.prisma.paymentTransaction.count({ where: { type: PaymentType.ACTIVATION, status: PaymentStatus.CONFIRMED } }),
      this.prisma.paymentTransaction.count({ where: { status: PaymentStatus.PENDING } }),
      this.prisma.paymentTransaction.count({ where: { status: PaymentStatus.FAILED } }),
      this.prisma.loanApplication.count({ where: { status: { in: [LoanApplicationStatus.SUBMITTED, LoanApplicationStatus.UNDER_REVIEW] } } }),
      this.prisma.loanApplication.count({ where: { status: LoanApplicationStatus.APPROVED } }),
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
          type: { in: [PaymentType.ACTIVATION, PaymentType.REPAYMENT] },
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
        activationPayments: {
          pending: pendingActivations + pendingLegacyProcessing,
          confirmed: confirmedActivations,
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

  async listCustomers(search?: string) {
    const query = search?.trim().slice(0, 100);
    const where: Prisma.UserWhereInput = query
      ? {
          OR: [
            { fullName: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
          ],
        }
      : {};
    return this.prisma.user.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        identityStatus: true,
        activationStatus: true,
        isActive: true,
        createdAt: true,
        _count: { select: { paymentTransactions: true, loans: true, loanApplications: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async listPayments(search?: string, status?: PaymentStatus) {
    const query = search?.trim().slice(0, 100);
    const filters: Prisma.PaymentTransactionWhereInput[] = [];
    if (status === PaymentStatus.PENDING) {
      filters.push({
          OR: [
            { status: PaymentStatus.PENDING },
            { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
          ],
      });
    } else if (status) {
      filters.push({ status });
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
          { user: { is: { fullName: { contains: query, mode: 'insensitive' } } } },
          { user: { is: { email: { contains: query, mode: 'insensitive' } } } },
        ],
      });
    }
    const where: Prisma.PaymentTransactionWhereInput = filters.length ? { AND: filters } : {};
    return this.prisma.paymentTransaction.findMany({
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
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getAuditEvents(limit: number) {
    const safeLimit = Math.min(Math.max(Math.floor(limit || 50), 1), 200);
    return this.prisma.adminAuditLog.findMany({
      select: {
        id: true,
        action: true,
        subjectType: true,
        subjectId: true,
        outcome: true,
        reason: true,
        createdAt: true,
        superadmin: { select: { email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
    });
  }
}
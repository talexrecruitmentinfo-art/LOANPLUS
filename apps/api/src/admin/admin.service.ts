import { Injectable } from '@nestjs/common';
import {
  IdentityStatus,
  LoanApplicationStatus,
  LoanStatus,
  PaymentStatus,
  PaymentType,
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
        activationPayments: { pending: pendingActivations, confirmed: confirmedActivations },
        paymentReconciliation: { pending: pendingPayments, failed: failedPayments },
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
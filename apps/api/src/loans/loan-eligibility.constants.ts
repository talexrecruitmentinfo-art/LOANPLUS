import { LoanStatus } from '@prisma/client';

export const OUTSTANDING_LOAN_STATUSES = [
  LoanStatus.DISBURSED,
  LoanStatus.REPAYMENT_IN_PROGRESS,
  LoanStatus.OVERDUE,
];

export const APPROVAL_BLOCKING_LOAN_STATUSES = [
  LoanStatus.DISBURSEMENT_PENDING,
  ...OUTSTANDING_LOAN_STATUSES,
];

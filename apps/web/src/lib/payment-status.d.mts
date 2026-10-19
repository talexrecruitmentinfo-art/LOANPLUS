export type LoanApplicationStatusResult<T> =
  | { authenticated: false; applications: null; error: string }
  | { authenticated: true; applications: T[]; error: '' }
  | { authenticated: true; applications: null; error: string };

export const PAYMENT_STATUS_POLL_DELAYS_MS: readonly number[];

export function shouldPollLoanApplicationStatus(
  applications: Array<{
    status: string;
    processingFeePayments: Array<{ status: string; failureCode: string | null }>;
  }> | null,
): boolean;

export function loadLoanApplicationStatus<T>(
  apiRequest: <R>(path: string, init?: RequestInit) => Promise<R>,
): Promise<LoanApplicationStatusResult<T>>;

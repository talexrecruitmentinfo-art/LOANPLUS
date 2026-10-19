export type LoanApplicationStatusResult<T> =
  | { authenticated: false; applications: null; error: string }
  | { authenticated: true; applications: T[]; error: '' }
  | { authenticated: true; applications: null; error: string };

export function loadLoanApplicationStatus<T>(
  apiRequest: <R>(path: string, init?: RequestInit) => Promise<R>,
): Promise<LoanApplicationStatusResult<T>>;

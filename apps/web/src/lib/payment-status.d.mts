export interface UnresolvedFeeStatus {
  reference: string;
  status: string;
  amountKes: number;
  currency: string;
  initiationPhase: string | null;
  createdAt: string;
  message: string;
}

export type PaymentStatusResult =
  | { authenticated: false; error: string }
  | { authenticated: true; unresolvedFee: UnresolvedFeeStatus | null; error: '' }
  | { authenticated: true; error: string };

export function checkPaymentStatus(
  apiRequest: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<PaymentStatusResult>;

export function createPaymentStatusRefresher(
  apiRequest: <T>(path: string, init?: RequestInit) => Promise<T>,
  onResult: (result: PaymentStatusResult, isCurrent: () => boolean) => void | Promise<void>,
  onComplete: () => void,
): {
  refresh: () => Promise<void>;
  cancel: () => void;
};

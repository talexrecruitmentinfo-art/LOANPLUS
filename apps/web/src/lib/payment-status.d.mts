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

export const WALLET_DEPOSIT_POLL_INTERVAL_MS: number;
export const WALLET_DEPOSIT_POLL_WINDOW_MS: number;

export function pollWalletDepositStatus(options: {
  reference: string;
  getStatus: (reference: string, signal: AbortSignal) => Promise<{ status: string }>;
  onStatus: (result: { status: string }) => void | Promise<void>;
  signal: AbortSignal;
  startedAt?: number;
  now?: () => number;
  intervalMs?: number;
  maxDurationMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<'terminal' | 'timeout' | 'cancelled'>;

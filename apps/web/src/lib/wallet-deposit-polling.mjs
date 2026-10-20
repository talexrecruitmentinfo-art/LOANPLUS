export const WALLET_DEPOSIT_POLL_INTERVAL_MS = 5_000;
export const WALLET_DEPOSIT_POLL_WINDOW_MS = 60_000;

const TERMINAL_DEPOSIT_STATUSES = new Set(['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVERSED']);

export function shouldClearWalletDepositTracking({ reference, paymentStatus, canInitiateNewDeposit }) {
  return Boolean(reference) &&
    (TERMINAL_DEPOSIT_STATUSES.has(paymentStatus) || canInitiateNewDeposit === true);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Polling was cancelled.'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Polling was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollWalletDepositStatus({
  reference,
  getStatus,
  onStatus,
  signal,
  startedAt = Date.now(),
  now = Date.now,
  intervalMs = WALLET_DEPOSIT_POLL_INTERVAL_MS,
  maxDurationMs = WALLET_DEPOSIT_POLL_WINDOW_MS,
  sleep = wait,
}) {
  while (!signal.aborted) {
    const remainingMs = maxDurationMs - (now() - startedAt);
    if (remainingMs <= 0) return 'timeout';

    const requestController = new AbortController();
    const abortRequest = () => requestController.abort(signal.reason);
    signal.addEventListener('abort', abortRequest, { once: true });
    let deadlineExpired = false;
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      requestController.abort(new Error('Polling window expired.'));
    }, remainingMs);
    let result;
    try {
      result = await getStatus(reference, requestController.signal);
    } catch (error) {
      if (signal.aborted) return 'cancelled';
      if (deadlineExpired) return 'timeout';
      throw error;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abortRequest);
    }

    if (signal.aborted) return 'cancelled';
    if (!result || typeof result.status !== 'string') {
      throw new Error('The deposit status response was invalid.');
    }
    await onStatus(result);
    if (TERMINAL_DEPOSIT_STATUSES.has(result.status)) return 'terminal';

    const nextRemainingMs = maxDurationMs - (now() - startedAt);
    if (nextRemainingMs <= 0) return 'timeout';
    try {
      await sleep(Math.min(intervalMs, nextRemainingMs), signal);
    } catch {
      return signal.aborted ? 'cancelled' : 'timeout';
    }
  }
  return 'cancelled';
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const API_REQUEST_TIMEOUT_MS = 15_000;

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function resolveApiAsset(path: string): string {
  if (!path.startsWith('/api/v1/platform/website/assets/')) return path;
  return `${API_BASE}${path.slice('/api/v1'.length)}`;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new Error('The request timed out. Refresh saved payment status before retrying.');
    }
    throw new Error('LoanPlus could not reach the account service. Try again shortly.');
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message;
    throw new ApiRequestError(
      Array.isArray(message) ? message.join(' ') : message || 'The request could not be completed.',
      response.status,
    );
  }
  return payload.data as T;
}
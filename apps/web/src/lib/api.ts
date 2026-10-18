const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export function resolveApiAsset(path: string): string {
  if (!path.startsWith('/api/v1/platform/website/assets/')) return path;
  return `${API_BASE}${path.slice('/api/v1'.length)}`;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    throw new Error('LoanPlus could not reach the account service. Try again shortly.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message;
    throw new Error(Array.isArray(message) ? message.join(' ') : message || 'The request could not be completed.');
  }
  return payload.data as T;
}
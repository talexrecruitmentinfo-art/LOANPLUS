const AUTHENTICATION_ERROR =
  'Your session could not be verified. Sign in again or retry to check payment status; do not pay until status is verified.';
const PAYMENT_STATUS_ERROR =
  'The existing payment status could not be checked. Retry; do not pay again until it can be verified.';

export async function checkPaymentStatus(apiRequest) {
  try {
    await apiRequest('/auth/me', { cache: 'no-store' });
  } catch {
    return { authenticated: false, error: AUTHENTICATION_ERROR };
  }

  try {
    const unresolvedFee = await apiRequest('/payments/loan-processing-fee/unresolved', { cache: 'no-store' });
    return { authenticated: true, unresolvedFee, error: '' };
  } catch {
    return { authenticated: true, error: PAYMENT_STATUS_ERROR };
  }
}

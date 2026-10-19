const AUTHENTICATION_ERROR =
  'Your session could not be verified. Sign in again or retry before starting a payment.';
const APPLICATION_STATUS_ERROR =
  'Saved applications and their payment statuses could not be checked. Retry before starting a payment.';

export const PAYMENT_STATUS_POLL_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 30_000];

export function shouldPollLoanApplicationStatus(applications) {
  return Array.isArray(applications) && applications.some((application) => {
    const awaitingSubmission = application.status === 'DRAFT' ||
      application.status === 'PROCESSING_PAYMENT_PENDING';
    return Array.isArray(application.processingFeePayments) &&
      (application.processingFeePayments.some((payment) =>
        payment.status === 'PENDING' ||
        (payment.status === 'FAILED' && payment.failureCode === 'MPESA_RESULT_4999')) ||
        (awaitingSubmission && application.processingFeePayments.some((payment) => payment.status === 'CONFIRMED')));
  });
}

function hasPaymentHistory(application) {
  return application !== null &&
    typeof application === 'object' &&
    !Array.isArray(application) &&
    typeof application.id === 'string' &&
    Array.isArray(application.processingFeePayments) &&
    application.processingFeePayments.every((payment) =>
      payment !== null &&
      typeof payment === 'object' &&
      !Array.isArray(payment) &&
      typeof payment.id === 'string' &&
      typeof payment.internalReference === 'string' &&
      typeof payment.status === 'string' &&
      Number.isSafeInteger(payment.amountKes) &&
      (payment.failureCode === null || typeof payment.failureCode === 'string') &&
      (payment.receiptReference === null || typeof payment.receiptReference === 'string'),
    );
}

export async function loadLoanApplicationStatus(apiRequest) {
  try {
    await apiRequest('/auth/me', { cache: 'no-store' });
  } catch {
    return { authenticated: false, applications: null, error: AUTHENTICATION_ERROR };
  }

  try {
    const applications = await apiRequest('/loans/applications', { cache: 'no-store' });
    if (!Array.isArray(applications) || !applications.every(hasPaymentHistory)) {
      return { authenticated: true, applications: null, error: APPLICATION_STATUS_ERROR };
    }
    return { authenticated: true, applications, error: '' };
  } catch {
    return { authenticated: true, applications: null, error: APPLICATION_STATUS_ERROR };
  }
}

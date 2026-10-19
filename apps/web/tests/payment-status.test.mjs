import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadLoanApplicationStatus } from '../src/lib/payment-status.mjs';

const loanPage = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');
const statusHelper = await readFile(new URL('../src/lib/payment-status.mjs', import.meta.url), 'utf8');

const unresolvedApplication = {
  id: 'application-with-pending-fee',
  status: 'PROCESSING_PAYMENT_PENDING',
  processingFeePayments: [{
    id: 'payment-1',
    internalReference: 'LPP2A26FAA44E67AFED44C9E13F79547C4E',
    status: 'PENDING',
    amountKes: 50,
    failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
    receiptReference: null,
  }],
};

test('successful authentication loads saved applications and their fee histories', async () => {
  const paths = [];
  const applications = [{ id: 'application-1', processingFeePayments: [] }, unresolvedApplication];
  const result = await loadLoanApplicationStatus(async (path, options) => {
    paths.push([path, options]);
    return path === '/auth/me' ? { id: 'customer' } : applications;
  });

  assert.deepEqual(result, { authenticated: true, applications, error: '' });
  assert.deepEqual(paths.map(([path]) => path), ['/auth/me', '/loans/applications']);
  assert.ok(paths.every(([, options]) => options.cache === 'no-store'));
});

test('an expired session fails closed without discarding status into an empty-success result', async () => {
  let applicationsLookupCalled = false;
  const result = await loadLoanApplicationStatus(async (path) => {
    if (path === '/auth/me') throw new Error('expired');
    applicationsLookupCalled = true;
    return [];
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.applications, null);
  assert.match(result.error, /Sign in again or retry/);
  assert.equal(applicationsLookupCalled, false);
});

test('a failed /auth/me network request is retryable and does not permit payment', async () => {
  const result = await loadLoanApplicationStatus(async () => {
    throw new Error('network unavailable');
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.applications, null);
  assert.match(result.error, /session could not be verified/i);
  assert.match(loanPage, /Boolean\(applicationStatusError\)/);
  assert.match(loanPage, /applicationStatusLoading \|\| applicationStatusError/);
});

test('a failed application-payment status lookup is not treated as no unresolved payment', async () => {
  const result = await loadLoanApplicationStatus(async (path) => {
    if (path === '/auth/me') return { id: 'customer' };
    throw new Error('status unavailable');
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.applications, null);
  assert.match(result.error, /payment statuses could not be checked/i);
  assert.match(loanPage, /Payment initiation remains disabled until this check succeeds/);
});

test('a malformed application status response does not imply that payment history is empty', async () => {
  const result = await loadLoanApplicationStatus(async (path) =>
    path === '/auth/me' ? { id: 'customer' } : [{ id: 'application-without-payment-history' }],
  );

  assert.equal(result.applications, null);
  assert.match(result.error, /payment statuses could not be checked/i);
});

test('status check can be retried after an error and return the saved unresolved attempt', async () => {
  let applicationLookups = 0;
  const apiRequest = async (path) => {
    if (path === '/auth/me') return { id: 'customer' };
    applicationLookups += 1;
    if (applicationLookups === 1) throw new Error('temporary read failure');
    return [unresolvedApplication];
  };

  const failed = await loadLoanApplicationStatus(apiRequest);
  const retried = await loadLoanApplicationStatus(apiRequest);

  assert.equal(failed.applications, null);
  assert.match(failed.error, /could not be checked/);
  assert.deepEqual(retried, { authenticated: true, applications: [unresolvedApplication], error: '' });
  assert.equal(applicationLookups, 2);
  assert.match(loanPage, /Retry status check/);
});

test('a refreshed confirmed payment replaces the unresolved status without creating another payment', async () => {
  let currentApplication = unresolvedApplication;
  const requests = [];
  const apiRequest = async (path, options) => {
    requests.push([path, options]);
    if (path === '/auth/me') return { id: 'customer' };
    return [currentApplication];
  };

  const pending = await loadLoanApplicationStatus(apiRequest);
  currentApplication = {
    ...unresolvedApplication,
    status: 'SUBMITTED',
    submittedAt: '2026-10-19T21:00:00.000Z',
    processingFeePayments: [{
      ...unresolvedApplication.processingFeePayments[0],
      status: 'CONFIRMED',
      failureCode: null,
      confirmedAt: '2026-10-19T21:00:00.000Z',
      receiptReference: 'TESTRECEIPT1',
    }],
  };
  const confirmed = await loadLoanApplicationStatus(apiRequest);

  assert.equal(pending.applications[0].processingFeePayments[0].status, 'PENDING');
  assert.equal(confirmed.applications[0].processingFeePayments[0].status, 'CONFIRMED');
  assert.equal(confirmed.applications[0].status, 'SUBMITTED');
  assert.ok(requests.every(([path, options]) => path !== '/payments/loan-processing-fee' && options.cache === 'no-store'));
  assert.match(loanPage, /Payment confirmed — application submitted for review/);
  assert.match(loanPage, /applicationsRequestId === applicationsRequestSequence\.current/);
});

test('an existing unresolved fee remains visible on its application without globally blocking new applications', async () => {
  const result = await loadLoanApplicationStatus(async (path) =>
    path === '/auth/me' ? { id: 'customer' } : [{ id: 'new-application', processingFeePayments: [] }, unresolvedApplication],
  );

  assert.equal(result.applications[1].processingFeePayments[0].internalReference, 'LPP2A26FAA44E67AFED44C9E13F79547C4E');
  assert.match(loanPage, /feeAttempts\.map/);
  assert.match(loanPage, /Payment outcome pending verification — do not pay again/);
  assert.doesNotMatch(loanPage, /payments\/loan-processing-fee\/unresolved/);
  assert.doesNotMatch(loanPage, /unresolvedFee/);
});

test('payment-status refresh is read-only and always terminates its loading state', async () => {
  const refresh = loanPage.match(/const refreshPaymentStatus = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\)/)?.[1] ?? '';

  assert.match(refresh, /loadLoanApplicationStatus<LoanApplication>\(apiRequest\)/);
  assert.match(refresh, /finally \{\s*if \(requestId === statusRequestSequence\.current\) setApplicationStatusLoading\(false\);/);
  assert.doesNotMatch(refresh, /method:\s*'POST'|\/payments\/loan-processing-fee['"]/);
  assert.match(loanPage, /paymentActionInFlight\.current/);
  assert.match(statusHelper, /apiRequest\('\/auth\/me'/);
  assert.match(statusHelper, /apiRequest\('\/loans\/applications'/);
  assert.doesNotMatch(statusHelper, /method:\s*'POST'|\/payments\/loan-processing-fee/);
});

test('a definitive provider failure is the only supported same-application retry state', () => {
  assert.match(loanPage, /attempt\.status === 'PENDING'/);
  assert.match(loanPage, /attempt\.status === 'CONFIRMED'/);
  assert.match(loanPage, /isRetryableFeeFailure\(application\.processingFeePayments\[0\]\)/);
  assert.match(loanPage, /MPESA_RESULT_4999/);
  assert.match(loanPage, /previous attempt was conclusively declined/);
});

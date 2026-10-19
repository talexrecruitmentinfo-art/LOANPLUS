import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkPaymentStatus, createPaymentStatusRefresher } from '../src/lib/payment-status.mjs';

const loanPage = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');
const paymentStatus = await readFile(new URL('../src/lib/payment-status.mjs', import.meta.url), 'utf8');
const unresolvedFee = {
  reference: 'LPP2A26FAA44E67AFED44C9E13F79547C4E',
  status: 'PENDING',
  amountKes: 50,
  currency: 'KES',
  initiationPhase: 'STK_REQUEST_OUTCOME_UNCERTAIN',
  createdAt: '2026-10-19T00:00:00.000Z',
  message: 'Do not pay again until it has been reconciled.',
};

test('successful authentication checks and returns the unresolved-payment status', async () => {
  const paths = [];
  const apiRequest = async (path) => {
    paths.push(path);
    return path === '/auth/me' ? { id: 'customer' } : null;
  };

  assert.deepEqual(await checkPaymentStatus(apiRequest), {
    authenticated: true,
    unresolvedFee: null,
    error: '',
  });
  assert.deepEqual(paths, ['/auth/me', '/payments/loan-processing-fee/unresolved']);
});

test('an expired session fails closed without checking or clearing unresolved-payment status', async () => {
  let lookupCalled = false;
  const apiRequest = async (path) => {
    if (path === '/auth/me') throw new Error('session expired');
    lookupCalled = true;
    return null;
  };

  const result = await checkPaymentStatus(apiRequest);

  assert.equal(result.authenticated, false);
  assert.match(result.error, /Sign in again or retry/);
  assert.equal(lookupCalled, false);
  assert.equal('unresolvedFee' in result, false);
});

test('a failed authentication network request returns a retryable error', async () => {
  const result = await checkPaymentStatus(async () => {
    throw new Error('network unavailable');
  });

  assert.equal(result.authenticated, false);
  assert.match(result.error, /do not pay until status is verified/);
});

test('a failed unresolved-payment lookup is not interpreted as no unresolved payment', async () => {
  const result = await checkPaymentStatus(async (path) => {
    if (path === '/auth/me') return { id: 'customer' };
    throw new Error('status service unavailable');
  });

  assert.equal(result.authenticated, true);
  assert.match(result.error, /do not pay again until it can be verified/);
  assert.equal('unresolvedFee' in result, false);
});

test('a malformed successful status response fails closed instead of being treated as no unresolved payment', async () => {
  const result = await checkPaymentStatus(async (path) => path === '/auth/me' ? { id: 'customer' } : undefined);

  assert.equal(result.authenticated, true);
  assert.match(result.error, /do not pay again until it can be verified/);
  assert.equal('unresolvedFee' in result, false);
});

test('payment status can be retried successfully after a lookup error', async () => {
  let lookupCount = 0;
  const apiRequest = async (path) => {
    if (path === '/auth/me') return { id: 'customer' };
    lookupCount += 1;
    if (lookupCount === 1) throw new Error('temporary lookup failure');
    return null;
  };

  const failed = await checkPaymentStatus(apiRequest);
  const retried = await checkPaymentStatus(apiRequest);

  assert.match(failed.error, /could not be checked/);
  assert.deepEqual(retried, { authenticated: true, unresolvedFee: null, error: '' });
  assert.equal(lookupCount, 2);
});

test('an existing unresolved payment remains reported and the page keeps payment initiation guarded', async () => {
  const result = await checkPaymentStatus(async (path) => path === '/auth/me' ? { id: 'customer' } : unresolvedFee);

  assert.deepEqual(result, { authenticated: true, unresolvedFee, error: '' });
  assert.match(loanPage, /Boolean\(unresolvedFee\)/);
  assert.match(loanPage, /unresolvedFee \|\| unresolvedFeeError \? 'Payment unresolved — do not pay again'/);
  assert.match(loanPage, /unresolvedFee\.reference/);
  assert.match(loanPage, /Payment unresolved — do not pay again/);
});

test('status check failure keeps existing unresolved payment state intact until a successful check', async () => {
  const initial = await checkPaymentStatus(async (path) => path === '/auth/me'
    ? { id: 'customer' }
    : unresolvedFee);
  const result = await checkPaymentStatus(async (path) => {
    if (path === '/auth/me') return { id: 'customer' };
    throw new Error('temporary read failure');
  });

  assert.equal(initial.unresolvedFee.reference, unresolvedFee.reference);
  assert.match(result.error, /do not pay again until it can be verified/);
  assert.match(loanPage, /else if \('unresolvedFee' in result\) \{\s*setUnresolvedFee\(result\.unresolvedFee\);/);
});

test('authentication and payment-status failures expose a retry control and always terminate loading', async () => {
  assert.match(paymentStatus, /finally \{\s*if \(requestId === requestSequence\) onComplete\(\);/);
  assert.match(loanPage, /Retry payment status/);
  assert.match(loanPage, /disabled=\{busyId !== null \|\| unresolvedFeeLoading\} onClick=\{\(\) => void refreshPaymentStatus\(\)\}/);
  assert.match(loanPage, /unresolvedFee && !unresolvedFeeError && !unresolvedFeeLoading/);
  assert.match(loanPage, /unresolvedFeeLoading && signedIn && <p className="fee-unavailable-notice" role="status">Checking the saved processing-fee status/);
  assert.match(loanPage, /paymentActionInFlight\.current/);
});

test('a newer payment-status response cannot be overwritten by a slower stale response', async () => {
  const pendingLookups = [];
  const applied = [];
  let completed = 0;
  const apiRequest = async (path) => {
    if (path === '/auth/me') return { id: 'customer' };
    return new Promise((resolve) => pendingLookups.push(resolve));
  };
  const refresher = createPaymentStatusRefresher(
    apiRequest,
    (result) => applied.push(result),
    () => { completed += 1; },
  );

  const olderRefresh = refresher.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const newerRefresh = refresher.refresh();
  await new Promise((resolve) => setImmediate(resolve));

  pendingLookups[1](null);
  await newerRefresh;
  pendingLookups[0](unresolvedFee);
  await olderRefresh;

  assert.deepEqual(applied, [{ authenticated: true, unresolvedFee: null, error: '' }]);
  assert.equal(completed, 1);
});

test('verified terminal outcomes clear the unresolved banner and confirmed receipts are displayed', async () => {
  const result = await checkPaymentStatus(async (path) => path === '/auth/me' ? { id: 'customer' } : null);

  assert.deepEqual(result, { authenticated: true, unresolvedFee: null, error: '' });
  assert.match(loanPage, /fee\.status === 'FAILED' \|\| fee\.status === 'CANCELLED' \|\| fee\.status === 'EXPIRED'/);
  assert.match(loanPage, /fee\.receiptReference && <div><dt>M-Pesa receipt<\/dt><dd>\{fee\.receiptReference\}<\/dd><\/div>/);
});

test('refresh reloads the customer application payment record and never initiates another STK request', async () => {
  assert.match(loanPage, /void refreshPaymentStatus\(\)/);
  assert.match(loanPage, /refreshApplications\(\)\.catch/);
  assert.match(loanPage, /cache: 'no-store'/);
  assert.match(loanPage, /Payment outcome not yet verified — do not pay again/);
  assert.match(loanPage, /contact support<\/Link> to reconcile this original attempt/);
  assert.doesNotMatch(loanPage.match(/const refreshPaymentStatus = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[paymentStatusRefresher\]\)/)?.[1] ?? '', /method:\s*'POST'|\/payments\/loan-processing-fee['"]/);
});

test('loan-fee initiation requires explicit M-Pesa number confirmation and sends the confirmed number', async () => {
  assert.match(loanPage, /M-Pesa phone number for the prompt/);
  assert.match(loanPage, /I confirm this is the M-Pesa number that should receive the displayed processing-fee prompt/);
  assert.match(loanPage, /!mpesaPhoneConfirmed/);
  assert.match(loanPage, /JSON\.stringify\(\{ applicationId, reviewConfirmed: true, mpesaPhoneNumber \}\)/);
  assert.match(loanPage, /fee\.initiationPhase === 'PROVIDER_ACCEPTED' \? 'Awaiting prompt — check/);
  assert.match(loanPage, /Payment confirmed — application submitted for review/);
  assert.match(loanPage, /Payment requires review — do not pay again/);
});

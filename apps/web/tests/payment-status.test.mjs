import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkPaymentStatus } from '../src/lib/payment-status.mjs';

const loanPage = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');
const unresolvedFee = {
  reference: 'LPP_UNRESOLVED_FIXTURE',
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
});

test('authentication and payment-status failures expose a retry control and always terminate loading', async () => {
  assert.match(loanPage, /finally \{\s*setUnresolvedFeeLoading\(false\);\s*\}/);
  assert.match(loanPage, /Retry payment status/);
  assert.match(loanPage, /disabled=\{busyId !== null \|\| unresolvedFeeLoading\} onClick=\{\(\) => void refreshPaymentStatus\(\)\}/);
});

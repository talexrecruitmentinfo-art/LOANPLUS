import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  pollWalletDepositStatus,
  WALLET_DEPOSIT_POLL_INTERVAL_MS,
  WALLET_DEPOSIT_POLL_WINDOW_MS,
} from '../src/lib/wallet-deposit-polling.mjs';

const walletComponent = await readFile(new URL('../src/components/customer-ledger.tsx', import.meta.url), 'utf8');

test('pending status polling stops at the 60-second window without changing pending status', async () => {
  let time = 10_000;
  let requests = 0;
  const statuses = [];
  const outcome = await pollWalletDepositStatus({
    reference: 'LPD_PENDING',
    startedAt: time,
    now: () => time,
    intervalMs: WALLET_DEPOSIT_POLL_INTERVAL_MS,
    maxDurationMs: WALLET_DEPOSIT_POLL_WINDOW_MS,
    signal: new AbortController().signal,
    getStatus: async () => {
      requests += 1;
      return { status: 'PENDING' };
    },
    onStatus: ({ status }) => statuses.push(status),
    sleep: async (duration) => { time += duration; },
  });

  assert.equal(outcome, 'timeout');
  assert.equal(time, 70_000);
  assert.equal(requests, 12);
  assert.equal(statuses.every((status) => status === 'PENDING'), true);
});

test('polling stops immediately on a terminal provider-verified status', async () => {
  let requests = 0;
  const controller = new AbortController();
  const outcome = await pollWalletDepositStatus({
    reference: 'LPD_CONFIRMED',
    signal: controller.signal,
    getStatus: async () => {
      requests += 1;
      return { status: 'CONFIRMED' };
    },
    onStatus: () => undefined,
    sleep: async () => { throw new Error('A terminal status must not sleep.'); },
  });
  assert.equal(outcome, 'terminal');
  assert.equal(requests, 1);
});

test('polling cancellation stops further requests and reports a cancelled outcome', async () => {
  const controller = new AbortController();
  let requests = 0;
  const outcome = await pollWalletDepositStatus({
    reference: 'LPD_CANCELLED',
    signal: controller.signal,
    getStatus: async () => {
      requests += 1;
      controller.abort();
      return { status: 'PENDING' };
    },
    onStatus: () => undefined,
  });
  assert.equal(outcome, 'cancelled');
  assert.equal(requests, 1);
});

test('an in-flight status request is aborted at the automatic polling deadline', async () => {
  const outcome = await pollWalletDepositStatus({
    reference: 'LPD_SLOW',
    maxDurationMs: 20,
    signal: new AbortController().signal,
    getStatus: (_reference, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }),
    onStatus: () => undefined,
  });
  assert.equal(outcome, 'timeout');
});

test('status request failures stop the automatic loop so the customer can retry manually', async () => {
  let requests = 0;
  await assert.rejects(pollWalletDepositStatus({
    reference: 'LPD_NETWORK_ERROR',
    signal: new AbortController().signal,
    getStatus: async () => {
      requests += 1;
      throw new Error('Status check failed.');
    },
    onStatus: () => undefined,
  }), /Status check failed/);
  assert.equal(requests, 1);
});

test('component follows backend retry eligibility and guards unresolved deposit status checks', () => {
  assert.match(walletComponent, /payments\s*\.filter\(\(payment\) => payment\.type === 'WALLET_DEPOSIT'/);
  assert.match(walletComponent, /apiRequest<WalletDepositEligibility>\([\s\S]*?\/payments\/wallet-deposit-eligibility/);
  assert.match(walletComponent, /depositEligibility\?\.canInitiateNewDeposit !== true/);
  assert.doesNotMatch(walletComponent, /Boolean\(unresolvedDepositRecord\)/);
  assert.doesNotMatch(walletComponent, /walletActionBusyRef\.current \|\| unresolvedDeposit \|\| statusCheckBusy\.current/);
  assert.match(walletComponent, /checkDepositStatus\(selectedDepositReference\)/);
  assert.match(walletComponent, /statusCheckController\.current\?\.abort\(\)/);
  assert.match(walletComponent, /depositReferenceRef\.current !== reference/);
  assert.match(walletComponent, /applyDepositStatusRef\.current\(reference, result\.status\)/);
  assert.match(walletComponent, /quoteController\.current\?\.abort\(\)/);
  assert.match(walletComponent, /controller\.signal\.aborted/);
  assert.match(walletComponent, /apiRequest<WalletDepositStatusResponse>\(\s*`\/payments\/wallet-deposits\/\$\{encodeURIComponent\(paymentReference\)\}`/);
  assert.match(walletComponent, /if \(status === 'CONFIRMED'\)[\s\S]*?await refresh\(\)/);
  assert.match(walletComponent, /setDepositPollingTimedOut\(true\)/);
  assert.match(walletComponent, /if \(pollingWindow\.stopped\) return/);
  assert.match(walletComponent, /!componentMounted\.current/);
  assert.match(walletComponent, /setPaymentHistoryVerified\(false\)/);
});

test('availability loading is isolated and errors expose an explicit retry', () => {
  assert.match(walletComponent, /depositQuoteLoading && <p role="status">Checking whether wallet deposits are available…<\/p>/);
  assert.match(walletComponent, /depositQuoteError && <div className="form-error" role="alert">/);
  assert.match(walletComponent, /onClick=\{\(\) => void loadDepositQuote\(\)\}>/);
  assert.match(walletComponent, /!depositQuoteLoading && !depositQuoteError && depositQuote/);
  assert.match(walletComponent, /requestId !== quoteSequence\.current/);
});

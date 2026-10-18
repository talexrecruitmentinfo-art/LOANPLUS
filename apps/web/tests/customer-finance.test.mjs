import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wallet = await readFile(new URL('../src/components/customer-ledger.tsx', import.meta.url), 'utf8');
const profile = await readFile(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
const loans = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');
const settings = await readFile(new URL('../src/components/platform-settings-panel.tsx', import.meta.url), 'utf8');
const money = await readFile(new URL('../src/lib/currency.ts', import.meta.url), 'utf8');

test('wallet and transactions are loaded from authenticated ledger endpoints without cached reads', () => {
  assert.match(wallet, /apiRequest<Wallet>\('\/wallet', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<LedgerEntry\[]>\('\/wallet\/transactions', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<PaymentRecord\[]>\('\/payments', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /Payment attempts/);
  assert.match(wallet, /entry\.transaction\.internalReference/);
  assert.match(wallet, /entry\.transaction\.status/);
});

test('profile is server-backed and uses only existing security and support actions', () => {
  assert.match(profile, /apiRequest<CustomerProfile>\('\/auth\/me'/);
  assert.match(profile, /\/settings\/security/);
  assert.match(profile, /\/support/);
  assert.doesNotMatch(profile, /localStorage/);
});

test('loan applications submit only actual configured product and principal values', () => {
  assert.match(loans, /\/loans\/applications/);
  assert.match(loans, /customer\.activationStatus !== 'ACTIVE'/);
  assert.match(loans, /min=\{product\.minimumPrincipalKes\}/);
  assert.match(loans, /max=\{product\.maximumPrincipalKes\}/);
});

test('platform currency controls reject unsupported currencies and render KES settings', () => {
  assert.match(settings, /currencyCode: PLATFORM_CURRENCY\.code/);
  assert.match(settings, /Not supported by the KES ledger/);
  assert.match(money, /code: 'KES'/);
  assert.match(money, /Number\.isSafeInteger/);
});

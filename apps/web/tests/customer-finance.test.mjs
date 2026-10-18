import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wallet = await readFile(new URL('../src/components/customer-ledger.tsx', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../src/app/dashboard/page.tsx', import.meta.url), 'utf8');
const reconciliation = await readFile(new URL('../src/app/admin/reconciliation/page.tsx', import.meta.url), 'utf8');
const profile = await readFile(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
const support = await readFile(new URL('../src/app/support/page.tsx', import.meta.url), 'utf8');
const loans = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');
const settings = await readFile(new URL('../src/components/platform-settings-panel.tsx', import.meta.url), 'utf8');
const money = await readFile(new URL('../src/lib/currency.ts', import.meta.url), 'utf8');
const redesign = await readFile(new URL('../src/app/customer-redesign.css', import.meta.url), 'utf8');
const customerShell = await readFile(new URL('../src/components/customer-app-shell.tsx', import.meta.url), 'utf8');
const login = await readFile(new URL('../src/app/login/page.tsx', import.meta.url), 'utf8');
const register = await readFile(new URL('../src/app/register/page.tsx', import.meta.url), 'utf8');

test('wallet and transactions are loaded from authenticated ledger endpoints without cached reads', () => {
  assert.match(wallet, /apiRequest<Wallet>\('\/wallet', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<LedgerEntry\[]>\('\/wallet\/transactions', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<PaymentRecord\[]>\('\/payments', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /Payment attempts/);
  assert.match(wallet, /entry\.transaction\.internalReference/);
  assert.match(wallet, /entry\.transaction\.status/);
  assert.match(wallet, /const refreshSequence = useRef\(0\)/);
  assert.match(wallet, /if \(requestId !== refreshSequence\.current\) return/);
});

test('home shows authenticated recent activity and keeps the overview available when wallet data fails', () => {
  assert.match(dashboard, /apiRequest<LedgerEntry\[]>\('\/wallet\/transactions', \{ cache: 'no-store' \}\)/);
  assert.match(dashboard, /apiRequest<PaymentAttempt\[]>\('\/payments', \{ cache: 'no-store' \}\)/);
  assert.match(dashboard, /wallet \? formatKes\(wallet\.balanceKes\) : 'Unavailable'/);
  assert.doesNotMatch(dashboard, /if \(!wallet\) return/);
  assert.match(dashboard, /Do not submit another payment while this request remains unresolved/);
});

test('reconciliation page filters server-side and excludes customer identity from the queue', () => {
  assert.match(reconciliation, /query\.set\('search', searchTerm\)/);
  assert.match(reconciliation, /query\.set\('category', queueCategory\)/);
  assert.match(reconciliation, /reasonForInclusion/);
  assert.doesNotMatch(reconciliation, /payment\.user\.(fullName|email)/);
});

test('profile is server-backed and uses only existing security and support actions', () => {
  assert.match(profile, /apiRequest<CustomerProfile>\('\/auth\/me'/);
  assert.match(profile, /\/settings\/security/);
  assert.match(profile, /\/support/);
  assert.match(profile, /Profile unavailable/);
  assert.match(profile, /onClick=\{\(\) => void loadProfile\(\)\}/);
  assert.doesNotMatch(profile, /localStorage/);
});

test('support distinguishes loading, empty, failed, and submitted states without losing submitted requests', () => {
  assert.match(support, /Loading your support requests/);
  assert.match(support, /No support requests yet/);
  assert.match(support, /setLoadError/);
  assert.match(support, /Your request was sent/);
  assert.match(support, /If you have been signed out/);
  assert.match(support, /onClick=\{\(\) => void refresh\(\)\}/);
});

test('loan application collects guarantors, reviews details, and uses the processing fee before submission', () => {
  assert.match(loans, /\/loans\/applications/);
  assert.match(loans, /guarantorOneName/);
  assert.match(loans, /guarantorOnePhone/);
  assert.match(loans, /guarantorTwoName/);
  assert.match(loans, /guarantorTwoPhone/);
  assert.match(loans, /\/payments\/loan-processing-fee/);
  assert.match(loans, /awaiting admin review/i);
  assert.doesNotMatch(loans, /activationStatus/);
  assert.match(loans, /approvedTermsSnapshot/);
  assert.match(loans, /terms\.termsVersion/);
});

test('platform currency controls reject unsupported currencies and render KES settings', () => {
  assert.match(settings, /currencyCode: PLATFORM_CURRENCY\.code/);
  assert.match(settings, /Not supported by the KES ledger/);
  assert.match(money, /code: 'KES'/);
  assert.match(money, /Number\.isSafeInteger/);
});

test('customer navigation has five primary destinations and accessible secondary links', () => {
  for (const label of ['Home', 'Loans', 'Wallet', 'Payments', 'Profile']) {
    assert.match(customerShell, new RegExp(`label: '${label}'`));
  }
  assert.match(customerShell, /customer-more-menu/);
  assert.match(customerShell, /href="\/support"/);
  assert.match(customerShell, /href="\/settings\/security"/);
  assert.match(customerShell, /aria-current=\{active \? 'page' : undefined\}/);
});

test('customer redesign includes mobile-safe navigation, responsive layouts, and visible focus states', () => {
  assert.match(redesign, /env\(safe-area-inset-bottom\)/);
  assert.match(redesign, /min-height:54px/);
  assert.match(redesign, /@media\(max-width:650px\)/);
  assert.match(redesign, /@media\(min-width:760px\)/);
  assert.match(redesign, /@media\(max-width:380px\)/);
  assert.match(redesign, /:focus-visible/);
  assert.match(redesign, /loan-step-indicator/);
});

test('login and registration provide keyboard-accessible password visibility controls', () => {
  assert.match(login, /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/);
  assert.match(register, /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/);
  assert.match(register, /name="nationalId" inputMode="numeric"/);
});

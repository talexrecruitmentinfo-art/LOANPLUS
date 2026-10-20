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
const trust = await readFile(new URL('../src/app/trust/page.tsx', import.meta.url), 'utf8');
const login = await readFile(new URL('../src/app/login/page.tsx', import.meta.url), 'utf8');
const register = await readFile(new URL('../src/app/register/page.tsx', import.meta.url), 'utf8');
const publicHomepage = await readFile(new URL('../src/components/public-homepage.tsx', import.meta.url), 'utf8');
const paymentController = await readFile(new URL('../../api/src/payments/payment.controller.ts', import.meta.url), 'utf8');
const paymentService = await readFile(new URL('../../api/src/payments/payment.service.ts', import.meta.url), 'utf8');

test('wallet and transactions are loaded from authenticated ledger endpoints without cached reads', () => {
  assert.match(wallet, /apiRequest<Wallet>\('\/wallet', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<LedgerPage>\('\/wallet\/transactions\?limit=25', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<PaymentRecord\[]>\('\/payments', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<WalletDepositQuote>\('\/payments\/wallet-deposit-quote'/);
  assert.match(wallet, /apiRequest<EligibleLoan\[]>\('\/loans\/repayments\/eligible'/);
  assert.match(wallet, /\/payments\/wallet-deposits/);
  assert.match(wallet, /\/repayments`/);
  assert.match(wallet, /Payment attempts/);
  assert.match(wallet, /entry\.transaction\.internalReference/);
  assert.match(wallet, /entry\.transaction\.status/);
  assert.match(wallet, /apiRequest<LedgerPage>\('\/wallet\/transactions\?limit=25/);
  assert.match(wallet, /const refreshSequence = useRef\(0\)/);
  assert.match(wallet, /if \(requestId !== refreshSequence\.current\) return/);
  assert.match(wallet, /pendingDepositsKes/);
  assert.match(wallet, /apiRequest<Wallet>\('\/wallet', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /apiRequest<LedgerPage>\('\/wallet\/transactions\?limit=25', \{ cache: 'no-store' \}\)/);
  assert.match(wallet, /await refresh\(\);/);
  assert.match(wallet, /window\.setInterval\(\(\) => void refresh\(\), 5_000\)/);
  assert.doesNotMatch(wallet, /setWallet\(\(current\) => \(\{[^}]*balanceKes/);
  assert.match(wallet, /do not submit another deposit/);
  assert.match(wallet, /wallet repayment/);
  assert.match(wallet, /Load more transactions/);
  assert.match(wallet, /Confirm an M-Pesa wallet deposit/);
  assert.match(wallet, /Confirm a wallet repayment/);
});

test('Trust Centre uses authenticated identity and backend fee status, with real policy and support links', () => {
  assert.match(trust, /apiRequest<TrustProfile>\('\/auth\/me'/);
  assert.match(trust, /apiRequest<ProcessingFeeQuote>\('\/payments\/loan-processing-fee-quote'/);
  assert.match(trust, /identityStatus\.replaceAll/);
  assert.match(trust, /refundPolicyStatus/);
  for (const route of ['/terms', '/privacy', '/settings/security', '/referrals', '/support']) {
    assert.ok(trust.includes(`href="${route}"`), `Trust Centre should link to ${route}`);
  }
  assert.doesNotMatch(trust, /VERIFIED.*true|isVerified/);
});

test('home shows authenticated recent activity and keeps the overview available when wallet data fails', () => {
  assert.match(dashboard, /apiRequest<LedgerPage>\('\/wallet\/transactions\?limit=25', \{ cache: 'no-store' \}\)/);
  assert.match(dashboard, /apiRequest<PaymentAttempt\[]>\('\/payments', \{ cache: 'no-store' \}\)/);
  assert.match(dashboard, /hasPendingWalletDeposit/);
  assert.match(dashboard, /window\.setInterval\(\(\) => void refreshWalletActivity\(\), 5_000\)/);
  assert.match(dashboard, /setRecentEntries\(nextEntries\.items\.slice\(0, 4\)\)/);
  assert.match(dashboard, /apiRequest<Product\[]>\('\/loans\/products', \{ cache: 'no-store' \}\)/);
  assert.match(dashboard, /No available loan products/);
  assert.match(dashboard, /Loan products could not be loaded/);
  assert.match(dashboard, /Retry/);
  assert.match(dashboard, /\/loans\?productId=\$\{encodeURIComponent\(item\.id\)\}/);
  assert.match(dashboard, /wallet \? formatKes\(wallet\.balanceKes\) : 'Unavailable'/);
  assert.match(dashboard, /href="\/wallet"/);
  assert.match(dashboard, /Deposit or repay/);
  assert.match(dashboard, /Send Money unavailable: internal transfers are not enabled/);
  assert.match(dashboard, /Withdraw unavailable: payouts are not enabled/);
  assert.doesNotMatch(dashboard, /if \(!wallet\) return/);
  assert.match(dashboard, /Do not submit another payment while this request remains unresolved/);
});

test('reconciliation page filters server-side and excludes customer identity from the queue', () => {
  assert.match(reconciliation, /query\.set\('search', searchTerm\)/);
  assert.match(reconciliation, /query\.set\('category', queueCategory\)/);
  assert.match(reconciliation, /reasonForInclusion/);
  assert.doesNotMatch(reconciliation, /payment\.user\.(fullName|email)/);
});

test('admin payment monitoring filters wallet deposits and displays their ledger journal reference', async () => {
  const adminPayments = await readFile(new URL('../src/app/admin/payments/page.tsx', import.meta.url), 'utf8');
  assert.match(adminPayments, /value="WALLET_DEPOSIT">Wallet deposit/);
  assert.match(adminPayments, /payment\.ledgerTransaction\.internalReference/);
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
  assert.match(loans, /loan-processing-fee-quote/);
  assert.match(loans, /estimateTotalRepayment/);
  assert.doesNotMatch(loans, /KSh 50|formatMoney\(50\)/);
});

test('loan journey applies reference styling while preserving live products, estimates, and real application statuses', () => {
  assert.match(loans, /loan-journey-page/);
  assert.match(loans, /loan-product-card/);
  assert.match(loans, /loan-estimate-card/);
  assert.match(loans, /estimateTotalRepayment\(product, Number\(form\.requestedPrincipalKes\)\)/);
  assert.match(loans, /loan-status-\$\{application\.status\.toLowerCase\(\)\}/);
  assert.match(loans, /className="loan-step-indicator"/);
  assert.match(loans, /\/loans\/products/);
  assert.match(loans, /\/loans\/applications/);
  assert.match(loans, /\/payments\/loan-processing-fee/);
  assert.match(redesign, /\.loan-journey-page/);
  assert.match(redesign, /\.loan-estimate-card/);
  assert.match(redesign, /@media\(max-width:650px\)/);
  assert.match(redesign, /\.auth-form-wrap/);
  assert.match(redesign, /\.dashboard-home-welcome/);
});

test('processing-fee quote comes from the backend constant and discloses unconfigured refund policy', () => {
  assert.match(paymentController, /getLoanProcessingFeeQuote/);
  assert.match(paymentService, /paymentAvailable: unavailableReasons\.length === 0/);
  assert.match(paymentService, /MPESA_CLEARING/);
  assert.match(paymentService, /Approved processing-fee policy approval/);
  assert.match(paymentService, /buildMpesaCallbackUrl/);
});

test('public homepage never substitutes a hardcoded fee when its backend request fails', () => {
  assert.match(publicHomepage, /processingFeeKes: null/);
  assert.match(publicHomepage, /Fee information unavailable/);
  assert.doesNotMatch(publicHomepage, /processingFeeKes: 50/);
});

test('platform currency controls reject unsupported currencies and render KES settings', () => {
  assert.match(settings, /currencyCode: PLATFORM_CURRENCY\.code/);
  assert.match(settings, /Not supported by the KES ledger/);
  assert.match(money, /code: 'KES'/);
  assert.match(money, /Number\.isSafeInteger/);
});

test('customer navigation has five primary destinations with secondary links moved into Profile', () => {
  for (const label of ['Home', 'Loans', 'Wallet', 'Payments', 'Profile']) {
    assert.match(customerShell, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(customerShell, /customer-more-menu|More customer options/);
  assert.match(profile, /href="\/support"/);
  assert.match(profile, /href="\/settings\/security"/);
  assert.match(profile, /href="\/terms"/);
  assert.match(profile, /href="\/privacy"/);
  assert.match(profile, /\/platform\/pwa\/eligibility/);
  assert.doesNotMatch(dashboard, /className="dashboard-links"/);
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

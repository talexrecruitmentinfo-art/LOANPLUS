import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const activationPage = await readFile(new URL('../src/app/activation/page.tsx', import.meta.url), 'utf8');
const loanPage = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');
const paymentStatus = await readFile(new URL('../src/lib/payment-status.mjs', import.meta.url), 'utf8');

test('obsolete account activation route redirects to the loan application journey', () => {
  assert.match(activationPage, /redirect\('\/loans'\)/);
  assert.doesNotMatch(activationPage, /activation\/status|payments\/activation|activation fee/i);
});

test('loan application requires the five fields and review before the processing-fee request', () => {
  for (const field of ['guarantorOneName', 'guarantorOnePhone', 'guarantorTwoName', 'guarantorTwoPhone', 'requestedPrincipalKes']) {
    assert.match(loanPage, new RegExp(field));
  }
  assert.match(loanPage, /Review your application/);
  assert.match(loanPage, /loan-processing-fee-quote/);
  assert.match(loanPage, /product-apply-button/);
  assert.match(loanPage, /signedIn && product/);
  assert.match(loanPage, /function selectProduct/);
  assert.match(loanPage, /termsAccepted,/);
  assert.match(loanPage, /flat, full term/);
  assert.match(loanPage, /feeUnavailableReason/);
  assert.match(loanPage, /Pay \$\{feeQuoteAmount\}/);
  assert.match(loanPage, /Fee required:<\/b> A \{feeQuoteAmount\} loan processing fee is required before this application can be submitted/);
  assert.match(loanPage, /processingFeeQuote\.refundPolicyDisclosure/);
  assert.match(loanPage, /paymentActionInFlight\.current = true/);
  assert.match(loanPage, /resumingApplicationId \? 'Back to applications' : 'Edit details'/);
  assert.match(loanPage, /refundPolicyStatus/);
  assert.match(loanPage, /\/payments\/loan-processing-fee/);
  assert.match(loanPage, /reviewConfirmed: true/);
  assert.match(loanPage, /Refresh status/);
  assert.match(paymentStatus, /\/loans\/applications/);
  assert.match(loanPage, /Payment outcome pending verification — do not pay again/);
  assert.match(loanPage, /Boolean\(applicationStatusError\)/);
  assert.match(loanPage, /Retry status check/);
  assert.match(loanPage, /Payment confirmed — application submitted for review/);
  assert.match(loanPage, /href="\/support"/);
  assert.match(paymentStatus, /\/loans\/applications/);
  assert.match(loanPage, /Payment outcome pending verification — do not pay again/);
  assert.match(loanPage, /Boolean\(applicationStatusError\)/);
  assert.match(loanPage, /Retry status check/);
  assert.match(loanPage, /href="\/support"/);
  assert.match(loanPage, /Review fee requirement/);
  assert.doesNotMatch(loanPage, /activationStatus/);
});

test('opening and resuming loan applications never initiates a fee payment', () => {
  const initialLoad = loanPage.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1] ?? '';
  const resumeFlow = loanPage.match(/function resumeProcessingFee\(application: LoanApplication\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';

  assert.doesNotMatch(initialLoad, /method:\s*'POST'|\/payments\/loan-processing-fee['"]/);
  assert.doesNotMatch(resumeFlow, /apiRequest|payments\/loan-processing-fee/);
  assert.match(loanPage, /onClick=\{\(\) => void payProcessingFee\(\)\}/);
});

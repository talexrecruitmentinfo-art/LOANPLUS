import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const activationPage = await readFile(new URL('../src/app/activation/page.tsx', import.meta.url), 'utf8');
const loanPage = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');
const paymentStatus = await readFile(new URL('../src/lib/payment-status.mjs', import.meta.url), 'utf8');
const apiClient = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

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
  assert.match(loanPage, /Review and pay \$\{feeQuoteAmount\}/);
  assert.doesNotMatch(loanPage, /activationStatus/);
});

test('opening and resuming loan applications never initiates a fee payment', () => {
  const initialLoad = loanPage.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1] ?? '';
  const resumeFlow = loanPage.match(/function resumeProcessingFee\(application: LoanApplication\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';

  assert.doesNotMatch(initialLoad, /method:\s*'POST'|\/payments\/loan-processing-fee['"]/);
  assert.doesNotMatch(resumeFlow, /apiRequest|payments\/loan-processing-fee/);
  assert.match(loanPage, /onClick=\{\(\) => void payProcessingFee\(\)\}/);
});

test('Admin approval is shown as waiting for disbursement without a customer acceptance action', async () => {
  const dashboard = await readFile(new URL('../src/app/dashboard/page.tsx', import.meta.url), 'utf8');
  const adminLoans = await readFile(new URL('../src/app/admin/loans/page.tsx', import.meta.url), 'utf8');

  assert.match(loanPage, /WAITING_FOR_DISBURSEMENT/);
  assert.match(loanPage, /Approved — Waiting for Disbursement/);
  assert.doesNotMatch(loanPage, /Accept approved offer|acceptOffer|\/accept['"]/);
  assert.match(loanPage, /APPROVED' && !application\.loan/);
  assert.match(loanPage, /Approved — Status Review Required/);
  assert.doesNotMatch(dashboard, /Awaiting Offer Acceptance/);
  assert.match(dashboard, /WAITING_FOR_DISBURSEMENT/);
  assert.match(adminLoans, /Approve Loan/);
  assert.match(adminLoans, /name="reason"[^>]+required/);
  assert.match(adminLoans, /name="approvedPrincipalKes"[^>]+required/);
});

test('an identical saved draft is resumed and HTTP 409 eligibility conflicts are actionable', () => {
  assert.match(loanPage, /matchesApplicationForm\(candidate, form\)/);
  assert.match(loanPage, /matchingApplication\.id/);
  assert.match(loanPage, /unresolvedPayment \|\| matchingApplication\.processingFeePayments\.some/);
  assert.match(loanPage, /eligibilityBlocked/);
  assert.match(loanPage, /Review its status in <Link href="\/dashboard">My Account/);
  assert.match(apiClient, /class ApiRequestError extends Error/);
  assert.match(apiClient, /new ApiRequestError\(/);
});

test('new fee requests respect outstanding disbursed loans but not loans awaiting disbursement', async () => {
  const loanEligibility = await readFile(new URL('../../api/src/loans/loan-eligibility.constants.ts', import.meta.url), 'utf8');
  const loanService = await readFile(new URL('../../api/src/loans/loan.service.ts', import.meta.url), 'utf8');
  const paymentService = await readFile(new URL('../../api/src/payments/payment.service.ts', import.meta.url), 'utf8');

  assert.match(loanEligibility, /DISBURSED/);
  assert.match(loanEligibility, /REPAYMENT_IN_PROGRESS/);
  assert.match(loanEligibility, /OVERDUE/);
  assert.match(loanService, /An outstanding disbursed loan is recorded/);
  assert.match(paymentService, /An outstanding disbursed loan is recorded/);
});

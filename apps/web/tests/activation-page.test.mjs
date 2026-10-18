import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const activationPage = await readFile(new URL('../src/app/activation/page.tsx', import.meta.url), 'utf8');
const loanPage = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');

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
  assert.match(loanPage, /Pay Loan Processing Fee — \$\{feeQuoteAmount\}/);
  assert.match(loanPage, /refundPolicyStatus/);
  assert.match(loanPage, /\/payments\/loan-processing-fee/);
  assert.match(loanPage, /reviewConfirmed: true/);
  assert.match(loanPage, /Refresh status/);
  assert.doesNotMatch(loanPage, /activationStatus/);
});

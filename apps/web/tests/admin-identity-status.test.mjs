import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const customerPage = await readFile(new URL('../src/app/admin/customers/page.tsx', import.meta.url), 'utf8');
const loanPage = await readFile(new URL('../src/app/admin/loans/page.tsx', import.meta.url), 'utf8');
const profilePage = await readFile(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
const trustPage = await readFile(new URL('../src/app/trust/page.tsx', import.meta.url), 'utf8');

test('Admin identity decisions require confirmation, review evidence, and a reason, then refresh status', () => {
  assert.match(customerPage, /Identity status<\/h3>/);
  assert.match(customerPage, /Mark as Verified/);
  assert.match(customerPage, /Reject verification/);
  assert.match(customerPage, /window\.confirm\(/);
  assert.match(customerPage, /required identity review using approved evidence/);
  assert.match(customerPage, /identityReason[\s\S]*minLength=\{10\}[\s\S]*required/);
  assert.match(customerPage, /identity-status/);
  assert.match(customerPage, /reviewConfirmed:/);
  assert.match(customerPage, /identityReview\?\.reviewerEmail/);
  assert.match(customerPage, /identityReview\.reviewedAt/);
  assert.match(customerPage, /setCustomerDetail\(refreshed\)/);
  assert.match(customerPage, /await refresh\(\)/);
  assert.match(customerPage, /Never enter National ID numbers, phone numbers, or document details/);
});

test('identity status remains visible in relevant customer and loan review screens', () => {
  assert.match(loanPage, /Identity status/);
  assert.match(profilePage, /Identity verification/);
  assert.match(trustPage, /Identity verification/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const customerPage = await readFile(new URL('../src/app/admin/customers/page.tsx', import.meta.url), 'utf8');
const loanPage = await readFile(new URL('../src/app/admin/loans/page.tsx', import.meta.url), 'utf8');
const profilePage = await readFile(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
const trustPage = await readFile(new URL('../src/app/trust/page.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/app/admin.css', import.meta.url), 'utf8');

test('Admin identity approval needs review confirmation but no reason; rejection retains its required reason', () => {
  assert.match(customerPage, /Identity status<\/h3>/);
  assert.match(customerPage, /'Approve'/);
  assert.match(customerPage, /Reject verification/);
  assert.match(customerPage, /required identity review using approved evidence/);
  assert.match(customerPage, /Reason for rejection<textarea name="identityReason" minLength=\{10\} maxLength=\{500\} rows=\{2\} required/);
  assert.match(customerPage, /body: JSON\.stringify\(\{ status, \.\.\.\(status === 'REJECTED' \? \{ reason \} : \{\}\), reviewConfirmed \}\)/);
  assert.match(customerPage, /identityRequestInFlight\.current/);
  assert.match(customerPage, /setIdentityBusy\(true\)/);
  assert.match(customerPage, /identity-status/);
  assert.match(customerPage, /reviewConfirmed:/);
  assert.match(customerPage, /identityReview\?\.reviewerEmail/);
  assert.match(customerPage, /identityReview\.reviewedAt/);
  assert.match(customerPage, /setCustomerDetail\(refreshed\)/);
  assert.match(customerPage, /await refresh\(\)/);
  assert.match(customerPage, /Never enter National ID numbers, phone numbers, or document details/);
});

test('customer details use responsive label-value layout and compact status badges', () => {
  assert.match(customerPage, /admin-customer-value-wide/);
  assert.match(customerPage, /Show full customer ID/);
  assert.match(customerPage, /admin-customer-long-value/);
  assert.match(customerPage, /data-label="Registered"/);
  assert.match(customerPage, /admin-customer-status/);
  assert.match(customerPage, /admin-customer-table/);
  assert.match(customerPage, /Search name, email, phone or customer ID/);
  assert.match(styles, /admin-customer-table \.admin-customer-list-row/);
  assert.match(styles, /overflow-wrap:anywhere/);
  assert.match(styles, /admin-customer-detail-grid\{display:grid;grid-template-columns:repeat\(auto-fit/);
});

test('identity status remains visible in relevant customer and loan review screens', () => {
  assert.match(loanPage, /Identity status/);
  assert.match(profilePage, /Identity verification/);
  assert.match(trustPage, /Identity verification/);
});

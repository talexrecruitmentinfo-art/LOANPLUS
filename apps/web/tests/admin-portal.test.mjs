import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shell = await readFile(new URL('../src/components/admin-portal-shell.tsx', import.meta.url), 'utf8');
const systemHealth = await readFile(new URL('../src/app/admin/system-health/page.tsx', import.meta.url), 'utf8');
const customers = await readFile(new URL('../src/app/admin/customers/page.tsx', import.meta.url), 'utf8');
const audit = await readFile(new URL('../src/app/admin/audit/page.tsx', import.meta.url), 'utf8');
const payments = await readFile(new URL('../src/app/admin/payments/page.tsx', import.meta.url), 'utf8');
const reconciliation = await readFile(new URL('../src/app/admin/reconciliation/page.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/app/admin.css', import.meta.url), 'utf8');
const adminController = await readFile(new URL('../../api/src/admin/admin.controller.ts', import.meta.url), 'utf8');
const adminService = await readFile(new URL('../../api/src/admin/admin.service.ts', import.meta.url), 'utf8');

test('Admin portal uses a responsive, Admin-scoped shell and preserves the dedicated login page', () => {
  for (const route of ['/admin', '/admin/customers', '/admin/loans', '/admin/disbursements', '/admin/payments', '/admin/reconciliation', '/admin/website', '/admin/support', '/admin/audit', '/admin/settings', '/admin/system-health']) {
    assert.ok(shell.includes(`href: '${route}'`), `expected Admin navigation route ${route}`);
  }
  assert.match(shell, /pathname === '\/admin\/login'/);
  assert.match(styles, /\.admin-sidebar/);
  assert.match(styles, /@media\(max-width:760px\)/);
  assert.match(styles, /\.admin-app-shell>\.admin-app-nav/);
  assert.match(styles, /:focus-visible/);
});

test('system health uses persisted Superadmin observations with explicit unknown, stale, and failure states', () => {
  assert.match(shell, /href: '\/admin\/system-health'/);
  assert.match(systemHealth, /\/admin\/system-health\/check/);
  assert.match(systemHealth, /observations become stale/);
  assert.match(systemHealth, /Unknown means the component was not verified/);
  assert.match(systemHealth, /No incident records match these filters/);
  assert.match(systemHealth, /Incident acknowledged\. It remains active until a health check confirms recovery\./);
  assert.match(systemHealth, /role="alert"/);
  assert.match(systemHealth, /POTENTIAL|CONFIRMED/);
  assert.match(systemHealth, /incidentPagination/);
  assert.match(systemHealth, /Apply filters/);
});

test('customer management uses server pagination and authorized status/date filters without selecting sensitive fields', () => {
  assert.match(customers, /pageSize: '25'/);
  assert.match(customers, /accountStatus/);
  assert.match(customers, /identityStatus/);
  assert.match(customers, /registeredFrom/);
  assert.match(customers, /registeredTo/);
  assert.match(customers, /\/admin\/customers\/\$\{encodeURIComponent\(customerId\)\}/);
  assert.match(customers, /window\.confirm/);
  assert.match(adminController, /@Patch\('customers\/:id\/status'\)/);
  assert.match(adminService, /customerSession\.updateMany/);
  assert.match(adminService, /CUSTOMER_SUSPENDED/);
  assert.match(adminService, /getCustomerDetails/);
  assert.match(adminController, /@UseGuards\(SuperadminSessionGuard\)/);
  assert.doesNotMatch(adminService, /passwordHash|nationalIdCiphertext/);
  assert.match(adminService, /skip: \(options\.page - 1\) \* options\.pageSize/);
  assert.match(customers, /No matching customer records/);
  assert.match(customers, /\/profile/);
  assert.match(customers, /password-reset/);
  assert.match(customers, /The reset link is not available to Admins/);
  assert.match(customers, /customer\.phoneMasked/);
});

test('Admin profile edits and password reset remain reason-required, optimistic, and secret-free', () => {
  assert.match(adminController, /@Patch\('customers\/:id\/profile'\)/);
  assert.match(adminController, /@Post\('customers\/:id\/password-reset'\)/);
  assert.match(adminController, /@Throttle/);
  assert.match(adminService, /expectedUpdatedAt/);
  assert.match(adminService, /CUSTOMER_PROFILE_UPDATED/);
  assert.match(audit, /pageSize: '25'/);
  assert.match(audit, /Safe event details/);
});

test('payment monitoring filters and paginates server-side while preserving unresolved legacy 4999 outcomes', () => {
  assert.match(payments, /params\.set\('type'/);
  assert.match(payments, /params\.set\('from'/);
  assert.match(payments, /params\.set\('to'/);
  assert.match(payments, /pageSize: '25'/);
  assert.match(payments, /payment\.failureCode === 'MPESA_RESULT_4999'/);
  assert.match(payments, /UNRESOLVED · 4999/);
  assert.match(adminService, /failureCode: 'MPESA_RESULT_4999'/);
});

test('Admin reconciliation requires supplied Safaricom IDs only for uncertain initiations', () => {
  assert.match(reconciliation, /needsProviderIdentifiers/);
  assert.match(reconciliation, /Safaricom AccountReference/);
  assert.match(reconciliation, /Safaricom checkout request ID/);
  assert.match(reconciliation, /Safaricom merchant request ID/);
  assert.match(reconciliation, /accountReference: identifiers\?\.accountReference\.trim\(\)/);
  assert.match(reconciliation, /checkoutRequestId: identifiers\?\.checkoutRequestId\.trim\(\)/);
  assert.match(reconciliation, /merchantRequestId: identifiers\?\.merchantRequestId\.trim\(\)/);
  assert.match(reconciliation, /different Superadmin must verify it before LoanPlus queries Safaricom/);
  assert.match(reconciliation, /\/verify-evidence/);
  assert.match(reconciliation, /EVIDENCE_SUBMITTED_AWAITING_REVIEW/);
});

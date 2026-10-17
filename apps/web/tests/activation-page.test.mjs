import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../src/app/activation/page.tsx', import.meta.url), 'utf8');

test('activation page does not render internal M-Pesa destination details', () => {
  assert.doesNotMatch(page, /M-Pesa business destination|\bTill\b|Paybill|businessShortCode|tillNumber/i);
  assert.doesNotMatch(page, /terms\.destination/);
});

test('activation payment display is loaded from the authenticated status endpoint', () => {
  assert.match(page, /apiRequest<ActivationStatus>\('\/payments\/activation\/status'\)/);
  assert.match(page, /activation\?\.payment/);
  assert.doesNotMatch(page, /createdAt:\s*new Date\(\)\.toISOString\(\)/);
});

test('pending requests cannot be replaced by another payment attempt', () => {
  assert.match(page, /paymentPending/);
  assert.match(page, /paymentAttemptUnresolved && !activation\?\.payment/);
  assert.match(page, /!statusLoaded/);
  assert.match(page, /Boolean\(statusError\)/);
  assert.match(page, /Refresh payment status/);
});

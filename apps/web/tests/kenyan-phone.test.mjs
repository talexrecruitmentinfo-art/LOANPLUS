import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeKenyanPhone } from '../src/lib/kenyan-phone.mjs';

const walletPage = await readFile(new URL('../src/components/customer-ledger.tsx', import.meta.url), 'utf8');
const loanPage = await readFile(new URL('../src/app/loans/page.tsx', import.meta.url), 'utf8');

test('normalizes Kenyan payment phone formats to the backend canonical format', () => {
  for (const phone of ['0712345678', '0712 345 678', '(0712) 345-678']) {
    assert.equal(normalizeKenyanPhone(phone), '+254712345678');
  }
  for (const phone of ['+254712345678', '+254 712 345 678', '254 712 345 678']) {
    assert.equal(normalizeKenyanPhone(phone), '+254712345678');
  }
  assert.equal(normalizeKenyanPhone('0112-345-678'), '+254112345678');
});

test('rejects phone values the backend cannot normalize', () => {
  for (const phone of ['071234567', '07123456789', '1234567890', '+25471234567A', '0712abc5678']) {
    assert.equal(normalizeKenyanPhone(phone), null);
  }
});

test('payment forms use a valid browser phone pattern and normalize before submit', () => {
  const pattern = String.raw`\+?[\d\x20\x28\x29\x2D]{9,16}`;
  const browserPattern = new RegExp(`^(?:${pattern})$`, 'v');
  for (const phone of ['0712345678', '(0712) 345-678', '+254 712 345 678']) {
    assert.equal(browserPattern.test(phone), true);
  }
  assert.match(walletPage, /pattern="\\\+\?\[\\d\\x20\\x28\\x29\\x2D\]\{9,16\}"/);
  assert.match(loanPage, /pattern="\\\+\?\[\\d\\x20\\x28\\x29\\x2D\]\{9,16\}"/);
  assert.match(walletPage, /mpesaPhoneNumber: normalizedPhoneNumber/);
  assert.match(loanPage, /mpesaPhoneNumber: normalizedMpesaPhoneNumber/);
});

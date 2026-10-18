import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = await readFile(new URL('../src/app/manifest.ts', import.meta.url), 'utf8');
const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../src/components/customer-app-shell.tsx', import.meta.url), 'utf8');
const profile = await readFile(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
const releaseRoute = await readFile(new URL('../src/app/api/release/route.ts', import.meta.url), 'utf8');

test('PWA manifest declares LoanPlus standalone scope and application icons', () => {
  assert.match(manifest, /name: 'LoanPlus'/);
  assert.match(manifest, /short_name: 'LoanPlus'/);
  assert.match(manifest, /display: 'standalone'/);
  assert.match(manifest, /start_url: '\/dashboard'/);
  assert.match(manifest, /scope: '\/'/);
  assert.match(manifest, /loanplus-192\.png/);
  assert.match(manifest, /loanplus-512\.png/);
  assert.match(manifest, /purpose: 'maskable'/);
});

test('service worker caches only same-origin public static assets', () => {
  assert.match(worker, /request\.method !== 'GET'/);
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.match(worker, /url\.pathname\.startsWith\('\/_next\/static\/'\)/);
  assert.match(worker, /url\.pathname\.startsWith\('\/icons\/'\)/);
  assert.match(worker, /url\.pathname === '\/manifest\.webmanifest'/);
  assert.doesNotMatch(worker, /\/wallet|\/payments|\/auth|\/loans\/applications/);
});

test('profile installation entry checks backend eligibility and includes browser-specific guidance', () => {
  assert.match(profile, /\/platform\/pwa\/eligibility/);
  assert.match(profile, /beforeinstallprompt/);
  assert.match(profile, /appinstalled/);
  assert.match(profile, /display-mode: standalone/);
  assert.match(profile, /Add to Home Screen/);
});

test('frontend release endpoint has a safe explicit unknown fallback', () => {
  assert.match(releaseRoute, /dynamic = 'force-dynamic'/);
  assert.match(releaseRoute, /VERCEL_GIT_COMMIT_SHA/);
  assert.match(releaseRoute, /releaseId: 'unknown'/);
  assert.match(releaseRoute, /\^\[a-f0-9\]\{7,40\}\$/i);
  assert.doesNotMatch(releaseRoute, /process\.env\s*\}/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import { startPolling } from '../src/lib/polling.mjs';

const refreshIntervalMs = 300_000;
const systemHealthPage = await readFile(new URL('../src/app/admin/system-health/page.tsx', import.meta.url), 'utf8');

test('polling runs immediately, waits five minutes, and stops on cleanup', async (context) => {
  mock.timers.enable({ apis: ['setInterval'] });
  context.after(() => mock.timers.reset());

  let refreshCount = 0;
  const polling = startPolling(async () => { refreshCount += 1; }, refreshIntervalMs);
  await Promise.resolve();

  assert.equal(refreshCount, 1);
  mock.timers.tick(refreshIntervalMs - 1);
  await Promise.resolve();
  assert.equal(refreshCount, 1);
  mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(refreshCount, 2);

  polling.stop();
  mock.timers.tick(refreshIntervalMs);
  assert.equal(refreshCount, 2);
});

test('polling does not overlap a refresh already in flight', async (context) => {
  mock.timers.enable({ apis: ['setInterval'] });
  context.after(() => mock.timers.reset());

  let refreshCount = 0;
  let releaseRefresh;
  const polling = startPolling(() => {
    refreshCount += 1;
    if (refreshCount === 1) return new Promise((resolve) => { releaseRefresh = resolve; });
    return Promise.resolve();
  }, refreshIntervalMs);

  mock.timers.tick(refreshIntervalMs);
  assert.equal(refreshCount, 1);
  releaseRefresh();
  await Promise.resolve();
  await Promise.resolve();
  mock.timers.tick(refreshIntervalMs);
  assert.equal(refreshCount, 2);

  polling.stop();
});

test('polling continues after a failed refresh and reports its result', async (context) => {
  mock.timers.enable({ apis: ['setInterval'] });
  context.after(() => mock.timers.reset());

  let refreshCount = 0;
  const polling = startPolling(async () => {
    refreshCount += 1;
    if (refreshCount === 1) throw new Error('temporary read failure');
  }, refreshIntervalMs);
  await Promise.resolve();

  assert.equal(refreshCount, 1);
  mock.timers.tick(refreshIntervalMs);
  await Promise.resolve();
  assert.equal(refreshCount, 2);
  polling.stop();
});

test('System Health retains prior dashboard data and exposes stale state on fetch failure', () => {
  assert.match(systemHealthPage, /setDashboard\(result\)/);
  assert.match(systemHealthPage, /setStaleData\(hasLoadedDashboard\.current\)/);
  assert.match(systemHealthPage, /if \(controller\.signal\.aborted\) return/);
  assert.match(systemHealthPage, /signal: controller\.signal/);
  assert.match(systemHealthPage, /refreshQueued\.current = true/);
  assert.match(systemHealthPage, /if \(refreshQueued\.current\)/);
  assert.match(systemHealthPage, /Last successful page refresh/);
  assert.match(systemHealthPage, /Showing the last successful data/);
  assert.match(systemHealthPage, /Refresh now/);
  assert.match(systemHealthPage, /startPolling\(refresh, 300_000\)/);
  assert.match(systemHealthPage, /activeRequest\.current\?\.abort\(\)/);
  assert.match(systemHealthPage, /if \(!result\.persisted\) setError\(result\.persistenceMessage\)/);
});
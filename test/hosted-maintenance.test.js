import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccount, createTenant, openRegistry } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAINTENANCE = join(ROOT, 'tools', 'hosted-maintenance.mjs');

function run(dataDir, port) {
  const result = spawnSync(process.execPath, [MAINTENANCE, '--data', dataDir, '--port', String(port)], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('hosted maintenance dry-run records outcomes and an overlapping lock fails without running jobs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dataDir = join(root, 'data');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const registry = openRegistry(join(dataDir, 'saas.db'));
  const accountId = await createAccount(registry, { email: 'owner@example.test', password: 'synthetic long password' });
  const pool = createPool({ root: join(dataDir, 'tenants') });
  const tenant = createTenant(registry, pool, { ownerAccountId: accountId, email: 'owner@example.test', name: 'Synthetic practice' });
  pool.closeAll();
  registry.close();

  const dryRun = run(dataDir, port);
  const statusFile = join(dataDir, 'hosted-maintenance-status.json');
  assert.equal(dryRun.status, 0, `${dryRun.output}\n${readFileSync(statusFile, 'utf8')}`);
  const status = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(status.state, 'success');
  assert.equal(status.mode, 'dry-run');
  assert.equal(status.tenants, 1);
  assert.ok(status.outcomes.every((outcome) => outcome.state === 'ok'));
  assert.equal(existsSync(join(dataDir, '.hosted-operations.lock')), false, 'the wrapper lock is released');

  writeFileSync(join(dataDir, '.hosted-operations.lock'), 'operator-owned active lock\n', { mode: 0o600 });
  const overlap = run(dataDir, port);
  assert.equal(overlap.status, 1);
  assert.match(overlap.output, /maintenance.failed/);
  assert.equal(readFileSync(join(dataDir, '.hosted-operations.lock'), 'utf8'), 'operator-owned active lock\n', 'a competing lock is never removed');
  const failed = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.outcomes[0].name, 'hosted-maintenance');
  assert.match(failed.outcomes[0].reason, /another hosted operation holds the lock/);
  const finalRegistry = openRegistry(join(dataDir, 'saas.db'));
  try { assert.equal(finalRegistry.prepare('SELECT id FROM tenant').get().id, tenant.id, 'dry-run and lock failure preserve the tenant'); }
  finally { finalRegistry.close(); }
});

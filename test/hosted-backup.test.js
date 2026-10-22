import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccount, createTenant, openRegistry } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOL = join(ROOT, 'tools', 'hosted-backup.mjs');
const FAKE_RESTIC = join(ROOT, 'test', 'fixtures', 'fake-restic.mjs');

async function install(root) {
  const data = join(root, 'data');
  const registry = openRegistry(join(data, 'saas.db'));
  const owner = await createAccount(registry, { email: 'backup@example.test', password: 'synthetic long password' });
  const pool = createPool({ root: join(data, 'tenants') });
  const tenant = createTenant(registry, pool, { ownerAccountId: owner, email: 'backup@example.test', name: 'Synthetic practice' });
  registry.close();
  pool.closeAll();
  return { data, tenantId: tenant.id };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function invoke(data, root, { failCommand, hold, lock } = {}) {
  const state = join(root, 'restic-state.json');
  const passwordFile = join(root, 'restic-password');
  const status = join(data, 'hosted-backup-status.json');
  const stage = join(root, 'stage');
  mkdirSync(stage, { recursive: true });
  writeFileSync(passwordFile, 'synthetic repository password\n', { mode: 0o600 });
  if (hold) {
    const registry = openRegistry(join(data, 'saas.db'));
    registry.prepare('UPDATE tenant SET retention_hold_until = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', hold);
    registry.close();
  }
  if (lock) writeFileSync(join(data, '.hosted-operations.lock'), JSON.stringify({ pid: 123 }));
  const env = {
    ...process.env,
    TICKMARK_PORT: String(await freePort()),
    RESTIC_REPOSITORY: 'test-repository',
    RESTIC_PASSWORD_FILE: passwordFile,
    RESTIC_BIN_ARGS: JSON.stringify([FAKE_RESTIC]),
    RESTIC_TEST_STATE: state,
    ...(failCommand ? { RESTIC_TEST_FAIL_COMMAND: failCommand } : {}),
  };
  writeFileSync(state, JSON.stringify({ commands: [], snapshots: [] }));
  const result = spawnSync(process.execPath, [TOOL, '--data', data, '--staging', stage, '--status', status, '--restic-bin', process.execPath], { encoding: 'utf8', env });
  return { ...result, state: JSON.parse(readFileSync(state, 'utf8')), backupStatus: JSON.parse(readFileSync(status, 'utf8')) };
}

test('hosted backup encrypts, verifies, prunes only after upload, and records remote success', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-hosted-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { data } = await install(root);
  const result = await invoke(data, root);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(result.state.commands.map((entry) => entry.command), ['backup', 'forget', 'check', 'snapshots']);
  assert.ok(result.state.commands.find((entry) => entry.command === 'forget').args.includes('--prune'));
  assert.equal(result.backupStatus.state, 'success');
  assert.equal(result.backupStatus.practices, 1);
  assert.equal(result.backupStatus.retentionDays, 35);
  assert.equal(existsSync(join(data, '.hosted-operations.lock')), false);
});

test('an active retention hold defers expiry and an upload failure never prunes old snapshots', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-hosted-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { data, tenantId } = await install(root);

  const held = await invoke(data, root, { hold: tenantId });
  assert.equal(held.status, 0, `${held.stdout}${held.stderr}`);
  assert.equal(held.backupStatus.retentionDeferred, true);
  assert.equal(held.state.commands.some((entry) => entry.command === 'forget'), false, 'shared history is retained while a hold exists');

  const failed = await invoke(data, root, { failCommand: 'backup' });
  assert.equal(failed.status, 1);
  assert.equal(failed.backupStatus.state, 'failed');
  assert.equal(failed.state.commands.some((entry) => entry.command === 'forget'), false, 'a failed off-site upload never expires the last good copy');
});

test('overlapping backup execution fails closed without replacing the running job status', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-hosted-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { data } = await install(root);
  const marker = join(data, 'hosted-backup-status.json');
  writeFileSync(marker, JSON.stringify({ format: 'tickmark-hosted-backup-status', version: 1, state: 'success', completedAt: new Date().toISOString() }));
  const runningStatus = readFileSync(marker, 'utf8');
  const result = await invoke(data, root, { lock: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /holds the lock/);
  assert.equal(readFileSync(marker, 'utf8'), runningStatus);
});

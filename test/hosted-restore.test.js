import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccount, createTenant, openRegistry } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';
import { completeTenantDeletion, requestTenantDeletion } from '../src/tenancy/offboarding.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BACKUP = join(ROOT, 'tools', 'backup-all.mjs');
const RESTORE = join(ROOT, 'tools', 'restore-hosted.mjs');
const HISTORY = join(ROOT, 'tools', 'backup-tenant-history.mjs');
const FAKE_RESTIC = join(ROOT, 'test', 'fixtures', 'fake-restic.mjs');

function run(tool, args, env = process.env) {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('a full hosted restore replays the latest deletion tombstone before exposing the service', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-hosted-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'primary');
  const tenantsRoot = join(data, 'tenants');
  const registry = openRegistry(join(data, 'saas.db'));
  const ownerId = await createAccount(registry, { email: 'recovery@example.test', password: 'synthetic long password' });
  const pool = createPool({ root: tenantsRoot });
  const erased = createTenant(registry, pool, { ownerAccountId: ownerId, email: 'recovery@example.test', name: 'Erased test practice' });
  const survivor = createTenant(registry, pool, { ownerAccountId: ownerId, email: 'recovery@example.test', name: 'Surviving test practice' });
  pool.closeAll();
  registry.close();

  const oldSnapshot = join(root, 'old-snapshot');
  const oldTake = run(BACKUP, ['--data', data, '--to', oldSnapshot, '--quiet']);
  assert.equal(oldTake.status, 0, oldTake.output);

  const deletionRegistry = openRegistry(join(data, 'saas.db'));
  const requested = requestTenantDeletion(deletionRegistry, {
    tenantId: erased.id,
    ownerAccountId: ownerId,
    retentionDays: 0,
    at: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(requested.state, 'requested');
  const deleted = await completeTenantDeletion(deletionRegistry, {
    tenantId: erased.id,
    tenantsRoot,
    confirmTenantId: erased.id,
    at: new Date('2026-02-01T00:00:00.000Z'),
  });
  assert.equal(deleted.state, 'deleted');
  deletionRegistry.close();

  const latestSnapshot = join(root, 'latest-snapshot');
  const latestTake = run(BACKUP, ['--data', data, '--to', latestSnapshot, '--quiet']);
  assert.equal(latestTake.status, 0, latestTake.output);
  const snapshots = [
    { id: '1111111111111111', short_id: '11111111', time: '2026-10-21T05:00:00.000Z', tags: ['tickmark-hosted'] },
    { id: '2222222222222222', short_id: '22222222', time: new Date().toISOString(), tags: ['tickmark-hosted'] },
  ];
  const state = join(root, 'restic-state.json');
  writeFileSync(state, JSON.stringify({ commands: [], snapshots }));
  const passwordFile = join(root, 'restic-password');
  writeFileSync(passwordFile, 'synthetic Restic passphrase\n', { mode: 0o600 });
  const target = join(root, 'restored-data');
  const env = {
    ...process.env,
    RESTIC_REPOSITORY: 'synthetic-repository',
    RESTIC_PASSWORD_FILE: passwordFile,
    RESTIC_BIN_ARGS: JSON.stringify([FAKE_RESTIC]),
    RESTIC_TEST_STATE: state,
    RESTIC_TEST_RESTORE_ROOT: oldSnapshot,
    RESTIC_TEST_LEDGER_FILE: join(latestSnapshot, 'fleet.json'),
    RESTIC_TEST_SNAPSHOT_MAP: JSON.stringify({
      [snapshots[0].id]: join(oldSnapshot, 'fleet.json'),
      [snapshots[1].id]: join(latestSnapshot, 'fleet.json'),
    }),
  };
  const restored = run(RESTORE, ['--snapshot', snapshots[0].id, '--to', target, '--staging', root, '--restic-bin', process.execPath], env);
  assert.equal(restored.status, 0, restored.output);
  const evidence = JSON.parse(restored.output.trim().split(/\r?\n/).at(-1));
  assert.equal(evidence.event, 'restore.completed');
  assert.equal(evidence.snapshotId, snapshots[0].short_id);
  assert.ok(evidence.recoveryPointAgeMs > 0);
  assert.ok(evidence.restoreDurationMs >= 0);
  assert.equal(evidence.serviceStarted, false);
  t.diagnostic(`synthetic restore evidence: snapshotAt=${evidence.snapshotAt}, recoveryPointAgeMs=${evidence.recoveryPointAgeMs}, restoreDurationMs=${evidence.restoreDurationMs}`);

  const restoredRegistry = openRegistry(join(target, 'saas.db'));
  try {
    assert.equal(restoredRegistry.prepare('SELECT COUNT(*) AS n FROM tenant').get().n, 1, 'the surviving registry relationship remains');
    assert.equal(restoredRegistry.prepare('SELECT state FROM tenant_deletion WHERE tenant_id = ?').get(erased.id).state, 'deleted');
    assert.equal(restoredRegistry.prepare('SELECT id FROM tenant').get().id, survivor.id);
  } finally {
    restoredRegistry.close();
  }
  assert.equal(existsSync(join(target, 'tenants', erased.id)), false, 'the older snapshot cannot resurrect deleted practice data');
  assert.equal(existsSync(join(target, 'tenants', survivor.id, 'tickmark.db')), true);
  const commands = JSON.parse(readFileSync(state, 'utf8')).commands;
  assert.ok(commands.some((entry) => entry.command === 'dump'), 'latest deletion ledger was read from the encrypted repository');
  assert.ok(commands.some((entry) => entry.command === 'restore'), 'the selected complete snapshot was restored');

  const history = run(HISTORY, ['--tenant', erased.id, '--restic-bin', process.execPath], env);
  assert.equal(history.status, 0, history.output);
  const report = JSON.parse(history.output.trim());
  assert.equal(report.earliestContainingSnapshot.id, snapshots[0].short_id);
  assert.equal(report.latestContainingSnapshot.id, snapshots[0].short_id);
  assert.equal(report.snapshots[0].outsideNormalRetentionWindow, false);
});

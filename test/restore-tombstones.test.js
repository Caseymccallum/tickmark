import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAccount, createTenant, openRegistry } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';
import { applyBackupDeletionTombstones } from '../src/tenancy/restore-tombstones.js';

test('a newer deletion tombstone prevents an older snapshot from restoring access or data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-tombstones-'));
  const tenantsRoot = join(root, 'tenants');
  const registry = openRegistry(join(root, 'saas.db'));
  const pool = createPool({ root: tenantsRoot });
  t.after(() => { pool.closeAll(); registry.close(); rmSync(root, { recursive: true, force: true }); });

  const owner = await createAccount(registry, { email: 'restore@example.test', password: 'long enough synthetic password' });
  const erased = createTenant(registry, pool, { ownerAccountId: owner, email: 'restore@example.test', name: 'Erased synthetic practice' });
  const held = createTenant(registry, pool, { ownerAccountId: owner, email: 'restore@example.test', name: 'Held synthetic practice' });
  pool.closeAll();
  const erasedDir = join(tenantsRoot, erased.id);
  const heldDir = join(tenantsRoot, held.id);
  const digest = (letter) => letter.repeat(64);
  const tombstones = [
    { tenant_id: erased.id, slug_digest: digest('a'), state: 'deleted', requested_at: '2026-01-01T00:00:00.000Z', delete_after: '2026-02-01T00:00:00.000Z', completed_at: '2026-03-01T00:00:00.000Z', retention_hold_until: null },
    { tenant_id: held.id, slug_digest: digest('b'), state: 'deleted', requested_at: '2026-01-01T00:00:00.000Z', delete_after: '2026-02-01T00:00:00.000Z', completed_at: '2026-03-01T00:00:00.000Z', retention_hold_until: '2027-01-01T00:00:00.000Z' },
  ];

  const results = await applyBackupDeletionTombstones(registry, {
    tenantsRoot,
    tombstones,
    at: new Date('2026-10-22T00:00:00.000Z'),
  });
  assert.deepEqual(results.map((row) => row.state), ['deleted', 'retention-hold']);
  assert.equal(existsSync(erasedDir), false, 'the already-deleted practice is removed from the older restore');
  assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM tenant WHERE id = ?').get(erased.id).n, 0);
  assert.equal(existsSync(heldDir), true, 'a held practice remains available to honour the hold');
  assert.equal(registry.prepare('SELECT lifecycle_state FROM tenant WHERE id = ?').get(held.id).lifecycle_state, 'deleting', 'held data stays inaccessible');

  const retried = await applyBackupDeletionTombstones(registry, {
    tenantsRoot,
    tombstones: [tombstones[1]],
    at: new Date('2027-01-02T00:00:00.000Z'),
  });
  assert.equal(retried[0].state, 'deleted', 'expiry and retry finish the held tombstone idempotently');
  assert.equal(existsSync(heldDir), false);
});

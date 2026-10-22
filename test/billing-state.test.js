import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyStripeEvent } from '../src/tenancy/billing.js';
import { openRegistry } from '../src/tenancy/registry.js';

function fixture(directory) {
  const registry = openRegistry(join(directory, 'saas.db'));
  const at = new Date().toISOString();
  registry.prepare('INSERT INTO account (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('owner', 'owner@example.test', 'test-hash', at);
  registry.prepare('INSERT INTO tenant (id, practice_id, slug, name, owner_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('tenant-one', 'practice-one', 'one', 'Practice One', 'owner', 'pending_payment', at);
  return registry;
}

test('billing state and durable receipt commit together and deduplicate after reopening registry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-billing-state-'));
  let registry = fixture(directory);
  const event = {
    id: 'evt_atomic_1', created: Math.floor(Date.now() / 1000), type: 'customer.subscription.created',
    data: { object: { id: 'sub_one', customer: 'cus_one', status: 'active', metadata: { tenant_id: 'tenant-one' } } },
  };

  try {
    registry.exec("CREATE TRIGGER fail_event_receipt BEFORE INSERT ON stripe_event BEGIN SELECT RAISE(FAIL, 'forced receipt failure'); END");
    assert.throws(() => applyStripeEvent(registry, event), /forced receipt failure/);
    assert.equal(registry.prepare('SELECT status FROM tenant WHERE id = ?').get('tenant-one').status, 'pending_payment');
    assert.equal(registry.prepare('SELECT count(*) AS n FROM stripe_event').get().n, 0);

    registry.exec('DROP TRIGGER fail_event_receipt');
    const first = applyStripeEvent(registry, event);
    assert.equal(first.outcome, 'applied');
    registry.close();

    registry = openRegistry(join(directory, 'saas.db'));
    const replay = applyStripeEvent(registry, event);
    assert.equal(replay.duplicate, true);
    assert.equal(registry.prepare('SELECT status FROM tenant WHERE id = ?').get('tenant-one').status, 'active');
    assert.equal(registry.prepare('SELECT count(*) AS n FROM stripe_event').get().n, 1);
  } finally {
    try { registry.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

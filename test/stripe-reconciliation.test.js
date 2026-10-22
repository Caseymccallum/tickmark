import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { reconcileStripeSubscription } from '../src/tenancy/billing.js';
import { openRegistry } from '../src/tenancy/registry.js';
import { retrieveSubscription, stripeFromEnvironment } from '../src/tenancy/stripe.js';

const TIME = new Date('2026-10-22T08:00:00.000Z');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-stripe-reconcile-'));
  const registry = openRegistry(join(directory, 'saas.db'));
  registry.prepare('INSERT INTO account (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('owner', 'owner@example.test', 'hash', TIME.toISOString());
  registry.prepare(
    `INSERT INTO tenant (id, practice_id, slug, name, owner_id, status, stripe_customer_id, stripe_subscription_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('tenant-one', 'practice-one', 'one', 'Practice One', 'owner', 'cancelled', 'cus_one', 'sub_old', TIME.toISOString());
  return { directory, registry };
}

test('Stripe reconciliation retrieves authoritative state, checks associations and is idempotent', async () => {
  const { directory, registry } = fixture();
  const request = { tenantId: 'tenant-one', customerId: 'cus_one', subscriptionId: 'sub_new', operator: 'casey', at: () => TIME };
  try {
    await assert.rejects(reconcileStripeSubscription(registry, {
      ...request, retrieve: async () => ({ id: 'sub_other', customer: 'cus_one', status: 'active' }),
    }), /different customer or subscription/);
    assert.equal(registry.prepare('SELECT status FROM tenant WHERE id = ?').get('tenant-one').status, 'cancelled');
    assert.equal(registry.prepare('SELECT count(*) AS n FROM stripe_reconciliation').get().n, 0);

    const first = await reconcileStripeSubscription(registry, {
      ...request, retrieve: async () => ({ id: 'sub_new', customer: 'cus_one', status: 'active' }),
    });
    assert.equal(first.outcome, 'corrected', 'the verified current Stripe snapshot can bind a replacement after cancellation');
    assert.equal(first.after, 'active');
    assert.equal(registry.prepare('SELECT stripe_subscription_id FROM tenant WHERE id = ?').get('tenant-one').stripe_subscription_id, 'sub_new');
    assert.deepEqual(
      { ...registry.prepare('SELECT stripe_status, previous_status, resulting_status, outcome, operator FROM stripe_reconciliation').get() },
      { stripe_status: 'active', previous_status: 'cancelled', resulting_status: 'active', outcome: 'corrected', operator: 'casey' },
    );

    const repeated = await reconcileStripeSubscription(registry, {
      ...request, retrieve: async () => ({ id: 'sub_new', customer: 'cus_one', status: 'active' }),
    });
    assert.equal(repeated.outcome, 'confirmed', 'repeating the verified state makes no state transition');
    assert.equal(registry.prepare('SELECT status FROM tenant WHERE id = ?').get('tenant-one').status, 'active');
    assert.equal(registry.prepare('SELECT count(*) AS n FROM stripe_reconciliation').get().n, 2, 'each operator action remains reviewable');
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unavailable Stripe retrieval leaves local state and audit unchanged', async () => {
  const { directory, registry } = fixture();
  try {
    await assert.rejects(reconcileStripeSubscription(registry, {
      tenantId: 'tenant-one', customerId: 'cus_one', subscriptionId: 'sub_old', operator: 'casey',
      retrieve: async () => { throw new Error('network unavailable'); },
    }), /network unavailable/);
    assert.equal(registry.prepare('SELECT status FROM tenant WHERE id = ?').get('tenant-one').status, 'cancelled');
    assert.equal(registry.prepare('SELECT count(*) AS n FROM stripe_reconciliation').get().n, 0);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('subscription retrieval uses explicit Stripe API id and returns only reconciliation fields', async () => {
  const previous = globalThis.fetch;
  let called = null;
  globalThis.fetch = async (url, options) => {
    called = { url: String(url), authorization: options.headers.authorization };
    return { ok: true, status: 200, json: async () => ({ id: 'sub_test', customer: { id: 'cus_test' }, status: 'past_due', latest_invoice: 'not returned' }) };
  };
  try {
    const stripe = stripeFromEnvironment({ STRIPE_SECRET_KEY: 'sk_test_reconcile' });
    const result = await retrieveSubscription(stripe, 'sub_test');
    assert.equal(called.url, 'https://api.stripe.com/v1/subscriptions/sub_test');
    assert.equal(called.authorization, 'Bearer sk_test_reconcile');
    assert.deepEqual(result, { id: 'sub_test', customer: 'cus_test', status: 'past_due' });
  } finally {
    globalThis.fetch = previous;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCheckoutSession, stripeBillingReady, stripeFromEnvironment } from '../src/tenancy/stripe.js';
import { COMMERCIAL_PRICE } from '../src/tenancy/commercial-config.js';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_unit',
  STRIPE_PRICE_ID: 'price_tickmark_monthly',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_unit',
  TICKMARK_PUBLIC_URL: 'https://app.example.test',
};

test('public commercial copy stays aligned with the authoritative catalogue', () => {
  for (const path of ['README.md', 'site/index.html', 'docs/hosted-legal-drafts.md']) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), new RegExp(COMMERCIAL_PRICE.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('hosted billing fails closed for missing or contradictory configuration', () => {
  assert.equal(stripeFromEnvironment({}), null);
  assert.equal(stripeBillingReady(stripeFromEnvironment({ ...env, STRIPE_WEBHOOK_SECRET: '' })), false);
  assert.equal(stripeBillingReady(stripeFromEnvironment({ ...env, STRIPE_PRICE_ID: 'prod_default' })), false);
  assert.equal(stripeBillingReady(stripeFromEnvironment({ ...env, TICKMARK_PUBLIC_URL: 'http://app.example.test' })), false);
  assert.equal(stripeBillingReady(stripeFromEnvironment(env)), true);
});

test('Checkout verifies the server catalogue and explicitly requires payment details without a trial', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return String(url).includes('/prices/')
      ? { ok: true, status: 200, json: async () => ({ active: true, currency: 'gbp', unit_amount: 4900, recurring: { interval: 'month', interval_count: 1 } }) }
      : { ok: true, status: 200, json: async () => ({ id: 'cs_test', url: 'https://checkout.stripe.com/test' }) };
  };
  try {
    await createCheckoutSession(stripeFromEnvironment(env), {
      tenantId: 'tenant-1', tenantName: 'Example Practice', customerEmail: 'owner@example.test', customerId: 'cus_existing',
      successPath: '/billing/checkout/success', cancelPath: '/dashboard',
    });
    assert.equal(calls.length, 2);
    const checkout = new URLSearchParams(calls[1].init.body);
    assert.equal(checkout.get('payment_method_collection'), 'always');
    assert.equal(checkout.get('customer'), 'cus_existing', 're-subscription reuses the tenant customer');
    assert.equal(checkout.has('customer_email'), false);
    assert.equal(checkout.get('line_items[0][price]'), 'price_tickmark_monthly');
    assert.equal(checkout.has('subscription_data[trial_period_days]'), false);
    assert.equal(checkout.has('trial_period_days'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a wrong Stripe price is refused before a Checkout session is created', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ active: true, currency: 'usd', unit_amount: 2900, recurring: { interval: 'year', interval_count: 1 } }) };
  };
  try {
    await assert.rejects(
      createCheckoutSession(stripeFromEnvironment(env), {
        tenantId: 'tenant-1', tenantName: 'Example Practice', customerEmail: 'owner@example.test',
        successPath: '/billing/checkout/success', cancelPath: '/dashboard',
      }),
      /does not match the published monthly GBP catalogue/,
    );
    assert.equal(calls.length, 1, 'only the Price verification request was made');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

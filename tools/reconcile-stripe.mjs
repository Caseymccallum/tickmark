#!/usr/bin/env node
/** Reconcile one explicitly identified tenant from Stripe's current subscription object. */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { reconcileStripeSubscription } from '../src/tenancy/billing.js';
import { openRegistry } from '../src/tenancy/registry.js';
import { retrieveSubscription, stripeFromEnvironment } from '../src/tenancy/stripe.js';

const { values } = parseArgs({ options: {
  data: { type: 'string', default: process.env.TICKMARK_DATA ?? 'data' },
  tenant: { type: 'string' },
  customer: { type: 'string' },
  subscription: { type: 'string' },
  operator: { type: 'string' },
  'allow-live': { type: 'boolean', default: false },
} });

if (!values.tenant || !values.customer || !values.subscription || !values.operator) {
  console.error('usage: node tools/reconcile-stripe.mjs --tenant <tenant-id> --customer <cus_id> --subscription <sub_id> --operator <operator-name> [--data <data-dir>] [--allow-live]');
  process.exit(2);
}

const stripe = stripeFromEnvironment(process.env);
if (!stripe?.secretKey || !stripe.valid) {
  console.error('Stripe credentials are unavailable or invalid; no local billing state was changed.');
  process.exit(2);
}
if (stripe.secretKey.startsWith('sk_live_') && !values['allow-live']) {
  console.error('a live Stripe key requires the explicit --allow-live maintenance flag; no API request was made.');
  process.exit(2);
}

const registry = openRegistry(join(resolve(values.data), 'saas.db'));
try {
  const result = await reconcileStripeSubscription(registry, {
    tenantId: values.tenant,
    customerId: values.customer,
    subscriptionId: values.subscription,
    operator: values.operator,
    retrieve: () => retrieveSubscription(stripe, values.subscription),
  });
  console.log(JSON.stringify({ event: 'stripe.reconciled', ...result }));
} catch (error) {
  // Stripe's response body and credentials are intentionally not written to logs.
  const status = Number.isInteger(error.status) ? ` (HTTP ${error.status})` : '';
  const type = typeof error.type === 'string' ? ` ${error.type}` : '';
  console.error(JSON.stringify({ event: 'stripe.reconciliation-failed', error: `${error.name ?? 'Error'}${status}${type}`, stateChanged: false }));
  process.exitCode = 1;
} finally {
  registry.close();
}

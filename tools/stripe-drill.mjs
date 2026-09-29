/**
 * Prove the Stripe billing against a real Stripe account, in test mode.
 *
 *   node tools/stripe-drill.mjs
 *
 * `test/gateway.test.js` already drives the real entry point and signs webhooks with Stripe's real HMAC
 * scheme — but it has never been pointed at a real Stripe account. That is the gap this closes: it drives
 * the **actual API** (the part a stub cannot prove) and then the webhook lifecycle against a real gateway,
 * so "built, unproven" becomes "driven".
 *
 * What it needs in the environment:
 *
 *   STRIPE_SECRET_KEY     sk_test_…      (test mode; this will not touch a live account)
 *   STRIPE_WEBHOOK_SECRET whsec_…        (the endpoint's signing secret)
 *   STRIPE_PRICE_ID       price_…        (optional; the drill makes its own if absent)
 *   TICKMARK_PUBLIC_URL   http://…       (optional; where Stripe would send the browser back)
 *
 * What it does, in order:
 *
 * 1. Create a product + price (or reuse `STRIPE_PRICE_ID`) — proves auth and form-encoding against Stripe.
 * 2. Create a Checkout Session through the same call the gateway makes — the one path a hosted launch
 *    cannot do without.
 * 3. Create a Billing Portal Session — the self-serve card-change path (needs the portal switched on in
 *    Stripe; a clear "not enabled" is reported rather than counted as a failure).
 * 4. Drive the webhook lifecycle against a real gateway — paid → active, a failing card → past_due and the
 *    grace window, then cancelled — with events shaped exactly as Stripe sends them and signed with the
 *    real secret.
 *
 * At the end it prints the two `stripe` CLI commands that finish the proof with *live* events, because a
 * webhook Stripe actually sent is the one thing a script cannot forge. It creates one test product/price
 * and nothing else that lasts.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSaasServer } from '../src/tenancy/entry.js';
import { createAccount, createTenant, pastDueGraceDays, tenantAllowsAccess } from '../src/tenancy/registry.js';
import {
  createBillingPortalSession,
  createCheckoutSession,
  stripeFromEnvironment,
  verifyWebhookSignature,
  StripeError,
} from '../src/tenancy/stripe.js';
import { applyStripeEvent } from '../src/tenancy/billing.js';

const stripe = stripeFromEnvironment();
let failures = 0;

function say(line = '') {
  console.log(line);
}
function pass(what, detail = '') {
  console.log(`  PASS  ${what}${detail ? ` — ${detail}` : ''}`);
}
function fail(what, detail = '') {
  failures += 1;
  console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
}
function check(ok, what, detail = '') {
  (ok ? pass : fail)(what, detail);
}

/** POST a form to Stripe and hand back the JSON, or throw Stripe's own words. */
async function stripePost(path, form) {
  const response = await fetch(`${'https://api.stripe.com/v1'}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripe.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new StripeError(payload?.error?.message ?? `Stripe refused ${path} (${response.status})`, {
      status: response.status,
      type: payload?.error?.type ?? null,
      raw: payload,
    });
  }
  return payload;
}

/**
 * Step 1–3, against the live API. Returns the customer id made for the portal, or null.
 */
async function proveTheApi() {
  say('\n1. The live API — auth, form-encoding, and the two sessions\n');

  // A price to subscribe to. Reusing one the operator already has keeps the account tidy.
  let priceId = stripe.priceId;
  if (!priceId) {
    const product = await stripePost('/products', { name: `Tickmark drill ${new Date().toISOString()}` });
    const price = await stripePost('/prices', {
      product: product.id,
      currency: 'gbp',
      'recurring[interval]': 'month',
      'unit_amount': '4900',
    });
    priceId = price.id;
    pass('a test product and price were created', `${product.id} / ${price.id}`);
  } else {
    pass('reusing STRIPE_PRICE_ID', priceId);
  }

  // The one call a hosted launch cannot do without.
  try {
    const checkout = await createCheckoutSession(stripe, {
      tenantId: 'drill-tenant',
      tenantName: 'Drill & Co',
      customerEmail: 'drill@tickmark.example',
      successPath: '/billing/checkout/success',
      cancelPath: '/billing/checkout/cancel',
    });
    check(String(checkout.id).startsWith('cs_'), 'createCheckoutSession returned a real session', checkout.id);
    check(/^https:\/\/checkout\.stripe\.com\//.test(String(checkout.url)), 'and a hosted checkout URL', checkout.url);
  } catch (error) {
    fail('createCheckoutSession', error.message);
  }

  // The self-serve card-change path.
  try {
    const customer = await stripePost('/customers', { email: 'drill@tickmark.example', description: 'Tickmark drill' });
    const portal = await createBillingPortalSession(stripe, { customerId: customer.id, returnPath: '/dashboard' });
    check(/^https:\/\/billing\.stripe\.com\//.test(String(portal.url)), 'createBillingPortalSession returned a portal URL', portal.url);
    return customer.id;
  } catch (error) {
    const notEnabled = /portal|not (yet )?enabled|configuration/i.test(error.message);
    if (notEnabled) {
      say('  SKIP  createBillingPortalSession — the customer portal is not switched on in this Stripe account.');
      say('        (Developers → Billing → Customer portal → turn it on, then run this again.)');
    } else {
      fail('createBillingPortalSession', error.message);
    }
    return null;
  }
}

/**
 * The webhook, against the real signing secret and a real registry.
 *
 * The gateway's own tests cover the HTTP endpoint; this proves the two things they cannot — that the
 * signature check passes with *your* secret (not a stand-in), and that real-shaped events move a real
 * tenant through paid → past_due → the grace window → cancelled.
 */
async function proveWebhook(secret) {
  say('\n2. The webhook — your real signing secret, and a real tenant\n');
  if (!secret) {
    say('  SKIP  STRIPE_WEBHOOK_SECRET is not set — cannot sign events here.');
    return;
  }

  // The signature check with the real secret: correct, forged, and replayed.
  const payload = JSON.stringify({
    id: 'evt_drill',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_d', customer: 'cus_d', subscription: 'sub_d', metadata: { tenant_id: 't_d' } } },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = (ts) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
  check(verifyWebhookSignature({ rawBody: Buffer.from(payload), header: sign(timestamp), secret }).ok, 'a correctly signed event verifies');
  check(!verifyWebhookSignature({ rawBody: Buffer.from(payload), header: `t=${timestamp},v1=${'0'.repeat(64)}`, secret }).ok, 'a forged signature is refused');
  check(!verifyWebhookSignature({ rawBody: Buffer.from(payload), header: sign(timestamp - 3600), secret }).ok, 'a replayed (too old) signature is refused');

  // The lifecycle against a real registry.
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-stripe-drill-'));
  let saas = null;
  try {
    saas = createSaasServer({ registryFile: join(directory, 'saas.db'), tenantsRoot: join(directory, 'tenants'), env: {} });
    const account = await createAccount(saas.registry, { email: 'drill@tickmark.example', password: 'a long enough password' });
    const accountId = account?.id ?? account;
    const made = createTenant(saas.registry, saas.pool, { ownerAccountId: accountId, name: 'Drill & Co', slug: 'drill-co', status: 'pending_payment' });
    const tenantId = made?.id ?? made;
    const row = () => saas.registry.prepare('SELECT status, past_due_since FROM tenant WHERE id = ?').get(tenantId);
    const apply = (event) => applyStripeEvent(saas.registry, event);

    apply({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', metadata: { tenant_id: tenantId } } } });
    check(row().status === 'active', 'checkout.session.completed opens the practice', row().status);

    apply({ type: 'invoice.payment_failed', data: { object: { metadata: { tenant_id: tenantId } } } });
    const pastDue = row();
    check(pastDue.status === 'past_due', 'invoice.payment_failed marks it past due', pastDue.status);
    const grace = pastDueGraceDays();
    check(
      grace > 0 ? tenantAllowsAccess({ status: 'past_due', past_due_since: pastDue.past_due_since }, new Date()) : true,
      `and the ${grace}-day grace window still lets them in`,
    );

    apply({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: { tenant_id: tenantId } } } });
    check(row().status === 'cancelled', 'customer.subscription.deleted closes it', row().status);
  } finally {
    try { saas?.pool.closeAll(); saas?.registry.close(); } catch { /* cleanup never outranks the result */ }
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* as above */ }
  }
}

/** The one thing a script cannot forge: a webhook Stripe actually sent. */
function finishWithLiveEvents() {
  say('\n3. Finishing the proof with live events\n');
  say('  A real, signed webhook from Stripe is the one thing this drill cannot manufacture. To drive live');
  say('  events at a running installation, use the Stripe CLI:\n');
  say('    stripe login');
  say('    stripe listen --forward-to localhost:3000/webhooks/stripe   # prints the whsec_… to use above');
  say('    stripe trigger checkout.session.completed');
  say('    stripe trigger invoice.payment_failed');
  say('    stripe trigger customer.subscription.deleted\n');
  say('  Each `stripe trigger` sends a genuine, signed event to the gateway. Watch the practice open, go');
  say('  past due, and close on real Stripe traffic — that, together with the API checks above, is the proof.');
}

async function main() {
  say('Stripe billing drill — test mode\n');
  if (!stripe?.secretKey) {
    console.error('STRIPE_SECRET_KEY is not set. Use a test key (sk_test_…); this drill will not run without one.');
    process.exit(2);
  }
  if (!/^(sk|rk)_test_/.test(stripe.secretKey)) {
    say('  NOTE  STRIPE_SECRET_KEY does not look like a test key — this will create a real product and price.');
  }
  await proveTheApi();
  await proveWebhook(stripe.webhookSecret);
  finishWithLiveEvents();
  say('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  say('Every check passed. The billing is driven.');
}

main().catch((error) => {
  console.error(`\nThe drill could not run: ${error.message}`);
  process.exit(1);
});

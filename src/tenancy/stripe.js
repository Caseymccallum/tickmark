/**
 * Stripe, over `fetch`, with no package.
 *
 * The rule this file exists to keep: **no `stripe` npm package.** Tickmark's whole pitch is that an
 * operator can read what they are running, and the official SDK is a dependency tree in a project
 * with none. The REST API is form-encoded requests and JSON responses; that is a few dozen lines,
 * and those lines are auditable in one sitting.
 *
 * ## What is here
 *
 * - `createCheckoutSession` — a Checkout Session for a recurring subscription, carrying the tenant
 *   id in metadata, which is the anchor the webhook reads back.
 * - `verifyWebhookSignature` — the real thing, not a sketch: HMAC-SHA256 over
 *   `timestamp + '.' + rawBody`, compared in constant time, with a staleness window. Implemented
 *   against Stripe's documented scheme (`Stripe-Signature: t=…,v1=…`), so a forged webhook cannot
 *   activate somebody's practice.
 * - `parseEvent` — the JSON body, after the signature has been checked.
 *
 * ## What is deliberately not here
 *
 * No retries, and no attempt to model Stripe's object graph. Each handler reads the three or four
 * fields it needs and ignores the rest, which is what keeps this file small enough to read in full.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { COMMERCIAL_PRICE } from './commercial-config.js';

export const STRIPE_API = 'https://api.stripe.com/v1';

/** Stripe's own tolerance: a signature older than this is treated as a replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeError extends Error {
  constructor(message, { status = null, type = null, raw = null } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.type = type;
    this.raw = raw;
  }
}

/** Configuration from the environment, or null when billing is not set up. */
export function stripeFromEnvironment(env = process.env) {
  const secretKey = env.STRIPE_SECRET_KEY ?? null;
  const priceId = env.STRIPE_PRICE_ID ?? null;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? null;
  if (!secretKey && !priceId && !webhookSecret) return null;
  const baseUrl = (env.TICKMARK_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  let parsedBase = null;
  try { parsedBase = new URL(baseUrl); } catch { /* invalid URLs fail closed */ }
  const local = parsedBase?.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedBase.hostname);
  const securePublicUrl = parsedBase?.protocol === 'https:' && Boolean(parsedBase.hostname);
  const valid = (!secretKey || /^(sk_test_|sk_live_)[A-Za-z0-9_]+$/.test(secretKey)) &&
    (!priceId || /^price_[A-Za-z0-9_]+$/.test(priceId)) &&
    (!webhookSecret || /^whsec_[A-Za-z0-9_]+$/.test(webhookSecret)) &&
    (local || securePublicUrl) && !parsedBase?.username && !parsedBase?.password && !parsedBase?.hash;
  return {
    secretKey,
    priceId,
    webhookSecret,
    // Where Stripe sends the browser back to. One base URL, so the return paths cannot drift.
    baseUrl,
    valid,
    billingReady: Boolean(valid && secretKey && priceId && webhookSecret),
  };
}

export function stripeBillingReady(stripe) {
  return Boolean(stripe?.billingReady ?? (stripe?.valid !== false && stripe?.secretKey && stripe?.priceId && stripe?.webhookSecret));
}

async function get(stripe, path, { signal } = {}) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    headers: { authorization: `Bearer ${stripe.secretKey}` },
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new StripeError(payload?.error?.message ?? `Stripe refused the request (${response.status})`, {
      status: response.status, type: payload?.error?.type ?? null, raw: payload,
    });
  }
  return payload;
}

/** Retrieve only the current subscription fields needed for an audited operator reconciliation. */
export async function retrieveSubscription(stripe, subscriptionId, { signal = AbortSignal.timeout(10_000) } = {}) {
  if (!stripe?.secretKey || stripe.valid === false || !/^(sk_test_|sk_live_)[A-Za-z0-9_]+$/.test(stripe.secretKey)) {
    throw new StripeError('Stripe API credentials are unavailable or invalid');
  }
  if (!/^sub_[A-Za-z0-9_]+$/.test(String(subscriptionId ?? ''))) {
    throw new StripeError('an explicit Stripe subscription id is required');
  }
  const value = await get(stripe, `/subscriptions/${encodeURIComponent(subscriptionId)}`, { signal });
  return {
    id: value.id,
    customer: typeof value.customer === 'string' ? value.customer : value.customer?.id ?? null,
    status: value.status,
  };
}

/** Check the configured Stripe price against the published commercial catalogue before checkout. */
export async function verifyConfiguredPrice(stripe) {
  if (!stripeBillingReady(stripe)) throw new StripeError('Stripe billing configuration is incomplete or invalid');
  const price = await get(stripe, `/prices/${encodeURIComponent(stripe.priceId)}`);
  const matches = price?.active === true && price?.currency === COMMERCIAL_PRICE.currency &&
    price?.unit_amount === COMMERCIAL_PRICE.unitAmount && price?.recurring?.interval === COMMERCIAL_PRICE.interval &&
    price?.recurring?.interval_count === 1;
  if (!matches) throw new StripeError('configured Stripe price does not match the published monthly GBP catalogue');
  return price;
}

/** POST a form to Stripe and hand back the JSON, or throw the relay's own words. */
async function post(stripe, path, form) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripe.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new StripeError(payload?.error?.message ?? `Stripe refused the request (${response.status})`, {
      status: response.status,
      type: payload?.error?.type ?? null,
      raw: payload,
    });
  }
  return payload;
}

/**
 * Create a Checkout Session for a subscription.
 *
 * `tenantId` travels in metadata — on the session *and* on the subscription it creates — because
 * metadata is the only thing that survives the round trip through Stripe's hosted page and comes
 * back un-forgeable inside a signed webhook. It is the join between a payment and a practice.
 */
export async function createCheckoutSession(stripe, { tenantId, tenantName, customerEmail, customerId = null, successPath, cancelPath }) {
  if (!stripeBillingReady(stripe)) throw new StripeError('Stripe billing configuration is incomplete or invalid');
  await verifyConfiguredPrice(stripe);

  const form = new URLSearchParams({
    mode: 'subscription',
    payment_method_collection: 'always',
    'line_items[0][price]': stripe.priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: tenantId,
    success_url: `${stripe.baseUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${stripe.baseUrl}${cancelPath}`,
    'metadata[tenant_id]': tenantId,
    'metadata[practice_name]': tenantName,
    // Copied onto the subscription, so `customer.subscription.*` events carry the tenant too —
    // those arrive with a subscription and no session, and without this the handler would have to
    // match the tenant by customer id alone.
    'subscription_data[metadata][tenant_id]': tenantId,
  });
  if (customerId) form.set('customer', customerId);
  else form.set('customer_email', customerEmail);

  const payload = await post(stripe, '/checkout/sessions', form);
  return { id: payload.id, url: payload.url };
}

/** The customer portal, so a practice can change its own card without emailing anybody. */
export function createBillingPortalSession(stripe, { customerId, returnPath }) {
  const form = new URLSearchParams({ customer: customerId, return_url: `${stripe.baseUrl}${returnPath}` });
  return post(stripe, '/billing_portal/sessions', form).then((payload) => ({ url: payload.url }));
}

/** One value out of `t=…,v1=…` — the header's shape, parsed once. */
export function parseSignatureHeader(header) {
  const parts = {};
  for (const piece of String(header ?? '').split(',')) {
    const at = piece.indexOf('=');
    if (at < 1) continue;
    const name = piece.slice(0, at).trim();
    const value = piece.slice(at + 1).trim();
    if (name === 'v1') (parts.v1 ??= []).push(value);
    else parts[name] = value;
  }
  return parts;
}

/**
 * Verify a webhook. Returns `{ ok: true }` or `{ ok: false, reason }` — never throws, because a
 * forged webhook is an ordinary event that deserves a 400, not a crash in the log.
 *
 * The scheme is Stripe's: `signed_payload = timestamp + '.' + raw_body`, HMAC-SHA256 with the
 * endpoint's signing secret, compared against each `v1` in the header. The raw bytes matter —
 * re-serialising the JSON changes them and breaks verification — which is why the endpoint reads
 * the body as a Buffer and hands it here untouched.
 */
export function verifyWebhookSignature({
  rawBody,
  header,
  secret,
  now = Date.now(),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
}) {
  if (!secret) return { ok: false, reason: 'the webhook secret is not configured' };
  const { t: timestamp, v1 } = parseSignatureHeader(header);
  if (!timestamp || !v1 || v1.length === 0) {
    return { ok: false, reason: 'the signature header is missing or malformed' };
  }

  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: 'the signature timestamp is not a number' };
  if (age > toleranceSeconds) return { ok: false, reason: 'the signature is older than the tolerance window' };

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)))
    .digest();

  for (const candidate of v1) {
    const given = Buffer.from(candidate, 'hex');
    // Lengths must match before `timingSafeEqual`, and a mismatched length is a failed check
    // rather than an exception — the same care `src/crypto.js` takes.
    if (given.length === expected.length && timingSafeEqual(expected, given)) return { ok: true };
  }
  return { ok: false, reason: 'the signature does not match' };
}

/** The event after its signature has been checked. Throws if the body is not an event. */
export function parseEvent(rawBody) {
  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    throw new StripeError('the webhook body is not JSON');
  }
  if (!event?.id || typeof event.id !== 'string' || !Number.isSafeInteger(event.created) ||
      !event?.type || !event?.data?.object) {
    throw new StripeError('the webhook body is not a complete Stripe event');
  }
  return event;
}

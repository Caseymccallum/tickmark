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
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return {
    secretKey,
    priceId: env.STRIPE_PRICE_ID ?? null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    // Where Stripe sends the browser back to. One base URL, so the return paths cannot drift.
    baseUrl: (env.TICKMARK_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  };
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
export function createCheckoutSession(stripe, { tenantId, tenantName, customerEmail, successPath, cancelPath }) {
  if (!stripe?.secretKey) throw new StripeError('Stripe is not configured: STRIPE_SECRET_KEY is missing');
  if (!stripe.priceId) throw new StripeError('Stripe is not configured: STRIPE_PRICE_ID is missing');

  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': stripe.priceId,
    'line_items[0][quantity]': '1',
    customer_email: customerEmail,
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

  return post(stripe, '/checkout/sessions', form).then((payload) => ({ id: payload.id, url: payload.url }));
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
  if (!event?.type || !event?.data?.object) throw new StripeError('the webhook body is not a Stripe event');
  return event;
}
/**
 * What Stripe's events mean for a practice.
 *
 * This file is a **pure translation layer**: an event goes in, a registry change comes out. It does
 * not talk to HTTP, does not read a tenant's database, and cannot be reached from a browser. That
 * separation is what makes the webhook endpoint testable without Stripe — the tests feed it
 * synthetic events and read the registry row.
 *
 * The three events the plan names, and one worth having:
 *
 * | Event | What it means | What changes |
 * | --- | --- | --- |
 * | `checkout.session.completed` | they paid | `pending_payment` → `active`, plan `standard`, ids recorded |
 * | `customer.subscription.updated` | they upgraded, downgraded, or their card failed | plan, and active/past_due |
 * | `customer.subscription.deleted` | the subscription is gone | `cancelled` |
 * | `invoice.payment_failed` | one payment did not go through | `past_due`, before Stripe gives up |
 *
 * Stripe's own subscription statuses are mapped rather than stored: `past_due` and `unpaid` both
 * mean "the money did not arrive", and a support person reading the registry should see one word
 * for that, not four.
 */
import { setTenantBilling, tenantForPractice } from './registry.js';

/** Stripe subscription status → the one word this installation uses. */
export const STATUS_FROM_STRIPE = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
  incomplete: 'pending_payment',
  incomplete_expired: 'cancelled',
  paused: 'past_due',
};

/** The tenant an event is about: metadata first, since it is what the checkout wrote. */
function tenantIdOf(object) {
  return object?.metadata?.tenant_id ?? object?.subscription_details?.metadata?.tenant_id ?? null;
}

/**
 * Apply one verified event to the registry.
 *
 * Returns `{ handled, tenantId, before, after }` — a plain description of what was done, which the
 * endpoint logs and the tests assert on. An event this installation does not act on is `handled:
 * false` rather than an error: Stripe sends many kinds, and refusing one it did not need is how a
 * webhook endpoint ends up with an alert nobody can clear.
 */
export function applyStripeEvent(registry, event) {
  const object = event?.data?.object ?? {};
  const tenantId = tenantIdOf(object);

  switch (event?.type) {
    case 'checkout.session.completed': {
      if (!tenantId) return { handled: false, reason: 'no tenant_id in the session metadata' };
      const before = setTenantBilling(registry, tenantId, {
        status: 'active',
        plan: 'standard',
        customerId: typeof object.customer === 'string' ? object.customer : null,
        subscriptionId: typeof object.subscription === 'string' ? object.subscription : null,
      });
      if (!before) return { handled: false, reason: `no tenant ${tenantId} in the registry` };
      return { handled: true, tenantId, event: event.type, before: before.status, after: 'active' };
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Deleted has no status worth reading — the subscription is over whatever the object says.
      const status =
        event.type === 'customer.subscription.deleted'
          ? 'cancelled'
          : (STATUS_FROM_STRIPE[object.status] ?? null);
      if (!status) return { handled: false, reason: `unrecognised subscription status ${object.status}` };
      if (!tenantId) return { handled: false, reason: 'no tenant_id in the subscription metadata' };

      const before = setTenantBilling(registry, tenantId, {
        status,
        customerId: typeof object.customer === 'string' ? object.customer : null,
        subscriptionId: typeof object.id === 'string' ? object.id : null,
        // A downgrade or an upgrade is a price change; the plan name is read from metadata, which
        // is where the checkout put it. Absent metadata leaves the plan as it was.
        plan: object.metadata?.plan ?? null,
      });
      if (!before) return { handled: false, reason: `no tenant ${tenantId} in the registry` };
      return { handled: true, tenantId, event: event.type, before: before.status, after: status };
    }

    case 'invoice.payment_failed': {
      if (!tenantId) return { handled: false, reason: 'no tenant_id in the invoice metadata' };
      const before = setTenantBilling(registry, tenantId, { status: 'past_due' });
      if (!before) return { handled: false, reason: `no tenant ${tenantId} in the registry` };
      return { handled: true, tenantId, event: event.type, before: before.status, after: 'past_due' };
    }

    case 'invoice.payment_succeeded': {
      // A recovered card should let them back in without waiting for the subscription event.
      if (!tenantId) return { handled: false, reason: 'no tenant_id in the invoice metadata' };
      const before = setTenantBilling(registry, tenantId, { status: 'active' });
      if (!before) return { handled: false, reason: `no tenant ${tenantId} in the registry` };
      return { handled: true, tenantId, event: event.type, before: before.status, after: 'active' };
    }

    default:
      return { handled: false, reason: `${event?.type} is not one this installation acts on` };
  }
}

/** The tenant a verified event names, for the log line, without changing anything. */
export const tenantForEvent = (registry, event) => {
  const tenantId = tenantIdOf(event?.data?.object ?? {});
  if (!tenantId) return null;
  return registry.prepare('SELECT id, slug, name, status FROM tenant WHERE id = ?').get(tenantId) ?? null;
};

export { tenantForPractice };
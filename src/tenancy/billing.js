/** Durable, ordered interpretation of the Stripe events that affect hosted access. */

import { newId } from '../db.js';

export const STATUS_FROM_STRIPE = {
  active: 'active',
  trialing: 'pending_payment',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
  incomplete: 'pending_payment',
  incomplete_expired: 'cancelled',
  paused: 'past_due',
};

function textId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveTenant(registry, event) {
  const object = event.data.object;
  const explicit = object?.metadata?.tenant_id ?? object?.subscription_details?.metadata?.tenant_id ?? null;
  const subscriptionId = event.type.startsWith('customer.subscription.')
    ? textId(object?.id)
    : textId(object?.subscription);
  const customerId = textId(object?.customer);
  const mapped = subscriptionId
    ? registry.prepare('SELECT id FROM tenant WHERE stripe_subscription_id = ?').get(subscriptionId)
    : null;
  const tenantId = explicit ?? mapped?.id ?? null;
  if (!tenantId) return { tenant: null, reason: 'no tenant or known subscription association' };
  const tenant = registry.prepare('SELECT * FROM tenant WHERE id = ?').get(tenantId);
  if (!tenant) return { tenant: null, reason: 'unknown tenant' };
  if (mapped && mapped.id !== tenant.id) return { tenant: null, reason: 'subscription maps to another tenant' };
  if (tenant.stripe_customer_id && customerId && tenant.stripe_customer_id !== customerId) {
    return { tenant: null, reason: 'customer does not match tenant association' };
  }
  const newSubscription = (event.type === 'customer.subscription.created' || event.type === 'checkout.session.completed') &&
    tenant.status === 'cancelled' && tenant.stripe_customer_id === customerId &&
    event.created >= tenant.stripe_event_created;
  if (tenant.stripe_subscription_id && subscriptionId && tenant.stripe_subscription_id !== subscriptionId && !newSubscription) {
    return { tenant: null, reason: 'subscription does not match tenant association' };
  }
  for (const [column, id] of [['stripe_customer_id', customerId], ['stripe_subscription_id', subscriptionId]]) {
    if (id && registry.prepare(`SELECT id FROM tenant WHERE ${column} = ? AND id != ?`).get(id, tenantId)) {
      return { tenant: null, reason: `${column === 'stripe_customer_id' ? 'customer' : 'subscription'} is already associated with another tenant` };
    }
  }
  return { tenant, customerId, subscriptionId, replaceSubscription: newSubscription };
}

/**
 * Record one verified event and apply its state transition atomically. Stripe's subscription object
 * is the authority for open/closed state. Invoice events are recorded as diagnostic hints, but a
 * successful invoice never reopens a cancelled subscription by itself.
 */
export function applyStripeEvent(registry, event, { at = new Date() } = {}) {
  if (!event?.id || !Number.isSafeInteger(event.created) || !event?.type || !event?.data?.object) {
    return { handled: false, retry: false, reason: 'event is missing required Stripe fields' };
  }
  const eventTime = at instanceof Date ? at.toISOString() : String(at);

  registry.exec('BEGIN IMMEDIATE');
  try {
    const prior = registry.prepare('SELECT outcome, tenant_id FROM stripe_event WHERE event_id = ?').get(event.id);
    if (prior) {
      registry.exec('COMMIT');
      return { handled: false, duplicate: true, tenantId: prior.tenant_id, reason: 'event already recorded' };
    }

    const object = event.data.object;
    const association = resolveTenant(registry, event);
    const tenant = association.tenant;
    let outcome = 'ignored';
    let reason = association.reason ?? `${event.type} is not an access-state event`;
    let before = null;
    let after = null;

    if (tenant && event.created < tenant.stripe_event_created) {
      outcome = 'stale';
      reason = 'older than the latest applied billing event';
    } else if (tenant && event.created === tenant.stripe_event_created &&
      tenant.status === 'cancelled' && event.type !== 'customer.subscription.deleted') {
      outcome = 'stale';
      reason = 'same-second event cannot reopen a cancelled subscription';
    } else if (tenant) {
      const status = event.type === 'customer.subscription.deleted'
        ? 'cancelled'
        : (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated')
          ? STATUS_FROM_STRIPE[object.status] ?? null
          : null;

      if (status) {
        before = tenant.status;
        after = status;
        // Checkout completion only binds identifiers. A browser return or completed checkout
        // session cannot grant access; only the signed subscription snapshot can do that.
        if (event.type === 'checkout.session.completed') {
          after = before;
        }
        const pastDueSince = after === 'past_due'
          ? (before === 'past_due' ? tenant.past_due_since : eventTime)
          : null;
        registry.prepare(
          `UPDATE tenant SET status = ?, past_due_since = ?,
             stripe_customer_id = COALESCE(stripe_customer_id, ?),
             stripe_subscription_id = CASE WHEN ? THEN ? ELSE COALESCE(stripe_subscription_id, ?) END,
             stripe_event_created = ? WHERE id = ?`,
        ).run(after, pastDueSince, association.customerId, association.replaceSubscription ? 1 : 0,
          association.subscriptionId, association.subscriptionId, event.created, tenant.id);
        outcome = 'applied';
        reason = null;
      } else if (event.type === 'checkout.session.completed') {
        // Keep the practice pending until a subscription lifecycle event confirms its state.
        registry.prepare(
          `UPDATE tenant SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
             stripe_subscription_id = CASE WHEN ? THEN ? ELSE COALESCE(stripe_subscription_id, ?) END
             WHERE id = ?`,
        ).run(association.customerId, association.replaceSubscription ? 1 : 0, association.subscriptionId,
          association.subscriptionId, tenant.id);
        before = after = tenant.status;
        outcome = 'applied';
        reason = null;
      } else if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
        // Stripe follows recovery with a subscription.updated snapshot. Waiting for that snapshot
        // prevents an old successful invoice from undoing a later cancellation.
        before = after = tenant.status;
        outcome = 'observed';
        reason = 'awaiting authoritative subscription state';
      } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
        outcome = 'ignored';
        reason = `unrecognised subscription status ${object.status}`;
      }
    }

    registry.prepare(
      `INSERT INTO stripe_event (event_id, event_type, event_created, outcome, tenant_id, received_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(event.id, event.type, event.created, outcome, tenant?.id ?? null, eventTime, outcome === 'applied' || outcome === 'observed' ? eventTime : null);

    const result = {
      handled: outcome === 'applied' || outcome === 'observed',
      outcome,
      tenantId: tenant?.id ?? null,
      event: event.type,
      before,
      after,
      ...(reason ? { reason } : {}),
    };
    registry.exec('COMMIT');
    return result;
  } catch (error) {
    try { registry.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

/**
 * Retrieve Stripe's current subscription while holding the registry write lock, then reconcile
 * local access from that verified snapshot. The caller supplies a fetch function, never a status;
 * API or association failures roll back without changing tenant state. Each result is auditable and
 * contains identifiers/status only, not the API response or credentials.
 */
export async function reconcileStripeSubscription(registry, {
  tenantId, customerId, subscriptionId, operator, retrieve, at = () => new Date(),
} = {}) {
  if (!tenantId || !customerId || !subscriptionId || !String(operator ?? '').trim() || typeof retrieve !== 'function') {
    throw new TypeError('tenant, customer, subscription, operator and Stripe retrieval are required');
  }

  registry.exec('BEGIN IMMEDIATE');
  try {
    const tenant = registry.prepare('SELECT * FROM tenant WHERE id = ?').get(tenantId);
    if (!tenant) throw new Error('the explicitly named tenant does not exist');
    if (tenant.lifecycle_state !== 'active') throw new Error('a tenant in deletion lifecycle cannot be reconciled');
    if (tenant.stripe_customer_id !== customerId) throw new Error('the Stripe customer id does not match the tenant association');
    const knownSubscription = tenant.stripe_subscription_id === subscriptionId;
    const newSubscription = tenant.status === 'cancelled' && !knownSubscription;
    if (!knownSubscription && !newSubscription) throw new Error('the Stripe subscription id does not match the tenant association');
    for (const [column, id] of [['stripe_customer_id', customerId], ['stripe_subscription_id', subscriptionId]]) {
      const conflict = registry.prepare(`SELECT id FROM tenant WHERE ${column} = ? AND id != ?`).get(id, tenantId);
      if (conflict) throw new Error(`the Stripe ${column === 'stripe_customer_id' ? 'customer' : 'subscription'} is associated with another tenant`);
    }

    const current = await retrieve();
    if (current?.id !== subscriptionId || current?.customer !== customerId) {
      throw new Error('Stripe returned a different customer or subscription than the explicit association');
    }
    const status = STATUS_FROM_STRIPE[current.status];
    if (!status) throw new Error(`Stripe returned an unsupported subscription status: ${String(current.status)}`);
    const reconciledAt = at();
    const timestamp = reconciledAt instanceof Date ? reconciledAt : new Date(reconciledAt);
    if (!Number.isFinite(timestamp.getTime())) throw new Error('reconciliation time is invalid');
    const eventCreated = Math.floor(timestamp.getTime() / 1000);
    if (eventCreated < tenant.stripe_event_created) throw new Error('a later billing event is already recorded; retrieve Stripe again before reconciling');

    const before = tenant.status;
    const pastDueSince = status === 'past_due'
      ? (before === 'past_due' ? tenant.past_due_since : timestamp.toISOString())
      : null;
    const outcome = before === status && knownSubscription ? 'confirmed' : 'corrected';
    registry.prepare(
      `UPDATE tenant SET status = ?, past_due_since = ?, stripe_subscription_id = ?,
         stripe_event_created = ? WHERE id = ?`,
    ).run(status, pastDueSince, subscriptionId, eventCreated, tenantId);
    registry.prepare(
      `INSERT INTO stripe_reconciliation
        (id, tenant_id, customer_id, subscription_id, stripe_status, previous_status,
         resulting_status, outcome, operator, reconciled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), tenantId, customerId, subscriptionId, current.status, before, status,
      outcome, String(operator).trim().slice(0, 120), timestamp.toISOString());
    registry.exec('COMMIT');
    return { outcome, before, after: status, tenantId, customerId, subscriptionId, at: timestamp.toISOString() };
  } catch (error) {
    try { registry.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export const tenantForPractice = (registry, practiceId) =>
  registry.prepare('SELECT id, slug, name, status FROM tenant WHERE practice_id = ?').get(practiceId) ?? null;

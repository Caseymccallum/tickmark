/**
 * Request → tenant.
 *
 * This is the whole of "route hijacking" (docs/saas.md §2.4): one function handed to `createApp`,
 * called before any routing, that answers the only new question the multi-tenant server has —
 * *whose practice is this request for?* — and returns the pieces the single-tenant server used to
 * hardcode. The route table, the handlers, and every store query are unchanged; what changes is
 * which database the context carries.
 *
 * The order of the checks is the order of the product's surfaces:
 *
 * 1. a client's link (`/r/<token>`) or a member invitation (`/invite/<token>`) — resolved through
 *    the registry's prefix index, because the holder of a link has no host, no account and no
 *    session, and must never need one;
 * 2. the Host header — the subdomain *is* the tenant for every signed-in page;
 * 3. nothing — null, which the app answers with a 404 before any tenant file is opened.
 *
 * ## The billing wall, and where it stands
 *
 * A practice whose subscription is not active is answered **here** — before `pool.get`, so the
 * tenant's database is never opened for a request that cannot be served — with the page that says
 * what is wrong and offers the one button that fixes it. This is the only place the check can live
 * without being repeated in every route, and the only place it can live without a locked-out
 * practice's pages half-working.
 *
 * Client links are deliberately **not** blocked. A client mid-collection must not be stranded by
 * the practice's billing, and the practice cannot read what arrives until they pay either way.
 */
import { join } from 'node:path';

import { PLANS, TENANT_STATUS, tenantForHost, tenantForLink, tenantForSlug, tenantAllowsAccess } from './registry.js';

/** The paths that name a tenant by token rather than by host. The pattern is the core's own. */
const LINK_PATH = /^\/r\/([A-Za-z0-9_-]+)/;
const INVITE_PATH = /^\/invite\/([A-Za-z0-9_-]+)/;

export function createResolver({ registry, pool, defaults = {}, onBlocked = null }) {
  if (!registry || !pool) throw new TypeError('a registry and a pool are required');

  /**
   * @returns {{ practiceId: string, db: object, blobDir: string, slug: string } | { handled: true } | null}
   *   null when no tenant can be named — the app answers that with a 404. `{ handled: true }` means
   *   the response has already been written (the billing wall) and the app should stop.
   */
  return function resolveTenant(request, url, response) {
    // 1. Client links and invitations: the token knows where it lives. Nothing else on the
    //    request is trusted, because a client has nothing else to offer.
    const link = LINK_PATH.exec(url.pathname) ?? INVITE_PATH.exec(url.pathname);
    if (link) {
      const tenant = tenantForLink(registry, link[1]);
      if (tenant) return open(tenant);
      // A link the index does not know falls through to the host check, then to null: the same
      // 404 an unknown host gets, without revealing which of the two failed.
    }

    // 2. The host header, which is how a signed-in practice reaches itself.
    const byHost = tenantForHost(registry, request.headers.host);
    if (byHost) return guard(byHost, response);

    // 2b. A slug in the path — the development and preview surface (`/t/acme/requests`), where
    //     wildcards like *.localhost do not resolve. Stripped before routing, so the route table
    //     below never sees the prefix.
    const slugMatch = /^\/t\/([a-z0-9-]+)(\/|$)/i.exec(url.pathname);
    if (slugMatch) {
      const bySlug = tenantForSlug(registry, slugMatch[1]);
      if (bySlug) {
        const decision = guard(bySlug, response);
        if (decision?.handled) return decision;
        url.pathname = url.pathname.slice(slugMatch[1].length + 3);
        return decision;
      }
    }

    return null;
  };

  /**
   * The subscription check. `active` continues; anything else is answered with the wall, if the
   * caller gave us one to draw. Without a renderer the request is refused the same way an unknown
   * host is — never silently allowed through, which is the failure that would matter.
   */
  function guard(tenant, response) {
    if (tenantAllowsAccess(tenant)) return open(tenant);
    if (onBlocked && response) {
      onBlocked(response, tenant, TENANT_STATUS[tenant.status] ?? TENANT_STATUS.cancelled);
      return { handled: true };
    }
    return null;
  }

  /** The tenant's injected dependencies. The only place a tenant file is opened from a request. */
  function open(tenant) {
    // The plan is the tenant's own; its limits are injected exactly where the single-tenant
    // server used to hardcode its own. An unknown plan reads as the default, never as unlimited.
    const plan = PLANS[tenant.plan] ?? PLANS.standard;
    return {
      practiceId: tenant.id,
      slug: tenant.slug,
      db: pool.get(tenant.id),
      blobDir: join(pool.root, tenant.id, 'blobs'),
      chaseBudgetMs: plan.chaseBudgetMs,
      maxUploadBytes: plan.maxUploadBytes,
      maxRequestBytes: plan.maxRequestBytes,
      maxRequestFiles: plan.maxRequestFiles,
      ...defaults,
    };
  }
}

/**
 * The MULTI_TENANT entry point.
 *
 * `node src/server.js` stays the self-hosted server, byte for byte. This is what `MULTI_TENANT=1`
 * runs instead: it opens the registry, builds the pool, and hands `createApp` the two injected
 * dependencies that turn it into a multi-tenant server — a `resolveTenant` and a link recorder.
 * (docs/saas.md §2.3, §2.4.)
 *
 * Nothing here touches the core's query text, crypto, or envelope format. The registry learns
 * about a link only through the injected `onLinkIssued` the core already calls; the core route
 * that issues links does not know a registry exists.
 */
import { join } from 'node:path';

import { createApp } from '../app.js';
import { mailerFromEnvironment } from '../mailer.js';
import { sendPage } from '../views.js';

import { createGateway } from './gateway.js';
import { createPool } from './pool.js';
import { accountForRequest, countTenants, openRegistry, recordLink, tenantForPractice, updateAccountEmail, updateAccountPassword } from './registry.js';
import { createResolver } from './resolve.js';
import { stripeFromEnvironment } from './stripe.js';
import { billingWallPage } from './views.js';

export function createSaasServer({
  dataDir = process.env.TICKMARK_DATA ?? 'data',
  registryFile = process.env.TICKMARK_REGISTRY ?? join(dataDir, 'saas.db'),
  tenantsRoot = process.env.TICKMARK_TENANTS ?? join(dataDir, 'tenants'),
  maxUploadBytes = Number(process.env.TICKMARK_MAX_UPLOAD ?? 25 * 1024 * 1024),
  env = process.env,
} = {}) {
  const registry = openRegistry(registryFile);
  const pool = createPool({ root: tenantsRoot });
  const stripe = stripeFromEnvironment(env);
  const gateway = createGateway({ registry, pool, stripe });

  // A practice with a closed subscription gets the billing wall from the resolver, before its own
  // database is opened — and the wall offers the gateway's own buttons, which is why it is drawn
  // by the gateway's page rather than by the core's.
  const resolveTenant = createResolver({
    registry,
    pool,
    onBlocked: (response, tenant, status) => {
      // The resolver hands this callback the *response* rather than the request, so the signed-in account is read
      // from `response.req` — which Node sets on every `ServerResponse`, and which is the same request object the
      // handler would have been given. Without it the wall's header offered "Sign in" to somebody who was already
      // signed in, and the page had no way out except the Back button.
      const account = response.req ? accountForRequest(registry, response.req) : null;
      // Through `sendPage` rather than a hand-rolled `writeHead`: the wall is a page like any other,
      // and `sendPage` is where the security headers and the per-response nonce are stamped. A wall
      // written by hand would ship with neither — and with a raw nonce placeholder in its markup.
      sendPage(response, 402, billingWallPage({ tenant, status, account }));
    },
  });

  let mailer = null;
  try {
    mailer = mailerFromEnvironment(env);
  } catch (error) {
    console.error(`tickmark: mail is misconfigured — ${error.message}`);
  }

  const server = createApp(registry, {
    maxUploadBytes,
    resolveTenant,
    preHandle: gateway.handle,
    healthCheck: () => countTenants(registry),
    onLinkIssued: ({ practiceId, token }) => {
      // The core hands back the practice id; the registry indexes by tenant id. One lookup joins
      // the two, and a link issued by a file the registry does not know is simply not indexed.
      const tenant = tenantForPractice(registry, practiceId);
      if (tenant) recordLink(registry, { tenantId: tenant.id, token });
    },
    onCredentialChanged: (change) => {
      // One password works at both doors by design (see `createTenant` in registry.js), so a change
      // behind either door updates both — otherwise the platform account would keep answering with
      // the old password after a member changed it because they thought it was compromised. An
      // invited member with no platform account updates nothing here, which is correct: there is
      // nothing to keep in step.
      if (change.passwordHash) updateAccountPassword(registry, change.email, change.passwordHash);
      if (change.newEmail && !updateAccountEmail(registry, change.oldEmail, change.newEmail)) {
        console.error(
          `tickmark: the workspace address changed to ${change.newEmail} but the platform account could not follow (that address is taken there)`,
        );
      }
    },
    mailer,
  });

  return { server, registry, pool, gateway, stripe };
}

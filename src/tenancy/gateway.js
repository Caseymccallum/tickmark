/**
 * The public gateway: sign up, sign in, dashboard, billing, and Stripe's webhook.
 *
 * This module is the *only* thing that knows the platform has accounts separate from practices. It
 * sits in front of the core app and answers a handful of paths; everything else — every page inside
 * a practice, every client's link — falls through to `src/app.js` untouched. (docs/saas.md §2.4.)
 *
 * ## The two rules it keeps
 *
 * 1. **A registry sign-in ends in a tenant-side session.** The core's pages ask the core's own
 *    question (`practitionerFor`), so a gateway login mints a session *inside the tenant's file*,
 *    using the core's own `createSession`, and hands the browser the core's own cookie. Nothing in
 *    `src/app.js` learns that a registry exists.
 * 2. **Exactly one practice per tenant.** `/signup` on a practice's own address does not create a
 *    second practice in its database — it sends the visitor to sign in, because the way into an
 *    existing firm is an invitation. Account creation is a platform act, at the platform's address.
 */
import { clearSessionCookie, createSession, secureCookies, sessionCookie, twoFactorState } from '../auth.js';
import { verifyPassword } from '../crypto.js';
import { field, formFields, readBody } from '../http.js';
import { createAttemptLimiter } from '../ratelimit.js';
import { redirect, sendPage } from '../views.js';

import { applyStripeEvent } from './billing.js';
import {
  TENANT_STATUS,
  accountByEmail,
  clearSaasSessionCookie,
  createAccount,
  createSaasSession,
  createTenant,
  endSaasSession,
  mapHost,
  practitionerForAccount,
  saasSessionCookie,
  sessionTokenFrom,
  slugify,
  tenantForHost,
  tenantForSlug,
  tenantForToken,
} from './registry.js';
import {
  createBillingPortalSession,
  createCheckoutSession,
  parseEvent,
  verifyWebhookSignature,
} from './stripe.js';
import { dashboardPage, loginPage, signupPage, simplePage } from './views.js';

/** The minimum password, the same number the core's own signup uses. */
export const MIN_PASSWORD = 12;

/** The paths this gateway owns. Everything else belongs to the core app. */
export const GATEWAY_PATHS = new Set([
  '/',
  '/signup',
  '/login',
  // The core's own sign-in page lives at `/signin`, and it is what the header links to and what
  // every core redirect lands on. In SaaS mode there is one way in — the gateway's — so this is an
  // alias for it rather than a second, parallel sign-in that writes a different kind of session.
  '/signin',
  '/logout',
  '/dashboard',
  '/billing/checkout',
  '/billing/checkout/success',
  '/billing/portal',
  '/webhooks/stripe',
]);

export function createGateway({ registry, pool, stripe = null, secure = secureCookies(), signUpLimiter = createAttemptLimiter() }) {
  /** The address a practice's workspace answers at: its host, or its slug path. */
  function tenantUrlFor(tenant) {
    const mapped = registry
      .prepare('SELECT host FROM tenant_host WHERE tenant_id = ? ORDER BY host LIMIT 1')
      .get(tenant.id);
    if (mapped) return `${stripe?.baseUrl?.startsWith('http://') ? 'http' : 'https'}://${mapped.host}`;
    return `/t/${tenant.slug}/`;
  }

  /** The tenant the request's host names, if any — the same rule `resolve.js` uses. */
  function tenantOfHost(url, request) {
    const byHost = tenantForHost(registry, request.headers.host);
    if (byHost) return byHost;
    const match = /^\/t\/([a-z0-9-]+)(\/|$)/i.exec(url.pathname);
    return match ? tenantForSlug(registry, match[1]) : null;
  }

  /**
   * What the dashboard says after a redirect that had something to explain.
   *
   * `second-factor` is the one that matters: the person's password was right, no workspace session was minted because
   * their practice asks for a code, and the next step is *theirs* rather than the software's. Saying so is the
   * difference between "the product is broken" and "there is one more step, and here it is".
   */
  function dashboardNotice(params) {
    if (params.get('second-factor') === '1') {
      return 'You are signed in here. Your practice asks for a code from your authenticator, so open your workspace and sign in there to enter it.';
    }
    if (params.get('paid') === '1') return 'Thank you — your workspace is open.';
    return null;
  }

  /**
   * Mint a core session inside the tenant's file and hand back the cookie to set.
   *
   * **`secondFactor` is the important return value, and its absence was a way around two-factor.** This used to mint a
   * session for whoever held the account's password, full stop — so a practice that had armed TOTP could be entered
   * without a code by signing in at the *platform* instead of at the practice's own sign-in page. Two-factor exists to
   * stop somebody who knows the password, and offering a second door that does not ask defeats it entirely: the
   * attacker simply uses the front door.
   *
   * So when the practice's member has a second factor armed, **no session is minted here**. The platform session
   * still exists — it is what the dashboard and the billing pages need — and the person is told to open their
   * workspace and sign in there, where the core asks for the code as it always has.
   *
   * The alternative was to teach the gateway the core's challenge flow, which means a second implementation of the
   * one thing in this product that must not be got wrong. Not asking is smaller and cannot be wrong.
   */
  function bridgeIntoTenant(tenant, email) {
    const found = practitionerForAccount(pool, tenant, email);
    if (!found) return null;
    if (twoFactorState(found.db, found.practitioner.id).state === 'on') {
      return { secondFactor: true, cookie: null };
    }
    const session = createSession(found.db, found.practitioner.id);
    return { cookie: sessionCookie(session.token, secure), secondFactor: false };
  }

  /** The Stripe customer for a tenant, or null — the dashboard and the portal both ask. */
  function customerIdOf(tenant) {
    if (!tenant) return null;
    return (
      registry.prepare('SELECT stripe_customer_id FROM tenant WHERE id = ?').get(tenant.id)
        ?.stripe_customer_id ?? null
    );
  }

  /** What a status means for access, from the one table that says so. */
  const statusFor = (tenant) => TENANT_STATUS[tenant?.status] ?? TENANT_STATUS.cancelled;

  return { handle, tenantUrlFor, tenantOfHost, customerIdOf, statusFor };


  // --- the dispatcher --------------------------------------------------------------------------

  function handle(request, response, url) {
    if (!GATEWAY_PATHS.has(url.pathname)) return false;

    // Stripe has no cookie and no host of ours; its signature is the credential.
    if (url.pathname === '/webhooks/stripe') {
      handleWebhook(request, response);
      return true;
    }

    const tenant = tenantOfHost(url, request);
    const token = sessionTokenFrom(request);
    const session = token ? tenantForToken(registry, token) : null;
    const method = request.method;

    // The platform's own front door. A practice's host falls through to the core, which has a home
    // page of its own; the bare platform has none, so it sends you where you were going anyway.
    if (url.pathname === '/') {
      if (tenant) return false;
      redirect(response, session ? '/dashboard' : '/signup');
      return true;
    }

    if (url.pathname === '/signup') {
      // A practice's own address does not create a second practice; the way in is an invitation.
      if (tenant) {
        redirect(response, '/login');
        return true;
      }
      if (method === 'GET') {
        sendPage(response, 200, signupPage({ billingReady: Boolean(stripe?.priceId) }));
        return true;
      }
      handleSignup(request, response);
      return true;
    }

    if (url.pathname === '/login' || url.pathname === '/signin') {
      if (method === 'GET') {
        // The core's page is not shown in SaaS mode: one sign-in, one session, one answer to
        // "which practice am I in?".
        if (url.pathname === '/signin') {
          redirect(response, '/login');
          return true;
        }
        sendPage(response, 200, loginPage({}));
        return true;
      }
      handleLogin(request, response, tenant);
      return true;
    }

    // Everything below needs a signed-in account.
    if (!session) {
      redirect(response, '/login');
      return true;
    }

    if (url.pathname === '/logout') {
      endSaasSession(registry, token);
      redirect(response, '/login', [clearSaasSessionCookie(secure), clearSessionCookie(secure)]);
      return true;
    }

    if (url.pathname === '/dashboard' && method === 'GET') {
      sendPage(
        response,
        200,
        dashboardPage({
          account: session.account,
          tenant: session.tenant,
          tenantUrl: session.tenant ? tenantUrlFor(session.tenant) : '/signup',
          customerConfigured: Boolean(customerIdOf(session.tenant)),
          notice: dashboardNotice(url.searchParams),
          noticeTone: url.searchParams.get('second-factor') === '1' ? 'warning' : 'success',
        }),
      );
      return true;
    }

    if (url.pathname === '/billing/checkout/success' && method === 'GET') {
      // Stripe sends the browser here after paying. The *webhook* is what opens the workspace;
      // this page only has to say something true while it waits.
      redirect(response, '/dashboard?paid=1');
      return true;
    }

    if (url.pathname === '/billing/checkout' && method === 'POST') {
      handleCheckout(response, session);
      return true;
    }

    if (url.pathname === '/billing/portal' && method === 'POST') {
      handlePortal(response, session);
      return true;
    }

    return false;
  }


  // --- signing up ------------------------------------------------------------------------------

  async function handleSignup(request, response) {
    const fields = formFields(await readBody(request));
    const practiceName = field(fields, 'practice_name');
    const email = field(fields, 'email')?.toLowerCase() ?? null;
    const password = typeof fields.password === 'string' ? fields.password : '';
    const values = { practice_name: practiceName ?? '', email: email ?? '' };
    const billingReady = Boolean(stripe?.priceId);

    // The same cost the core's sign-up has — a scrypt hash and rows made for whoever asks — and the same
    // two buckets as `signUp` in src/app.js: the address, and where the request came from. The platform's
    // front door is the most exposed surface this installation has, and an unpriced scrypt call is the
    // cheapest way to spend its CPU. Every attempt counts, successful ones included.
    const buckets = [`signup:${email ?? ''}`, `signup-ip:${request.socket?.remoteAddress ?? ''}`];
    const blockedFor = Math.max(0, ...buckets.map((key) => signUpLimiter?.blockedFor(key) ?? 0));
    if (blockedFor > 0) {
      const minutes = Math.ceil(blockedFor / 60000);
      sendPage(response, 429, signupPage({
        values,
        billingReady,
        problem: `Too many sign-up attempts from here. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      }));
      return;
    }
    for (const key of buckets) signUpLimiter?.failed(key);

    const problem = !practiceName
      ? 'A practice name is required.'
      : !email || !/^[^@\s]+@[^@\s]+$/.test(email)
        ? 'That does not look like an email address.'
        : password.length < MIN_PASSWORD
          ? `Use at least ${MIN_PASSWORD} characters for the password.`
          : accountByEmail(registry, email)
            ? 'There is already an account with that email. Sign in instead.'
            : null;
    if (problem) {
      sendPage(response, 400, signupPage({ values, problem, billingReady }));
      return;
    }

    // The slug comes from the practice's name and is made unique: two "Acme Accounting"s must be
    // two addresses, and the second is told which address it got rather than silently sharing one.
    const slug = uniqueSlug(practiceName);
    const accountId = await createAccount(registry, { email, password });

    // A practice that has not paid is a real tenant with a real file. Its passphrase and key setup
    // wait until they are through checkout, and nothing is lost either way.
    const tenant = createTenant(registry, pool, {
      ownerAccountId: accountId,
      name: practiceName,
      slug,
      email,
      status: 'pending_payment',
    });
    const host = hostForSlug(slug);
    if (host) mapHost(registry, { tenantId: tenant.id, host });

    const session = createSaasSession(registry, accountId);
    const cookies = [saasSessionCookie(session.token, secure)];

    // Straight to Stripe. With billing unconfigured they land on the dashboard and are told why.
    if (billingReady) {
      try {
        const checkout = await createCheckoutSession(stripe, {
          tenantId: tenant.id,
          tenantName: practiceName,
          customerEmail: email,
          successPath: '/billing/checkout/success',
          cancelPath: '/dashboard',
        });
        redirect(response, checkout.url, cookies);
        return;
      } catch (error) {
        // The account and the tenant both exist, so this is recoverable: send them somewhere with
        // a button to try again rather than into a dead end.
        console.error(`tickmark: Stripe checkout could not be created — ${error.message}`);
      }
    }
    redirect(response, '/dashboard', cookies);
  }


  // --- signing in ------------------------------------------------------------------------------

  async function handleLogin(request, response, onTenantHost) {
    const fields = formFields(await readBody(request));
    const email = field(fields, 'email')?.toLowerCase() ?? null;
    const password = typeof fields.password === 'string' ? fields.password : '';

    const account = email ? accountByEmail(registry, email) : null;
    // One sentence for both kinds of failure: "no such account" tells a stranger which addresses
    // exist, and the core's own sign-in page takes the same line about the same question.
    if (!account || !(await verifyPassword(password, account.password_hash))) {
      sendPage(
        response,
        401,
        loginPage({
          values: { email: email ?? '' },
          problem: 'That email and password do not match an account.',
        }),
      );
      return;
    }

    const session = createSaasSession(registry, account.id);
    const cookies = [saasSessionCookie(session.token, secure)];

    const tenant = registry
      .prepare(
        `SELECT t.id, t.slug, t.name, t.plan, t.status
           FROM tenant_member m JOIN tenant t ON t.id = m.tenant_id
          WHERE m.account_id = ?
          ORDER BY t.created_at LIMIT 1`,
      )
      .get(account.id);

    if (!tenant) {
      redirect(response, '/dashboard', cookies);
      return;
    }

    // The bridge: a session inside the practice's file, in the core's own cookie, so every page the
    // core serves finds the person it expects to find.
    //
    // A member with a second factor gets no session here — see `bridgeIntoTenant`. They are sent to the dashboard with
    // a sentence explaining why, because "signed in but the workspace does not know you" is exactly the failure this
    // bridge exists to prevent, and leaving them to discover it by opening their workspace would be worse.
    const bridged = bridgeIntoTenant(tenant, account.email);
    if (bridged?.cookie) cookies.push(bridged.cookie);
    if (bridged?.secondFactor) {
      redirect(response, '/dashboard?second-factor=1', cookies);
      return;
    }

    // On a practice's own address a signed-in person goes straight into their workspace — unless
    // the subscription is closed, in which case the dashboard is where the billing button is.
    //
    // On the platform's own address there is no workspace to enter: one account can be a member of
    // a practice whose address this is not, so the dashboard — which names that address and links
    // to it — is the only honest destination. This is also why `/signin` needs no special case: it
    // arrives with the same `onTenantHost` as `/login`.
    const intoWorkspace = Boolean(onTenantHost) && statusFor(tenant).allowed;
    redirect(response, intoWorkspace ? '/requests' : '/dashboard', cookies);
  }


  // --- billing ---------------------------------------------------------------------------------

  async function handleCheckout(response, session) {
    if (!stripe?.priceId) {
      sendPage(
        response,
        503,
        simplePage(
          'Billing',
          'Billing is not set up',
          'This installation has no payment provider configured. Its operator can fix that.',
        ),
      );
      return;
    }
    if (!session.tenant) {
      redirect(response, '/dashboard');
      return;
    }
    try {
      const checkout = await createCheckoutSession(stripe, {
        tenantId: session.tenant.id,
        tenantName: session.tenant.name,
        customerEmail: session.account.email,
        successPath: '/billing/checkout/success',
        cancelPath: '/dashboard',
      });
      redirect(response, checkout.url);
    } catch (error) {
      console.error(`tickmark: Stripe checkout could not be created — ${error.message}`);
      sendPage(response, 502, simplePage('Billing', 'Stripe refused that', error.message));
    }
  }

  async function handlePortal(response, session) {
    const customer = customerIdOf(session.tenant);
    if (!stripe?.secretKey || !customer) {
      // Nothing to manage yet: send them back to the page with the button that can help.
      redirect(response, '/dashboard');
      return;
    }
    try {
      const portal = await createBillingPortalSession(stripe, { customerId: customer, returnPath: '/dashboard' });
      redirect(response, portal.url);
    } catch (error) {
      console.error(`tickmark: Stripe portal could not be created — ${error.message}`);
      sendPage(response, 502, simplePage('Billing', 'Stripe refused that', error.message));
    }
  }

  /**
   * Stripe's webhook. The raw bytes are the other half of the credential, so the body is read once,
   * as a Buffer, and verified before anything is parsed or trusted.
   */
  async function handleWebhook(request, response) {
    let rawBody;
    try {
      rawBody = await readBody(request, 1024 * 1024);
    } catch {
      response.writeHead(413, { 'content-type': 'text/plain' });
      response.end('too large');
      return;
    }

    const verified = verifyWebhookSignature({
      rawBody,
      header: request.headers['stripe-signature'],
      secret: stripe?.webhookSecret,
    });
    if (!verified.ok) {
      // Logged, because a forged webhook is an incident; answered with 400, because that is what
      // it is. The reason stays out of the body — the sender already knows whether it was them.
      console.error(`tickmark: a Stripe webhook was refused — ${verified.reason}`);
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('signature refused');
      return;
    }

    let event;
    try {
      event = parseEvent(rawBody);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end(error.message);
      return;
    }

    const result = applyStripeEvent(registry, event);
    console.log(
      result.handled
        ? `tickmark: stripe ${event.type} — tenant ${result.tenantId} ${result.before} → ${result.after}`
        : `tickmark: stripe ${event.type} ignored — ${result.reason}`,
    );
    // 200 even when nothing was done: Stripe retrying an event this installation does not act on
    // would change nothing, and a non-2xx would make it retry for days.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ received: true, ...result }));
  }

  // --- small helpers ---------------------------------------------------------------------------

  /** `acme-accounting`, or `acme-accounting-2` when that one is taken. */
  function uniqueSlug(name) {
    const base = slugify(name);
    let candidate = base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      if (!registry.prepare('SELECT 1 AS taken FROM tenant WHERE slug = ?').get(candidate)) return candidate;
      candidate = `${base}-${suffix}`;
    }
    return `${base}-${Date.now()}`;
  }

  /** Where a new practice's host lives, when the operator has configured a wildcard domain. */
  function hostForSlug(slug) {
    const domain = process.env.TICKMARK_TENANT_DOMAIN;
    return domain ? `${slug}.${domain}` : null;
  }
}

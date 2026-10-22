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
import { createHash } from 'node:crypto';

import {
  CHALLENGE_COOKIE,
  challengeCookie,
  challengeFor,
  clearChallengeCookie,
  clearSessionCookie,
  createSession,
  endChallenge,
  endSession,
  parseCookies,
  recordAcceptedStep,
  secureCookies,
  sessionCookie,
  spendAttemptOn,
  spendRecoveryCode,
  startChallenge,
  twoFactorState,
} from '../auth.js';
import { verifyPassword } from '../crypto.js';
import { field, formFields, readBody } from '../http.js';
import { createAttemptLimiter } from '../ratelimit.js';
import { codeStepFor } from '../totp.js';
import { clientAddress } from './client-address.js';
import { redirect, sendPage } from '../views.js';

import { applyStripeEvent } from './billing.js';
import {
  TENANT_STATUS,
  tenantAllowsAccess,
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
  UNVERIFIABLE_PASSWORD_HASH,
} from './registry.js';
import {
  createBillingPortalSession,
  createCheckoutSession,
  parseEvent,
  verifyWebhookSignature,
} from './stripe.js';
import { dashboardPage, loginCodePage, loginPage, signupPage, simplePage } from './views.js';

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
  '/signin/code',
  '/signout',
  '/logout',
  '/dashboard',
  '/billing/checkout',
  '/billing/checkout/success',
  '/billing/portal',
  '/webhooks/stripe',
]);

// Slug-path mode shares one host across every practice. Only its login lifecycle is intercepted;
// billing and dashboard routes remain platform-host operations scoped by the platform session.
const SLUG_GATEWAY_PATHS = new Set(['/', '/signup', '/login', '/signin', '/signin/code', '/logout', '/signout']);

export function createGateway({
  registry,
  pool,
  stripe = null,
  secure = secureCookies(),
  signUpLimiter = createAttemptLimiter(),
  loginLimiter = createAttemptLimiter(),
  sourceLoginLimiter = createAttemptLimiter({ limit: 30 }),
  trustedProxies = [],
  storageQuotaBytes = 5 * 1024 ** 3,
  now = () => new Date(),
}) {
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
    if (tenant?.lifecycle_state && tenant.lifecycle_state !== 'active') return null;
    const found = practitionerForAccount(pool, tenant, email);
    return found;
  }

  function registryMembership(tenant, accountId) {
    return Boolean(registry.prepare('SELECT 1 FROM tenant_member WHERE tenant_id = ? AND account_id = ?')
      .get(tenant.id, accountId));
  }

  /** A challenge is useful only on its issuing tenant host and while its account is still a member. */
  function hostedChallenge(tenant, request) {
    if (!tenant) return null;
    const db = pool.get(tenant.id);
    const jar = parseCookies(request.headers.cookie);
    const challenge = challengeFor(db, jar[CHALLENGE_COOKIE], now());
    if (!challenge) return null;
    const practitioner = db.prepare('SELECT id, email FROM practitioner WHERE id = ? AND removed_at IS NULL')
      .get(challenge.practitionerId);
    const account = practitioner ? accountByEmail(registry, practitioner.email) : null;
    if (!practitioner || !account || !registryMembership(tenant, account.id)) {
      endChallenge(db, challenge.id);
      return null;
    }
    return { db, challenge, practitioner, account, token: jar[CHALLENGE_COOKIE] };
  }

  function replacePresentedSessions(request, db = null) {
    endSaasSession(registry, sessionTokenFrom(request));
    const jar = parseCookies(request.headers.cookie);
    if (db && jar.tickmark_session) endSession(db, jar.tickmark_session);
    if (db && jar[CHALLENGE_COOKIE]) {
      const pending = challengeFor(db, jar[CHALLENGE_COOKIE], now());
      if (pending) endChallenge(db, pending.id);
    }
    // The tenant file scopes core tokens: a token from another practice cannot resolve in this file.
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
  const statusFor = (tenant) => ({
    ...(TENANT_STATUS[tenant?.status] ?? TENANT_STATUS.cancelled),
    allowed: tenantAllowsAccess(tenant),
  });

  return { handle, tenantUrlFor, tenantOfHost, customerIdOf, statusFor };


  // --- the dispatcher --------------------------------------------------------------------------

  function handle(request, response, url) {
    const originalPath = url.pathname;
    const slugMatch = /^\/t\/([a-z0-9-]+)(\/|$)/i.exec(originalPath);
    const pathTenant = slugMatch ? tenantForSlug(registry, slugMatch[1]) : null;
    const pathPrefix = pathTenant ? `/t/${pathTenant.slug}` : '';
    if (pathTenant) {
      const hostTenant = tenantForHost(registry, request.headers.host);
      if (hostTenant && hostTenant.id !== pathTenant.id) return false;
      const normalizedPath = originalPath.slice(pathPrefix.length) || '/';
      if (!SLUG_GATEWAY_PATHS.has(normalizedPath)) return false;
      url.pathname = normalizedPath;
    } else if (!GATEWAY_PATHS.has(originalPath)) {
      return false;
    }
    const route = (path) => `${pathPrefix}${path}`;
    const restorePath = () => { url.pathname = originalPath; };

    // Stripe has no cookie and no host of ours; its signature is the credential.
    if (url.pathname === '/webhooks/stripe') {
      handleWebhook(request, response);
      return true;
    }

    const tenant = pathTenant ?? tenantOfHost(url, request);
    const token = sessionTokenFrom(request);
    const session = token ? tenantForToken(registry, token) : null;
    const method = request.method;

    // The platform's own front door. A practice's host falls through to the core, which has a home
    // page of its own; the bare platform has none, so it sends you where you were going anyway.
    if (url.pathname === '/') {
      if (tenant) {
        restorePath();
        return false;
      }
      redirect(response, session ? '/dashboard' : '/signup');
      return true;
    }

    if (url.pathname === '/signup') {
      // A practice's own address does not create a second practice; the way in is an invitation.
      if (tenant) {
        redirect(response, route('/login'));
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
          redirect(response, route('/login'));
          return true;
        }
        sendPage(response, 200, loginPage({ loginPath: route('/login'), signupPath: route('/signup') }));
        return true;
      }
      handleLogin(request, response, tenant, route);
      return true;
    }

    if (url.pathname === '/signin/code') {
      if (method === 'GET') {
        const pending = hostedChallenge(tenant, request);
        sendPage(response, pending ? 200 : 410, loginCodePage({
          expired: !pending,
          problem: pending ? null : 'Nothing was signed in. Start again with your password.',
          codePath: route('/signin/code'), loginPath: route('/login'), logoutPath: route('/logout'),
        }));
        return true;
      }
      if (method === 'POST') {
        handleLoginCode(request, response, tenant, route);
        return true;
      }
    }

    if (url.pathname === '/logout' || url.pathname === '/signout') {
      handleLogout(request, response, tenant, route);
      return true;
    }

    // Everything below needs a signed-in account.
    if (!session) {
      redirect(response, route('/login'));
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

    restorePath();
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
      storageQuotaBytes,
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

  async function handleLogin(request, response, onTenantHost, route = (path) => path) {
    const fields = formFields(await readBody(request));
    const email = field(fields, 'email')?.toLowerCase() ?? null;
    const password = typeof fields.password === 'string' ? fields.password : '';

    // The identifier bucket catches distributed guessing at one account; the source bucket catches
    // one caller rotating through identifiers. Both are checked before scrypt. Forwarded addresses
    // are used only when the immediate peer is an explicitly trusted proxy.
    const keys = [`login-account:${email ?? ''}`, `login-source:${clientAddress(request, trustedProxies)}`];
    const blockedFor = Math.max(
      loginLimiter?.blockedFor(keys[0]) ?? 0,
      sourceLoginLimiter?.blockedFor(keys[1]) ?? 0,
    );
    if (blockedFor > 0) {
      const minutes = Math.ceil(blockedFor / 60000);
      sendPage(response, 429, loginPage({
        values: { email: email ?? '' },
        problem: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        loginPath: route('/login'), signupPath: route('/signup'),
      }));
      return;
    }

    const account = email ? accountByEmail(registry, email) : null;
    // One sentence for both kinds of failure: "no such account" tells a stranger which addresses
    // exist, and the core's own sign-in page takes the same line about the same question. The dummy
    // hash also makes unknown-account failures pay the same password-verification cost.
    const accepted = await verifyPassword(password, account?.password_hash ?? UNVERIFIABLE_PASSWORD_HASH);
    if (!account || !accepted) {
      loginLimiter?.failed(keys[0]);
      sourceLoginLimiter?.failed(keys[1]);
      sendPage(
        response,
        401,
        loginPage({
          values: { email: email ?? '' },
          problem: 'That email and password do not match an account.',
          loginPath: route('/login'), signupPath: route('/signup'),
        }),
      );
      return;
    }

    if (onTenantHost?.lifecycle_state && onTenantHost.lifecycle_state !== 'active') {
      sendPage(response, 410, simplePage('Practice closed', 'This practice is being closed', 'Its workspace is unavailable while its data is being retired.'));
      return;
    }

    loginLimiter?.succeeded(keys[0]);
    // The platform dashboard is not a tenant session. It may show billing and a workspace link, but
    // a single-practice account may also receive the same tenant-local session the old flow used.
    // TOTP remains a hard stop: when it is armed, only the tenant host can complete the challenge.
    if (!onTenantHost) {
      replacePresentedSessions(request);
      const platform = createSaasSession(registry, account.id, now());
      const tenant = registry.prepare(
        `SELECT t.id, t.slug, t.name, t.plan, t.status, t.lifecycle_state
           FROM tenant_member m JOIN tenant t ON t.id = m.tenant_id
          WHERE m.account_id = ? ORDER BY t.created_at LIMIT 1`,
      ).get(account.id);
      const found = tenant ? bridgeIntoTenant(tenant, account.email) : null;
      const cookies = [saasSessionCookie(platform.token, secure)];
      if (found && twoFactorState(found.db, found.practitioner.id).state !== 'on') {
        const workspace = createSession(found.db, found.practitioner.id, now());
        cookies.push(sessionCookie(workspace.token, secure));
        redirect(response, route('/dashboard'), cookies);
        return;
      }
      redirect(response, found ? `${route('/dashboard')}?second-factor=1` : route('/dashboard'), cookies);
      return;
    }

    if (!registryMembership(onTenantHost, account.id)) {
      loginLimiter?.failed(keys[0]);
      sourceLoginLimiter?.failed(keys[1]);
      sendPage(response, 401, loginPage({
        values: { email: email ?? '' },
        problem: 'That email and password do not match an account.',
        loginPath: route('/login'), signupPath: route('/signup'),
      }));
      return;
    }

    const found = bridgeIntoTenant(onTenantHost, account.email);
    if (!found) {
      // Registry membership alone is never enough: the tenant file must still contain an active
      // practitioner. A removed or partially provisioned member is denied at the boundary.
      loginLimiter?.failed(keys[0]);
      sourceLoginLimiter?.failed(keys[1]);
      sendPage(response, 401, loginPage({
        values: { email: email ?? '' },
        problem: 'That email and password do not match an account.',
        loginPath: route('/login'), signupPath: route('/signup'),
      }));
      return;
    }

    replacePresentedSessions(request, found.db);
    const factor = twoFactorState(found.db, found.practitioner.id);
    if (factor.state === 'on') {
      const pending = startChallenge(found.db, found.practitioner.id, now());
      redirect(response, route('/signin/code'), [
        clearSaasSessionCookie(secure),
        clearSessionCookie(secure),
        challengeCookie(pending.token, secure),
      ]);
      return;
    }

    const platform = createSaasSession(registry, account.id, now());
    const workspace = createSession(found.db, found.practitioner.id, now());
    redirect(response, route('/requests'), [
      saasSessionCookie(platform.token, secure),
      sessionCookie(workspace.token, secure),
      clearChallengeCookie(secure),
    ]);
  }

  async function handleLoginCode(request, response, tenant, route = (path) => path) {
    const pending = hostedChallenge(tenant, request);
    if (!pending) {
      sendPage(response, 410, loginCodePage({ expired: true, problem: 'Nothing was signed in. Start again with your password.',
        codePath: route('/signin/code'), loginPath: route('/login'), logoutPath: route('/logout'),
      }), {
        'Set-Cookie': clearChallengeCookie(secure),
      });
      return;
    }

    const key = `login-totp:${tenant.id}:${pending.practitioner.id}`;
    const sourceKey = `login-totp-source:${clientAddress(request, trustedProxies)}`;
    const blockedFor = Math.max(loginLimiter?.blockedFor(key) ?? 0, sourceLoginLimiter?.blockedFor(sourceKey) ?? 0);
    if (blockedFor > 0) {
      const minutes = Math.ceil(blockedFor / 60000);
      sendPage(response, 429, loginCodePage({
        problem: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        codePath: route('/signin/code'), loginPath: route('/login'), logoutPath: route('/logout'),
      }));
      return;
    }

    const fields = formFields(await readBody(request));
    const code = field(fields, 'code') ?? '';
    const factor = twoFactorState(pending.db, pending.practitioner.id);
    if (factor.state !== 'on') {
      endChallenge(pending.db, pending.challenge.id);
      sendPage(response, 410, loginCodePage({ expired: true, problem: 'The second-factor setting changed. Start again with your password.',
        codePath: route('/signin/code'), loginPath: route('/login'), logoutPath: route('/logout'),
      }), {
        'Set-Cookie': clearChallengeCookie(secure),
      });
      return;
    } else {
      const step = codeStepFor(factor.secret, code);
      const fresh = step !== null && step !== factor.lastStep;
      if (!fresh && !spendRecoveryCode(pending.db, pending.practitioner.id, code, now())) {
        loginLimiter?.failed(key);
        sourceLoginLimiter?.failed(sourceKey);
        if (spendAttemptOn(pending.db, pending.challenge.id)) {
          endChallenge(pending.db, pending.challenge.id);
          sendPage(response, 401, loginCodePage({
            problem: 'That was the last attempt for this sign-in. Start again with your password and a current code.',
            codePath: route('/signin/code'), loginPath: route('/login'), logoutPath: route('/logout'),
          }), { 'Set-Cookie': clearChallengeCookie(secure) });
          return;
        }
        sendPage(response, 401, loginCodePage({ problem: 'That code was not right. Try the current code, or use a recovery code.',
          codePath: route('/signin/code'), loginPath: route('/login'), logoutPath: route('/logout'),
        }));
        return;
      }
      if (fresh) recordAcceptedStep(pending.db, pending.practitioner.id, step);
      loginLimiter?.succeeded(key);
      sourceLoginLimiter?.succeeded(sourceKey);
      endChallenge(pending.db, pending.challenge.id);
    }

    // Re-check membership immediately before minting either session. A removal while the challenge
    // was open ends the flow even if the code is correct.
    if (!registryMembership(tenant, pending.account.id) ||
        !pending.db.prepare('SELECT 1 FROM practitioner WHERE id = ? AND removed_at IS NULL')
          .get(pending.practitioner.id)) {
      sendPage(response, 403, loginCodePage({ problem: 'Your membership has changed. Ask a practice owner to invite you again.',
        codePath: route('/signin/code'), loginPath: route('/login'), logoutPath: route('/logout'),
      }), {
        'Set-Cookie': clearChallengeCookie(secure),
      });
      return;
    }
    const platform = createSaasSession(registry, pending.account.id, now());
    const workspace = createSession(pending.db, pending.practitioner.id, now());
    redirect(response, route('/requests'), [
      saasSessionCookie(platform.token, secure),
      sessionCookie(workspace.token, secure),
      clearChallengeCookie(secure),
    ]);
  }

  function handleLogout(request, response, tenant, route = (path) => path) {
    endSaasSession(registry, sessionTokenFrom(request));
    const jar = parseCookies(request.headers.cookie);
    if (tenant) {
      const db = pool.get(tenant.id);
      if (jar.tickmark_session) endSession(db, jar.tickmark_session);
      const pending = challengeFor(db, jar[CHALLENGE_COOKIE], now());
      if (pending) endChallenge(db, pending.id);
    }
    redirect(response, route('/login'), [
      clearSaasSessionCookie(secure),
      clearSessionCookie(secure),
      clearChallengeCookie(secure),
    ]);
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
    const inUse = (slug) => Boolean(
      registry.prepare('SELECT 1 AS taken FROM tenant WHERE slug = ?').get(slug) ||
      registry.prepare('SELECT 1 AS taken FROM tenant_deletion WHERE slug_digest = ?').get(createHash('sha256').update(slug.toLowerCase()).digest('hex')),
    );
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      if (!inUse(candidate)) return candidate;
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

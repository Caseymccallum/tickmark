/**
 * The SaaS gateway: sign up, sign in, the billing wall, and Stripe's webhook.
 *
 * These drive the real entry point (`createSaasServer`) against a real registry and real tenant
 * files. Stripe itself is never contacted: the one place a checkout session is created is tested
 * with a stubbed `fetch`, and every webhook here is signed with the same HMAC scheme Stripe uses,
 * so what is exercised is the verification rather than a promise that it happens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSaasServer } from '../src/tenancy/entry.js';
import { setTenantBilling } from '../src/tenancy/registry.js';
import { createAttemptLimiter } from '../src/ratelimit.js';
import { agent } from './helpers.js';

const PASSWORD = 'a long enough password';
const WEBHOOK_SECRET = 'whsec_test_secret';

/** The server the way `MULTI_TENANT=1` starts it, on a port nobody chose. */
async function withSaas(run, { env = {}, loginLimiter, sourceLoginLimiter, log, now } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-gateway-'));
  let saas = null;
  try {
    saas = createSaasServer({
      registryFile: join(directory, 'saas.db'),
      tenantsRoot: join(directory, 'tenants'),
      env,
      loginLimiter,
      sourceLoginLimiter,
      log,
      now,
    });
    await new Promise((resolve) => saas.server.listen(0, resolve));
    const base = `http://127.0.0.1:${saas.server.address().port}`;
    await run({ base, ...saas, agent: () => agent(base) });
  } finally {
    try {
      saas?.server.closeAllConnections?.();
      if (saas) await new Promise((resolve) => saas.server.close(resolve));
    } catch {
      // Cleanup never outranks the test's own result.
    }
    try {
      saas?.pool.closeAll();
      saas?.registry.close();
    } catch {
      // As above.
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`tickmark test cleanup: ${directory} not removed — ${error.code ?? error.message}`);
    }
  }
}

/** A Stripe webhook the way Stripe signs one: HMAC over `timestamp.payload`. */
function signedWebhook(event, { secret = WEBHOOK_SECRET, at = Date.now() } = {}) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(at / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return { payload, header: `t=${timestamp},v1=${signature}` };
}

const postWebhook = (client, { payload, header }) =>
  client.request('/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload,
  });

const signup = (client, fields = {}) =>
  client.post('/signup', {
    practice_name: 'Acme Accounting',
    email: 'sam@acme.example',
    password: PASSWORD,
    ...fields,
  });

const tenantRow = (registry, slug = 'acme-accounting') =>
  registry.prepare('SELECT id, slug, name, plan, status FROM tenant WHERE slug = ?').get(slug);

/** One request with a Host header of our choosing — `fetch` will not send one. */
function askWithHost(base, path, host, { method = 'GET', form = null, cookie = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const requestHeaders = { host, ...headers };
    if (cookie) requestHeaders.cookie = cookie;
    if (body !== null) {
      requestHeaders['content-type'] = 'application/x-www-form-urlencoded';
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = httpRequest(`${base}${path}`, { method, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          location: response.headers.location,
          cookies: response.headers['set-cookie'] ?? [],
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}


test('signing up creates a practice that is real but not yet paid for', async () => {
  await withSaas(async ({ agent, registry, pool }) => {
    const client = agent();
    const created = await signup(client);

    assert.equal(created.status, 303);
    assert.equal(created.headers.get('location'), '/dashboard', 'billing is not configured, so there is nowhere else to go');

    const tenant = tenantRow(registry);
    assert.ok(tenant, 'the practice exists in the registry');
    assert.equal(tenant.status, 'pending_payment', 'and it is waiting for its subscription');
    assert.equal(tenant.plan, 'standard');

    // Its pages are the core's, served from the tenant's own file.
    const dashboard = await (await client.get('/dashboard')).text();
    assert.match(dashboard, /Acme Accounting/);
    assert.match(dashboard, /not open yet/, 'the dashboard says the subscription is not active');

    // And the workspace itself is behind the billing wall — before any tenant file is opened.
    const beforeOpen = pool.stats().open;
    const workspace = await client.get('/t/acme-accounting/requests');
    assert.equal(workspace.status, 402);
    assert.match(await workspace.text(), /Your subscription is not set up yet/);
    assert.equal(pool.stats().open, beforeOpen, 'the blocked request opened no database');
  });
});

test('signing up with Stripe redirects to checkout, with the tenant id in the metadata', async () => {
  const realFetch = globalThis.fetch;
  let asked = null;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.stripe.com')) return realFetch(url, init);
    asked = { url: String(url), body: String(init.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    };
  };

  try {
    await withSaas(
      async ({ agent, registry }) => {
        const created = await signup(agent());

        assert.equal(created.status, 303);
        assert.equal(created.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_1');

        const tenant = tenantRow(registry);
        assert.ok(asked, 'Stripe was asked for a checkout session');
        assert.match(asked.url, /\/v1\/checkout\/sessions$/);
        const body = new URLSearchParams(asked.body);
        assert.equal(body.get('metadata[tenant_id]'), tenant.id, 'the tenant id is the anchor');
        assert.equal(
          body.get('subscription_data[metadata][tenant_id]'),
          tenant.id,
          'and it rides on the subscription too, for the events that arrive without a session',
        );
        assert.equal(body.get('mode'), 'subscription');
        assert.equal(body.get('line_items[0][price]'), 'price_test_1');
      },
      {
        env: {
          STRIPE_SECRET_KEY: 'sk_test_1',
          STRIPE_PRICE_ID: 'price_test_1',
          STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
          TICKMARK_PUBLIC_URL: 'http://localhost:3000',
        },
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});


test('the webhook refuses a forged signature, and one that is too old to trust', async () => {
  await withSaas(
    async ({ agent, registry }) => {
      const client = agent();
      await signup(client);
      const tenant = tenantRow(registry);

      const event = {
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: { object: { metadata: { tenant_id: tenant.id } } },
      };

      // Signed with the wrong secret: the classic forgery, and it must do nothing at all.
      const refused = await postWebhook(client, signedWebhook(event, { secret: 'whsec_not_ours' }));
      assert.equal(refused.status, 400);
      assert.equal(tenantRow(registry).status, 'pending_payment', 'a forged webhook changed nothing');

      // Correctly signed, but a week old: replaying a genuine event must not re-open a practice.
      const stale = await postWebhook(client, signedWebhook(event, { at: Date.now() - 7 * 24 * 60 * 60 * 1000 }));
      assert.equal(stale.status, 400);
      assert.equal(tenantRow(registry).status, 'pending_payment');

      // And a body that is not an event, correctly signed, is still not an event.
      assert.equal((await postWebhook(client, signedWebhook({ hello: 'world' }))).status, 400);
    },
    { env: { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } },
  );
});

test('a paid checkout opens the practice, and a cancelled subscription closes it again', async () => {
  await withSaas(
    async ({ agent, registry, base }) => {
      const client = agent();
      await signup(client);
      const tenant = tenantRow(registry);

      // What Stripe sends when the hosted page finishes successfully.
      const paid = await postWebhook(
        client,
        signedWebhook({
          id: 'evt_paid',
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_test_1',
              customer: 'cus_1',
              subscription: 'sub_1',
              metadata: { tenant_id: tenant.id, practice_name: 'Acme Accounting' },
            },
          },
        }),
      );
      assert.equal(paid.status, 200);
      assert.equal(tenantRow(registry).status, 'active', 'the practice is open');
      assert.equal(
        registry.prepare('SELECT stripe_customer_id FROM tenant WHERE id = ?').get(tenant.id).stripe_customer_id,
        'cus_1',
        'and Stripe can be found from the practice row',
      );

      // The workspace is no longer behind the wall: an anonymous visit reaches the core's own
      // sign-in rather than the billing page.
      const openVisit = await client.get('/t/acme-accounting/requests');
      assert.equal(openVisit.status, 303);
      assert.equal(openVisit.headers.get('location'), '/signin', 'the core answers, not the billing wall');

      // Sign in through the gateway: the registry session is bridged into the tenant's own file.
      const signedIn = await client.post('/login', { email: 'sam@acme.example', password: PASSWORD });
      assert.equal(signedIn.status, 303);

      const workspace = await client.get('/t/acme-accounting/requests');
      assert.equal(workspace.status, 200, 'the bridged session opens the core pages');

      // A key first: the link page refuses without one, because a link that cannot receive an
      // encrypted file is a promise the product cannot keep.
      const { generatePracticeKey } = await import('../web/tickmark-crypto.js');
      const { publicKey, wrappedPrivateKey } = await generatePracticeKey(PASSWORD);
      await client.post('/t/acme-accounting/setup', {
        public_key: JSON.stringify(publicKey),
        wrapped_private_key: wrappedPrivateKey,
      });

      // A client link, so the "clients are not locked out" promise can be checked below.
      // On a platform host the practice's pages are reached through its slug prefix.
      const created = await client.post('/t/acme-accounting/requests', {
        client: 'Northwind Ltd',
        client_email: 'accounts@northwind.example',
        title: '2025 return',
        items: 'Bank statements',
      });
      assert.equal(created.status, 303, 'the practice can work while it is paid up');
      const requestId = created.headers.get('location').split('/').pop();
      const linked = await client.post(`/t/acme-accounting/requests/${requestId}/link`, { days: '30' });
      const token = /\/r\/([A-Za-z0-9_-]+)/.exec(await linked.text())?.[1];
      assert.ok(token, 'a link was issued');

      // The subscription ends.
      const deleted = await postWebhook(
        client,
        signedWebhook({
          id: 'evt_deleted',
          type: 'customer.subscription.deleted',
          data: { object: { id: 'sub_1', customer: 'cus_1', metadata: { tenant_id: tenant.id } } },
        }),
      );
      assert.equal(deleted.status, 200);
      assert.equal(tenantRow(registry).status, 'cancelled', 'the practice is locked out at once');

      const locked = await client.get('/t/acme-accounting/requests');
      assert.equal(locked.status, 402);
      assert.match(
        await locked.text(),
        /Your subscription is currently inactive\. Please update your payment details to access your documents\./,
      );

      // But the client mid-upload is not stranded by the practice's billing.
      const clientPage = await agent(base).get(`/r/${token}`);
      assert.equal(clientPage.status, 200, 'a client link still opens');
    },
    { env: { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } },
  );
});

test('a failing card marks the practice past due, and paying opens it again', async () => {
  await withSaas(
    async ({ agent, registry }) => {
      const client = agent();
      await signup(client);
      const tenant = tenantRow(registry);

      await postWebhook(
        client,
        signedWebhook({
          id: 'evt_paid',
          type: 'checkout.session.completed',
          data: { object: { metadata: { tenant_id: tenant.id } } },
        }),
      );
      assert.equal(tenantRow(registry).status, 'active');

      await postWebhook(
        client,
        signedWebhook({
          id: 'evt_failed',
          type: 'invoice.payment_failed',
          data: { object: { id: 'in_1', metadata: { tenant_id: tenant.id } } },
        }),
      );
      assert.equal(tenantRow(registry).status, 'past_due', 'the card failed, and it is said plainly');

      await postWebhook(
        client,
        signedWebhook({
          id: 'evt_paid_again',
          type: 'invoice.payment_succeeded',
          data: { object: { id: 'in_1', metadata: { tenant_id: tenant.id } } },
        }),
      );
      assert.equal(tenantRow(registry).status, 'active', 'and paying opens it again');

      // An event about somebody else's tenant is acknowledged and ignored, never acted on.
      const stranger = await postWebhook(
        client,
        signedWebhook({
          id: 'evt_stranger',
          type: 'checkout.session.completed',
          data: { object: { metadata: { tenant_id: 'not-a-tenant' } } },
        }),
      );
      assert.equal(stranger.status, 200, 'acknowledged, so Stripe stops retrying');
      assert.equal((await stranger.json()).handled, false);
    },
    { env: { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } },
  );
});

test('a failing card keeps the documents open for the grace window, so a fixable hiccup is not a lockout', async () => {
  await withSaas(
    async ({ agent, registry }) => {
      const client = agent();
      await signup(client);
      const tenant = tenantRow(registry);

      await postWebhook(client, signedWebhook({ id: 'evt_paid', type: 'checkout.session.completed', data: { object: { metadata: { tenant_id: tenant.id } } } }));
      await postWebhook(client, signedWebhook({ id: 'evt_failed', type: 'invoice.payment_failed', data: { object: { id: 'in_1', metadata: { tenant_id: tenant.id } } } }));
      assert.equal(tenantRow(registry).status, 'past_due');

      const open = await client.get('/t/acme-accounting/requests');
      assert.notEqual(open.status, 402, 'the practice keeps working while the card is being fixed');
    },
    { env: { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } },
  );
});

test('with the grace window set to zero, a failing card locks the practice at once', async () => {
  // The grace length is read from the environment like `TICKMARK_PUBLIC_URL` and the cookie flag, so it
  // is set here rather than through the server's `env` — which only carries Stripe's and the relay's.
  const previous = process.env.TICKMARK_PAST_DUE_GRACE_DAYS;
  process.env.TICKMARK_PAST_DUE_GRACE_DAYS = '0';
  try {
    await withSaas(
      async ({ agent, registry }) => {
        const client = agent();
        await signup(client);
        const tenant = tenantRow(registry);

        await postWebhook(client, signedWebhook({ id: 'evt_paid', type: 'checkout.session.completed', data: { object: { metadata: { tenant_id: tenant.id } } } }));
        await postWebhook(client, signedWebhook({ id: 'evt_failed', type: 'invoice.payment_failed', data: { object: { id: 'in_1', metadata: { tenant_id: tenant.id } } } }));
        assert.equal(tenantRow(registry).status, 'past_due');

        const locked = await client.get('/t/acme-accounting/requests');
        assert.equal(locked.status, 402, 'an operator who wants no slack sets the window to zero and gets the old behaviour');
      },
      { env: { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } },
    );
  } finally {
    if (previous === undefined) delete process.env.TICKMARK_PAST_DUE_GRACE_DAYS;
    else process.env.TICKMARK_PAST_DUE_GRACE_DAYS = previous;
  }
});


test('the platform root sends you to signup or to your dashboard, and a practice root is the core\u2019s', async () => {
  await withSaas(async ({ agent, base, registry }) => {
    const client = agent();
    const root = await client.get('/');
    assert.equal(root.status, 303);
    assert.equal(root.headers.get('location'), '/signup', 'a stranger landing on the platform is offered a way in');

    await signup(client);
    const afterwards = await client.get('/');
    assert.equal(afterwards.headers.get('location'), '/dashboard', 'a signed-in person is sent to their workspace');

    // A mapped host is not the platform: its root belongs to that practice. While it is unpaid that
    // means the billing wall; once paid it is the core's own home page. The Host header is set with
    // a raw request because `fetch` refuses to let a caller choose it.
    const row = tenantRow(registry);
    registry.prepare('INSERT INTO tenant_host (host, tenant_id) VALUES (?, ?)').run('acme.example', row.id);

    const unpaidRoot = await askWithHost(base, '/', 'acme.example');
    assert.equal(unpaidRoot.status, 402, 'an unpaid practice\u2019s root is the billing wall');

    setTenantBilling(registry, row.id, { status: 'active' });
    const practiceRoot = await askWithHost(base, '/', 'acme.example');
    assert.equal(practiceRoot.status, 200, 'and once paid it is served by the core');
    assert.match(practiceRoot.body, /The list of documents a client owes you/);
  });
});
test('a practice with a second factor cannot be entered through the platform', async () => {
  let clock = new Date();
  await withSaas(async ({ base, registry, pool }) => {
    const client = agent(base);
    await signup(client);
    const row = tenantRow(registry);
    setTenantBilling(registry, row.id, { status: 'active' });
    registry.prepare('INSERT INTO tenant_host (host, tenant_id) VALUES (?, ?)').run('acme.example', row.id);

    // Arm the second factor inside the practice's own file, the way the practice would: a pending secret, then a
    // confirmation with a code the authenticator would have produced.
    const { clearTwoFactor, setPendingSecret, confirmTwoFactor, twoFactorState } = await import('../src/auth.js');
    const { codeAt, counterAt, generateSecret, generateRecoveryCodes } = await import('../src/totp.js');
    const tenantDb = pool.get(row.id);
    const member = tenantDb.prepare('SELECT id FROM practitioner').get();
    const secret = generateSecret();
    setPendingSecret(tenantDb, member.id, secret);
    confirmTwoFactor(tenantDb, member.id, generateRecoveryCodes());
    assert.equal(twoFactorState(tenantDb, member.id).state, 'on', 'the practice really has a second factor armed');

    // The platform login authenticates only to the platform dashboard. It does not mint a session in the tenant file.
    const platformHost = new URL(base).host;
    const signedIn = await askWithHost(base, '/login', platformHost, {
      method: 'POST',
      form: { email: 'sam@acme.example', password: PASSWORD },
    });

    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.location, '/dashboard?second-factor=1');
    assert.ok(
      !signedIn.cookies.some((cookie) => cookie.startsWith('tickmark_session=')),
      'and NO workspace session is minted, which is the whole point',
    );
    assert.ok(
      signedIn.cookies.some((cookie) => cookie.startsWith('tickmark_saas_session=')),
      'the platform session still exists — the dashboard and billing need it',
    );

    // The dashboard has no document access. The tenant host requires its own complete TOTP flow.
    const dashboard = await askWithHost(base, signedIn.location, platformHost, {
      cookie: signedIn.cookies.map((value) => value.split(';')[0]).join('; '),
    });
    assert.equal(dashboard.status, 200, 'the dashboard opens');
    assert.match(dashboard.body, /asks for a code/);

    const workspacePassword = await askWithHost(base, '/t/acme-accounting/signin', platformHost, {
      method: 'POST', form: { email: 'sam@acme.example', password: PASSWORD },
    });
    assert.equal(workspacePassword.status, 303);
    assert.equal(workspacePassword.location, '/t/acme-accounting/signin/code', 'the tenant challenge preserves the slug route');
    assert.ok(workspacePassword.cookies.some((cookie) => cookie.startsWith('tickmark_challenge=')));
    assert.ok(!workspacePassword.cookies.some((cookie) => cookie.startsWith('tickmark_session=') && !cookie.startsWith('tickmark_session=;')));
    assert.ok(!workspacePassword.cookies.some((cookie) => cookie.startsWith('tickmark_saas_session=') && !cookie.startsWith('tickmark_saas_session=;')));

    const challengeJar = workspacePassword.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const codePage = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, { cookie: challengeJar });
    assert.equal(codePage.status, 200);
    assert.match(codePage.body, /authenticator app/);

    const wrongCode = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, {
      method: 'POST', form: { code: 'not-a-code' }, cookie: challengeJar,
    });
    assert.equal(wrongCode.status, 401, 'an incorrect code does not create a session');
    assert.ok(!wrongCode.cookies.some((cookie) => cookie.startsWith('tickmark_session=') && !cookie.startsWith('tickmark_session=;')));

    const code = codeAt(secret, counterAt(new Date()));
    const completed = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, {
      method: 'POST', form: { code }, cookie: challengeJar,
    });
    assert.equal(completed.status, 303);
    assert.equal(completed.location, '/t/acme-accounting/requests');
    assert.ok(completed.cookies.some((cookie) => cookie.startsWith('tickmark_session=')));
    assert.ok(completed.cookies.some((cookie) => cookie.startsWith('tickmark_saas_session=')));

    const workspaceJar = completed.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const workspace = await askWithHost(base, '/t/acme-accounting/requests', platformHost, { cookie: workspaceJar });
    assert.equal(workspace.status, 200, 'both factors produce the tenant-local session the core accepts');

    const replay = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, {
      method: 'POST', form: { code }, cookie: challengeJar,
    });
    assert.equal(replay.status, 410, 'a spent challenge cannot mint another session');

    const guessingLogin = await askWithHost(base, '/t/acme-accounting/signin', platformHost, {
      method: 'POST', form: { email: 'sam@acme.example', password: PASSWORD },
    });
    const guessingJar = guessingLogin.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const guess = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, {
        method: 'POST', form: { code: 'not-a-code' }, cookie: guessingJar,
      });
      assert.equal(guess.status, 401);
      if (attempt === 4) assert.match(guess.body, /last attempt/);
    }
    const afterGuessBudget = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, {
      method: 'POST', form: { code }, cookie: guessingJar,
    });
    assert.equal(afterGuessBudget.status, 410, 'a correct code cannot rescue an exhausted challenge');

    const expiringLogin = await askWithHost(base, '/t/acme-accounting/signin', platformHost, {
      method: 'POST', form: { email: 'sam@acme.example', password: PASSWORD },
    });
    const expiringJar = expiringLogin.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    clock = new Date(clock.getTime() + 11 * 60 * 1000);
    const expired = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, { cookie: expiringJar });
    assert.equal(expired.status, 410, 'a challenge expires without minting a session');

    const logoutLogin = await askWithHost(base, '/t/acme-accounting/signin', platformHost, {
      method: 'POST', form: { email: 'sam@acme.example', password: PASSWORD },
    });
    const logoutJar = logoutLogin.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    await askWithHost(base, '/t/acme-accounting/logout', platformHost, { method: 'POST', cookie: logoutJar });
    const afterLogout = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, { cookie: logoutJar });
    assert.equal(afterLogout.status, 410, 'logout during a challenge invalidates it');

    const changedFactorLogin = await askWithHost(base, '/t/acme-accounting/signin', platformHost, {
      method: 'POST', form: { email: 'sam@acme.example', password: PASSWORD },
    });
    const changedFactorJar = changedFactorLogin.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    clearTwoFactor(tenantDb, member.id);
    const changedFactor = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, {
      method: 'POST', form: { code: codeAt(secret, counterAt(clock)) }, cookie: changedFactorJar,
    });
    assert.equal(changedFactor.status, 410, 'a changed factor setting invalidates an outstanding challenge');
    setPendingSecret(tenantDb, member.id, secret);
    confirmTwoFactor(tenantDb, member.id, generateRecoveryCodes(), clock);

    const removedLogin = await askWithHost(base, '/t/acme-accounting/signin', platformHost, {
      method: 'POST', form: { email: 'sam@acme.example', password: PASSWORD },
    });
    const removedJar = removedLogin.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    registry.prepare('DELETE FROM tenant_member WHERE tenant_id = ? AND account_id = (SELECT id FROM account WHERE email = ?)')
      .run(row.id, 'sam@acme.example');
    const removed = await askWithHost(base, '/t/acme-accounting/signin/code', platformHost, {
      method: 'POST', form: { code: codeAt(secret, counterAt(clock)) }, cookie: removedJar,
    });
    assert.ok([403, 410].includes(removed.status), 'membership removal while challenged blocks completion');
    assert.ok(!removed.cookies.some((cookie) => cookie.startsWith('tickmark_session=') && !cookie.startsWith('tickmark_session=;')));
  }, { now: () => clock });
});


test('the core sign-in path and the gateway sign-in are the same door', async () => {
  await withSaas(async ({ agent, base, registry }) => {
    const client = agent();
    await signup(client);
    const row = tenantRow(registry);
    setTenantBilling(registry, row.id, { status: 'active' });
    registry.prepare('INSERT INTO tenant_host (host, tenant_id) VALUES (?, ?)').run('acme.example', row.id);

    // The header links to `/signin`, and every core redirect lands there. In SaaS mode that has to
    // be the gateway's sign-in rather than the core's, or a practice ends up with a session the
    // workspace pages do not accept — which looks to them exactly like being signed out.
    const alias = await askWithHost(base, '/signin', 'acme.example');
    assert.equal(alias.status, 303, 'the core path redirects rather than showing a second form');
    assert.equal(alias.location, '/login');

    const signedIn = await askWithHost(base, '/signin', 'acme.example', {
      method: 'POST',
      form: { email: 'sam@acme.example', password: PASSWORD },
    });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.location, '/requests', 'and signing in there lands in the workspace');
    assert.ok(
      signedIn.cookies.some((cookie) => cookie.startsWith('tickmark_session=')),
      'with the core session the rest of the product expects',
    );

    // The session it handed back is the one the workspace accepts — carried by hand, because a
    // raw request has no cookie jar.
    const jar = signedIn.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const workspace = await new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}/requests`,
        { headers: { host: 'acme.example', cookie: jar } },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(workspace.status, 200, 'which the workspace accepts');
    assert.match(workspace.body, /Requests/, 'and it is the practice\u2019s own board');
  });
});

test('hosted login throttles failures before scrypt, expires them, and allows the legitimate account back in', async () => {
  let now = 1_000_000;
  const loginLimiter = createAttemptLimiter({ limit: 2, windowMs: 60_000, now: () => now });
  const sourceLoginLimiter = createAttemptLimiter({ limit: 20, windowMs: 60_000, now: () => now });
  const events = [];
  await withSaas(async ({ base }) => {
    const client = agent(base);
    await signup(client);
    const host = new URL(base).host;
    const attempt = (password) => askWithHost(base, '/login', host, {
      method: 'POST', form: { email: 'sam@acme.example', password },
    });

    const wrongOne = await attempt('wrong password');
    const wrongTwo = await attempt('wrong password');
    assert.equal(wrongOne.status, 401);
    assert.equal(wrongTwo.status, 401);
    assert.match(wrongOne.body, /do not match an account/);
    assert.match(wrongTwo.body, /do not match an account/);

    const held = await attempt(PASSWORD);
    assert.equal(held.status, 429, 'even the right password waits until the bounded window expires');
    assert.match(held.body, /Too many sign-in attempts/);

    now += 60_001;
    const recovered = await attempt(PASSWORD);
    assert.equal(recovered.status, 303, 'expiry restores sign-in without operator intervention');
    assert.ok(recovered.cookies.some((cookie) => cookie.startsWith('tickmark_session=')));
  }, { loginLimiter, sourceLoginLimiter, log: (level, event, fields) => events.push({ level, event, fields }) });

  const logText = JSON.stringify(events);
  assert.ok(!logText.includes('wrong password'));
  assert.ok(!logText.includes(PASSWORD));
});

test('the source bucket catches changing email addresses without disclosing account existence', async () => {
  const loginLimiter = createAttemptLimiter({ limit: 20 });
  const sourceLoginLimiter = createAttemptLimiter({ limit: 2 });
  await withSaas(async ({ base, registry }) => {
    await signup(agent(base));
    const { createAccount } = await import('../src/tenancy/registry.js');
    await createAccount(registry, { email: 'lee@example.test', password: PASSWORD });
    const host = new URL(base).host;
    const fail = (email) => askWithHost(base, '/login', host, {
      method: 'POST', form: { email, password: 'wrong password' },
    });

    assert.equal((await fail('sam@acme.example')).status, 401);
    assert.equal((await fail('lee@example.test')).status, 401);
    const rotated = await fail('unknown@example.test');
    assert.equal(rotated.status, 429, 'rotating identifiers does not reset the source budget');
    assert.match(rotated.body, /Too many sign-in attempts/);
  }, { loginLimiter, sourceLoginLimiter });
});

test('the account bucket spans trusted proxy source addresses', async () => {
  const loginLimiter = createAttemptLimiter({ limit: 2 });
  const sourceLoginLimiter = createAttemptLimiter({ limit: 20 });
  await withSaas(async ({ base }) => {
    const client = agent(base);
    await signup(client);
    const host = new URL(base).host;
    const failFrom = (address) => askWithHost(base, '/login', host, {
      method: 'POST',
      form: { email: 'sam@acme.example', password: 'wrong password' },
      headers: { 'x-forwarded-for': address },
    });

    assert.equal((await failFrom('198.51.100.1')).status, 401);
    assert.equal((await failFrom('198.51.100.2')).status, 401);
    const distributed = await failFrom('198.51.100.3');
    assert.equal(distributed.status, 429, 'changing trusted client addresses does not reset the account budget');
  }, { loginLimiter, sourceLoginLimiter, env: { TICKMARK_TRUSTED_PROXIES: '127.0.0.1,::1' } });
});

test('hosted staff invitations create repeatable accounts, enforce tenant membership, and revoke access', async () => {
  const logged = [];
  await withSaas(async ({ base, registry, pool }) => {
    const platformHost = new URL(base).host;
    const ownerSignup = await agent(base).post('/signup', {
      practice_name: 'Acme Accounting', email: 'sam@acme.example', password: PASSWORD,
    });
    assert.equal(ownerSignup.status, 303);
    const ownerTenant = tenantRow(registry);
    setTenantBilling(registry, ownerTenant.id, { status: 'active' });
    registry.prepare('INSERT INTO tenant_host (host, tenant_id) VALUES (?, ?)').run('acme.example', ownerTenant.id);
    const ownerDb = pool.get(ownerTenant.id);
    const ownerPractice = ownerDb.prepare('SELECT id FROM practice').get().id;

    const ownerLogin = await askWithHost(base, '/signin', 'acme.example', {
      method: 'POST', form: { email: 'sam@acme.example', password: PASSWORD },
    });
    assert.equal(ownerLogin.location, '/requests');
    const ownerJar = ownerLogin.cookies.map((cookie) => cookie.split(';')[0]).join('; ');

    const escalation = await askWithHost(base, '/members/invite', 'acme.example', {
      method: 'POST', cookie: ownerJar,
      form: { email: 'attacker@acme.example', role: 'owner' },
    });
    assert.equal(escalation.status, 400, 'a submitted owner role cannot be granted through an invitation');

    const made = await askWithHost(base, '/members/invite', 'acme.example', {
      method: 'POST', cookie: ownerJar,
      form: { email: 'lee@acme.example', role: 'assistant' },
    });
    assert.equal(made.status, 201, made.body);
    const invitation = JSON.parse(made.body);
    assert.ok(invitation.token);
    assert.equal(ownerDb.prepare('SELECT role FROM invite WHERE token_hash = ?').get(
      (await import('../src/crypto.js')).hashToken(invitation.token),
    ).role, 'assistant');

    const landing = await askWithHost(base, `/invite/${invitation.token}`, platformHost);
    assert.equal(landing.status, 200);
    assert.match(landing.body, /readonly/);
    assert.match(landing.body, /lee@acme\.example/);
    const accepted = await askWithHost(base, `/invite/${invitation.token}`, platformHost, {
      method: 'POST', form: { email: 'lee@acme.example', password: 'another long enough password' },
    });
    assert.equal(accepted.status, 303, accepted.body);
    assert.ok(accepted.cookies.some((cookie) => cookie.startsWith('tickmark_saas_session=') && !cookie.startsWith('tickmark_saas_session=;')));
    assert.ok(accepted.cookies.some((cookie) => cookie.startsWith('tickmark_session=') && !cookie.startsWith('tickmark_session=;')));

    const inviteHash = (await import('../src/crypto.js')).hashToken(invitation.token);
    assert.equal(registry.prepare('SELECT state FROM hosted_invite WHERE token_hash = ?').get(inviteHash).state, 'accepted');
    const localMember = ownerDb.prepare('SELECT id, role FROM practitioner WHERE email = ?').get('lee@acme.example');
    assert.equal(localMember.role, 'assistant');
    assert.equal(ownerDb.prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE practitioner_id = ?').get(localMember.id).n, 0);
    assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM tenant_member WHERE account_id = (SELECT id FROM account WHERE email = ?) AND tenant_id = ?')
      .get('lee@acme.example', ownerTenant.id).n, 1);

    const memberJar = accepted.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const signedOut = await askWithHost(base, '/logout', 'acme.example', { method: 'POST', cookie: memberJar });
    assert.equal(signedOut.status, 303);
    const repeatLogin = await askWithHost(base, '/signin', 'acme.example', {
      method: 'POST', form: { email: 'lee@acme.example', password: 'another long enough password' },
    });
    assert.equal(repeatLogin.location, '/requests', 'an accepted invite is now a durable hosted login');
    const repeatJar = repeatLogin.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const memberPage = await askWithHost(base, '/members', 'acme.example', { cookie: repeatJar });
    assert.equal(memberPage.status, 403, 'assistant role stays enforced after sign-in');

    const removed = await askWithHost(base, `/members/${localMember.id}/remove`, 'acme.example', {
      method: 'POST', cookie: ownerJar,
    });
    assert.equal(removed.status, 303);
    assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM tenant_member WHERE account_id = (SELECT id FROM account WHERE email = ?) AND tenant_id = ?')
      .get('lee@acme.example', ownerTenant.id).n, 0);
    const stale = await askWithHost(base, '/requests', 'acme.example', { cookie: repeatJar });
    assert.equal(stale.status, 303, 'the old tenant session is rejected on its next request');
    const denied = await askWithHost(base, '/signin', 'acme.example', {
      method: 'POST', form: { email: 'lee@acme.example', password: 'another long enough password' },
    });
    assert.equal(denied.status, 401, 'removed membership cannot be bridged back into the practice');

    // A valid account invited to another practice uses its existing password and gains only that
    // second membership. This checks registry account reuse without weakening tenant scoping.
    const secondSignup = await agent(base).post('/signup', {
      practice_name: 'Second Practice', email: 'owner@second.example', password: PASSWORD,
    });
    assert.equal(secondSignup.status, 303);
    const secondTenant = registry.prepare("SELECT id, slug FROM tenant WHERE slug = 'second-practice'").get();
    setTenantBilling(registry, secondTenant.id, { status: 'active' });
    registry.prepare('INSERT INTO tenant_host (host, tenant_id) VALUES (?, ?)').run('second.example', secondTenant.id);
    const secondDb = pool.get(secondTenant.id);
    const secondOwner = await askWithHost(base, '/signin', 'second.example', {
      method: 'POST', form: { email: 'owner@second.example', password: PASSWORD },
    });
    const secondOwnerJar = secondOwner.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const existingInvite = await askWithHost(base, '/members/invite', 'second.example', {
      method: 'POST', cookie: secondOwnerJar, form: { email: 'lee@acme.example', role: 'assistant' },
    });
    assert.equal(existingInvite.status, 201, existingInvite.body);
    const existingToken = JSON.parse(existingInvite.body).token;
    const wrongPassword = await askWithHost(base, `/invite/${existingToken}`, platformHost, {
      method: 'POST', form: { email: 'lee@acme.example', password: 'wrong password that is long enough' },
    });
    assert.equal(wrongPassword.status, 200);
    assert.match(wrongPassword.body, /current password/);
    const existingAccepted = await askWithHost(base, `/invite/${existingToken}`, platformHost, {
      method: 'POST', form: { email: 'lee@acme.example', password: 'another long enough password' },
    });
    assert.equal(existingAccepted.status, 303, existingAccepted.body);
    const leeAccount = registry.prepare('SELECT id FROM account WHERE email = ?').get('lee@acme.example');
    assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM tenant_member WHERE account_id = ?').get(leeAccount.id).n, 1,
      'membership in the first tenant remains revoked while acceptance joins the second');
    assert.ok(secondDb.prepare('SELECT id FROM practitioner WHERE email = ?').get('lee@acme.example'));
    assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM tenant_member WHERE account_id = ? AND tenant_id = ?')
      .get(leeAccount.id, secondTenant.id).n, 1);
    assert.equal(ownerPractice, ownerDb.prepare('SELECT id FROM practice').get().id);

    const revokeMade = await askWithHost(base, '/members/invite', 'acme.example', {
      method: 'POST', cookie: ownerJar, form: { email: 'revoked@acme.example', role: 'assistant' },
    });
    assert.equal(revokeMade.status, 201);
    const revokedToken = JSON.parse(revokeMade.body).token;
    const revokedHash = (await import('../src/crypto.js')).hashToken(revokedToken);
    const localInvite = ownerDb.prepare('SELECT id FROM invite WHERE token_hash = ?').get(revokedHash);
    const revoked = await askWithHost(base, `/members/invite/${localInvite.id}/revoke`, 'acme.example', {
      method: 'POST', cookie: ownerJar,
    });
    assert.equal(revoked.status, 303);
    assert.equal(registry.prepare('SELECT state FROM hosted_invite WHERE token_hash = ?').get(revokedHash).state, 'revoked');
    const revokedPage = await askWithHost(base, `/invite/${revokedToken}`, platformHost);
    assert.equal(revokedPage.status, 410, 'the retained public token index resolves the revoked invitation state');
    assert.match(revokedPage.body, /taken back by the practice/);

    const expiredMade = await askWithHost(base, '/members/invite', 'acme.example', {
      method: 'POST', cookie: ownerJar, form: { email: 'expired@acme.example', role: 'assistant' },
    });
    assert.equal(expiredMade.status, 201);
    const expiredToken = JSON.parse(expiredMade.body).token;
    const expiredHash = (await import('../src/crypto.js')).hashToken(expiredToken);
    ownerDb.prepare('UPDATE invite SET expires_at = ? WHERE token_hash = ?').run('2000-01-01T00:00:00.000Z', expiredHash);
    registry.prepare('UPDATE hosted_invite SET expires_at = ? WHERE token_hash = ?').run('2000-01-01T00:00:00.000Z', expiredHash);
    const expiredPage = await askWithHost(base, `/invite/${expiredToken}`, 'acme.example');
    assert.equal(expiredPage.status, 410, 'an expired hosted invite cannot be accepted');
    const logText = JSON.stringify(logged);
    assert.ok(!logText.includes(invitation.token), 'bearer invitation tokens are redacted from request logs');
    assert.ok(!logText.includes(existingToken), 'existing-account invite tokens are redacted too');
    assert.ok(!logText.includes(revokedToken) && !logText.includes(expiredToken), 'revoked and expired bearer tokens are redacted too');
    assert.ok(!logText.includes('another long enough password'), 'passwords are not recorded in request logs');
    assert.match(logText, /\/invite\/\[redacted\]/);
  }, { log: (...entry) => logged.push(entry) });
});

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
import { agent } from './helpers.js';

const PASSWORD = 'a long enough password';
const WEBHOOK_SECRET = 'whsec_test_secret';

/** The server the way `MULTI_TENANT=1` starts it, on a port nobody chose. */
async function withSaas(run, { env = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-gateway-'));
  let saas = null;
  try {
    saas = createSaasServer({
      registryFile: join(directory, 'saas.db'),
      tenantsRoot: join(directory, 'tenants'),
      env,
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
function askWithHost(base, path, host, { method = 'GET', form = null } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (body !== null) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = httpRequest(`${base}${path}`, { method, headers }, (response) => {
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

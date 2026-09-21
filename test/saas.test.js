/**
 * The multi-tenant server, driven the way a practice and its clients drive it.
 *
 * These are the acceptance tests `docs/saas.md` §2.6 names, in order: the seam (§2.4), the pool
 * and registry (§2.3), and the link index (§2.6 step 3). The single-tenant server's behaviour is
 * the rest of the suite — `MULTI_TENANT` unset means this file's resolver is simply never handed
 * to `createApp`, and nothing below is in its way.
 *
 * A browser is per-host on purpose: the practice's identity is its address, and a client with two
 * tabs open holds two sessions. The plain `agent` in `helpers.js` cannot send a Host header (the
 * fetch spec forbids it), so this file carries a small client built on `node:http`, which can.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { createApp } from '../src/app.js';
import {
  countTenants,
  createAccount,
  createTenant,
  mapHost,
  openRegistry,
  recordLink,
  tenantForLink,
  tenantForPractice,
} from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';
import { createResolver } from '../src/tenancy/resolve.js';
import { PLANS } from '../src/tenancy/registry.js';

const PASSWORD = 'a long enough password';

/** A browser that always says which practice it is asking for. */
function browserFor(base, host) {
  let cookie = '';
  const send = (method, path, { body = null, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}${path}`,
        {
          method,
          headers: {
            host,
            ...(cookie ? { cookie } : {}),
            ...headers,
            ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const set = response.headers['set-cookie'];
            if (set?.length) cookie = set.map((value) => value.split(';')[0]).join('; ');
            resolve({
              status: response.statusCode,
              location: response.headers.location,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      // A request that is never answered is a bug in the server, and a test that waits for it
      // forever is a suite nobody can debug. Name the request and give up fast.
      req.setTimeout(10_000, () => {
        req.destroy(new Error(`no answer within 10s: ${method} ${path} (host ${host})`));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  return {
    get: (path) => send('GET', path),
    post: (path, fields = {}) =>
      send('POST', path, {
        body: new URLSearchParams(fields).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
  };
}

/**
 * Two practices, two files, one process, one resolver — everything the entry point assembles,
 * without the port.
 *
 * The cleanup is deliberately forgiving: on Windows a file handle that lags the close by a few
 * milliseconds turns `rmSync` into EPERM, and a cleanup error must never mask the test's own
 * result. The tests run in a throwaway directory either way.
 */
async function withTwoTenants(run) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-saas-'));
  const registry = openRegistry(join(directory, 'saas.db'));
  const pool = createPool({ root: join(directory, 'tenants') });
  let server = null;

  try {
    const provision = async ({ name, host, email }) => {
      const accountId = await createAccount(registry, { email, password: PASSWORD });
      const tenant = createTenant(registry, pool, { ownerAccountId: accountId, name, email });
      mapHost(registry, { tenantId: tenant.id, host });
      return { ...tenant, host, email };
    };
    const acme = await provision({ name: 'Acme Accounting', host: 'acme.example', email: 'sam@acme.example' });
    const beach = await provision({ name: 'Beach and Co', host: 'beach.example', email: 'kim@beach.example' });

    const resolveTenant = createResolver({ registry, pool });
    server = createApp(registry, {
      resolveTenant,
      healthCheck: () => countTenants(registry),
      onLinkIssued: ({ practiceId, token }) => {
        const tenant = tenantForPractice(registry, practiceId);
        if (tenant) recordLink(registry, { tenantId: tenant.id, token });
      },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    await run({ base, registry, pool, acme, beach });
  } finally {
    try {
      server?.closeAllConnections?.();
      if (server) await new Promise((resolve) => server.close(resolve));
    } catch {
      // The test's own error outranks a messy close.
    }
    try {
      pool.closeAll();
    } catch {
      // As above.
    }
    try {
      registry.close();
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

/** Sign in on a host, then make one client and one request, and return what the tests need. */
async function seedPractice(base, tenant, { title }) {
  const browser = browserFor(base, tenant.host);
  const signedIn = await browser.post('/signin', { email: tenant.email, password: PASSWORD });
  assert.equal(signedIn.status, 303, `signing in on ${tenant.host} must work`);

  const created = await browser.post('/requests', {
    client: 'Northwind Ltd',
    client_email: 'accounts@northwind.example',
    title,
    items: 'Bank statements\nSigned engagement letter',
  });
  assert.equal(created.status, 303, 'and the practice can ask for documents');
  const requestId = created.location.split('/').pop();
  return { browser, requestId };
}

test('two practices, two files: each host sees only its own data', async () => {
  await withTwoTenants(async ({ base, pool, acme, beach }) => {
    const acmePractice = await seedPractice(base, acme, { title: 'Acme 2025 return' });
    const beachPractice = await seedPractice(base, beach, { title: 'Beach 2025 return' });

    const acmePage = (await acmePractice.browser.get('/requests')).text;
    assert.match(acmePage, /Acme 2025 return/, 'acme sees its own request');
    assert.ok(!acmePage.includes('Beach 2025 return'), 'and not the other practice\u2019s');

    const beachPage = (await beachPractice.browser.get('/requests')).text;
    assert.match(beachPage, /Beach 2025 return/, 'beach sees its own request');
    assert.ok(!beachPage.includes('Acme 2025 return'), 'and not the other practice\u2019s');

    // Asking for the other practice's request by id is a miss, not a leak — the id does not
    // exist in this file at all.
    const acmeIdOnBeach = await beachPractice.browser.get(`/requests/${acmePractice.requestId}`);
    assert.equal(acmeIdOnBeach.status, 404, 'the other practice\u2019s request is not found, not shown');

    // Two files, two handles, opened on first touch.
    assert.equal(pool.stats().open, 2, 'one handle per practice');
  });
});

test('a host with no practice is refused before any tenant file is opened', async () => {
  await withTwoTenants(async ({ base, registry, pool }) => {
    // Provisioning left two handles open; the wrong address must not open a third.
    const before = pool.stats().open;
    const browser = browserFor(base, 'mystery.example');
    const page = await browser.get('/requests');
    assert.equal(page.status, 404);
    assert.match(page.text, /There is no practice at that address\./);
    assert.equal(pool.stats().open, before, 'nothing was opened to answer a wrong address');
    assert.equal(countTenants(registry), 2, 'and the registry was not changed by the attempt');
  });
});

test('a client link finds its practice with no host hint, and a revoked one finds nothing', async () => {
  await withTwoTenants(async ({ base, registry, acme }) => {
    const practice = await seedPractice(base, acme, { title: 'Acme 2025 return' });

    // A key first: the link page refuses without one, because a link that cannot receive an
    // encrypted file is a promise the product cannot keep.
    await practice.browser.get('/setup');
    const { generatePracticeKey } = await import('../web/tickmark-crypto.js');
    const { publicKey, wrappedPrivateKey } = await generatePracticeKey(PASSWORD);
    await practice.browser.post('/setup', {
      public_key: JSON.stringify(publicKey),
      wrapped_private_key: wrappedPrivateKey,
    });

    const linked = await practice.browser.post(`/requests/${practice.requestId}/link`, { days: '30' });
    assert.equal(linked.status, 200);
    const token = /\/r\/([A-Za-z0-9_-]+)/.exec(linked.text)?.[1];
    assert.ok(token, 'the link page shows the token once');

    // The link is on its way to a client whose browser has never heard of acme.example: the
    // token alone must find the file.
    const anonymous = browserFor(base, '127.0.0.1');
    const clientPage = await anonymous.get(`/r/${token}`);
    assert.equal(clientPage.status, 200, 'the client page opens with no host hint');
    assert.match(clientPage.text, /Acme 2025 return/, 'and it is the right practice\u2019s page');
    assert.ok(tenantForLink(registry, token), 'the registry indexed the token');

    // A token that was never issued by anyone, anywhere, is an unknown address — not a practice.
    const stranger = await anonymous.get('/r/not-a-token-issued-by-anyone');
    assert.equal(stranger.status, 404);
    assert.match(stranger.text, /There is no practice at that address\./);
  });
});

test('the slug path answers without a wildcard host', async () => {
  await withTwoTenants(async ({ base, acme }) => {
    const practice = await seedPractice(base, acme, { title: 'Acme 2025 return' });

    // Development and preview: no wildcard DNS, so the tenant comes from the path instead.
    const dev = browserFor(base, 'localhost');
    const created = await dev.post(`/t/${acme.slug}/signin`, { email: acme.email, password: PASSWORD });
    assert.equal(created.status, 303, 'the prefix is stripped before routing');

    const page = await dev.get(`/t/${acme.slug}/requests`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Acme 2025 return/);
  });
});

test('a plan injects its limits, and an unknown plan never reads as unlimited', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-plans-'));
  let registry = null;
  let pool = null;
  try {
    registry = openRegistry(join(directory, 'saas.db'));
    pool = createPool({ root: join(directory, 'tenants') });
    const accountId = await createAccount(registry, { email: 'sam@acme.example', password: PASSWORD });
    const free = createTenant(registry, pool, { ownerAccountId: accountId, name: 'Free Practice', plan: 'free' });
    const odd = createTenant(registry, pool, { ownerAccountId: accountId, name: 'Odd Practice', plan: 'enterprise-9000' });

    const resolveTenant = createResolver({ registry, pool });

    const got = resolveTenant({ headers: {} }, new URL(`/t/${free.slug}/requests`, 'http://localhost'));
    assert.equal(got.chaseBudgetMs, PLANS.free.chaseBudgetMs, 'the free plan\u2019s chase budget travels to the handler');
    assert.equal(got.maxUploadBytes, PLANS.free.maxUploadBytes, 'and its upload ceiling does too');

    const oddPlan = resolveTenant({ headers: {} }, new URL(`/t/${odd.slug}/requests`, 'http://localhost'));
    assert.equal(
      oddPlan.maxUploadBytes,
      PLANS.standard.maxUploadBytes,
      'a plan the registry does not know reads as standard, never as unlimited',
    );
  } finally {
    try {
      pool.closeAll();
      registry.close();
    } catch {
      // Cleanup never outranks the test's own result.
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});



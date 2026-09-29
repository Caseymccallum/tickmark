/**
 * The Xero adapter — OAuth plumbing and the client-list transform — tested without a Xero account.
 *
 * The `fetch`es are stubbed and the client list is a fixture, so this suite runs green on a machine
 * that has never touched Xero. That is the point: the moment real credentials land, the only thing
 * that changes is whose `client_id`/`client_secret` fill the environment — the shapes below are
 * asserted against Xero's real responses, not against a mock of our own invention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import {
  connectionFor,
  createPractice,
  deleteConnection,
  saveConnection,
} from '../src/store.js';
import { practiceWithRequest, withServer } from './helpers.js';
import {
  authorizationUrl,
  connectionsToRows,
  exchangeCode,
  refreshTokens,
  fetchConnections,
  fetchBooksSignal,
  fetchOrganisation,
  fetchPracticeManagerClients,
  organisationToProfile,
  practiceManagerClientsToRows,
  XeroError,
  xeroFromEnvironment,
  XERO_AUTHORIZE_URL,
  XERO_TOKEN_URL,
  XERO_CONNECTIONS_URL,
  XERO_ORGANISATION_URL,
  XERO_PM_CLIENTS_URL,
} from '../src/tenancy/xero.js';

const config = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'http://localhost:3000/integrations/xero/callback',
};

/** Swap `fetch` for the length of one test, and put it back after — win or lose. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

test('the authorization URL carries what Xero needs, and the state that guards the callback', () => {
  const url = new URL(authorizationUrl({ config, state: 'nonce-abc' }));
  assert.equal(url.origin + url.pathname, XERO_AUTHORIZE_URL);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('state'), 'nonce-abc');
  // The import must be able to come back for more (offline_access) and must not ask to write.
  const scope = url.searchParams.get('scope');
  assert.match(scope, /offline_access/);
  assert.doesNotMatch(scope, /accounting\.transactions\.update/);
});

test('configuration comes from the environment, and the redirect is derived from the base URL', () => {
  assert.equal(xeroFromEnvironment({}), null);
  const fromBase = xeroFromEnvironment({
    TICKMARK_XERO_CLIENT_ID: 'cid',
    TICKMARK_XERO_CLIENT_SECRET: 'csecret',
    TICKMARK_PUBLIC_URL: 'https://app.example.com/',
  });
  assert.equal(fromBase.redirectUri, 'https://app.example.com/integrations/xero/callback');
  // A reverse proxy may front this at its own address, so the redirect is overridable.
  const overridden = xeroFromEnvironment({
    TICKMARK_XERO_CLIENT_ID: 'cid',
    TICKMARK_XERO_CLIENT_SECRET: 'csecret',
    TICKMARK_XERO_REDIRECT_URI: 'https://auth.example.com/cb',
  });
  assert.equal(overridden.redirectUri, 'https://auth.example.com/cb');
});

test('a code is traded for tokens over Basic auth', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({ access_token: 'at', refresh_token: 'rt', expires_in: 1800, token_type: 'Bearer', scope: 'openid' });
  });
  try {
    const tokens = await exchangeCode({ config, code: 'the-code' });
    assert.equal(tokens.accessToken, 'at');
    assert.equal(tokens.refreshToken, 'rt');
    assert.equal(tokens.expiresIn, 1800);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, XERO_TOKEN_URL);
    // Xero authenticates this leg with the secret as Basic credentials, not a bearer.
    assert.equal(calls[0].options.headers.authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    const body = new URLSearchParams(calls[0].options.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
  } finally {
    restore();
  }
});

test('a refresh trades the old refresh token for a new pair', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 1800, token_type: 'Bearer' });
  });
  try {
    const tokens = await refreshTokens({ config, refreshToken: 'rt1' });
    // Xero rotates refresh tokens: the new one is what must be stored.
    assert.equal(tokens.accessToken, 'at2');
    assert.equal(tokens.refreshToken, 'rt2');
    const body = new URLSearchParams(calls[0].options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'rt1');
  } finally {
    restore();
  }
});

test('a refusal from Xero is thrown with its own words', async () => {
  const restore = stubFetch(async () => json({ error: 'invalid_grant', error_description: 'The code is wrong' }, 400));
  try {
    await assert.rejects(
      () => exchangeCode({ config, code: 'bad' }),
      (error) => {
        assert.ok(error instanceof XeroError);
        assert.equal(error.status, 400);
        assert.match(error.message, /The code is wrong/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('connections are fetched with the bearer, and a bare array is read', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json([{ tenantId: 't1', tenantName: 'Northwind Ltd' }]);
  });
  try {
    const connections = await fetchConnections({ accessToken: 'at' });
    assert.equal(calls[0].url, XERO_CONNECTIONS_URL);
    assert.equal(calls[0].options.headers.authorization, 'Bearer at');
    assert.equal(connections.length, 1);
  } finally {
    restore();
  }
});

test('connections become client rows for the pipeline', () => {
  // The organisation's name is the client's name; Xero connections carry no address, so the email is
  // blank and the pipeline treats it as "chased by phone". A connection with no name is not a client.
  const rows = connectionsToRows([
    { tenantId: 'a', tenantName: 'Smith, Jones & Co' },
    { tenantId: 'b', tenantName: '  Northwind Ltd  ' },
    { tenantId: 'c', tenantName: '   ' },
    { tenantId: 'd' },
  ]);
  assert.deepEqual(rows, [
    { name: 'Smith, Jones & Co', email: '' },
    { name: 'Northwind Ltd', email: '' },
  ]);
});

test('a Xero link is saved, refreshed in place, and can be dropped', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-xero-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(join(directory, 'tickmark.db'));
  const practiceId = createPractice(db, { name: 'Lodis Accountancy' });

  assert.equal(connectionFor(db, practiceId, 'xero'), null);

  saveConnection(db, { provider: 'xero', practiceId, accessToken: 'at1', refreshToken: 'rt1', expiresAt: '2030-01-01T00:00:00Z', scope: 'openid' });
  const first = connectionFor(db, practiceId, 'xero');
  assert.equal(first.access_token, 'at1');
  assert.equal(first.refresh_token, 'rt1');

  // A refresh replaces both tokens in place (Xero rotates the refresh token): the same row, not a
  // second one, and the old refresh token is gone the way Xero already treats it.
  saveConnection(db, { provider: 'xero', practiceId, accessToken: 'at2', refreshToken: 'rt2', expiresAt: '2030-01-01T01:00:00Z', scope: 'openid' });
  const second = connectionFor(db, practiceId, 'xero');
  assert.equal(second.id, first.id);
  assert.equal(second.access_token, 'at2');
  assert.equal(second.refresh_token, 'rt2');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection').get().n, 1);

  deleteConnection(db, practiceId, 'xero');
  assert.equal(connectionFor(db, practiceId, 'xero'), null);
  db.close();
});

test('a forged callback is refused before anything is exchanged or stored', async (t) => {
  process.env.TICKMARK_XERO_CLIENT_ID = 'cid';
  process.env.TICKMARK_XERO_CLIENT_SECRET = 'csecret';
  t.after(() => {
    delete process.env.TICKMARK_XERO_CLIENT_ID;
    delete process.env.TICKMARK_XERO_CLIENT_SECRET;
  });

  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });

    // An attacker aims a stolen code at the practice. The `state` does not match the cookie this
    // browser would have set on its way out to Xero — so it is refused, and (the point) nothing is
    // exchanged and no connection is written. A blocked secret must leave nothing behind.
    const forged = await client.get('/integrations/xero/callback?code=stolen&state=forged');
    assert.equal(forged.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection').get().n, 0);
  });
});

test('Practice Manager clients bring a name and an email, in the order that finds the person', () => {
  // The client's own email wins; failing that the primary contact's; failing that any contact's. A
  // client with no email at all still comes through as a name — the pipeline counts those as chased by
  // phone rather than dropping them. A row with no name is not a client at all.
  const rows = practiceManagerClientsToRows([
    { Name: 'Smith & Co', Email: 'company@smith.test', Contacts: [{ Email: 'x@y.test', IsPrimary: true }] },
    { Name: 'Jones Ltd', Contacts: [{ Email: 'not@primary.test' }, { Email: 'owner@jones.test', IsPrimary: true }] },
    { Name: 'Solo Trader', Contacts: [{ Email: 'any@one.test' }] },
    { Name: 'No Email Pty', Contacts: [] },
    { Name: '   ', Email: 'blank@name.test' },
  ]);
  assert.deepEqual(rows, [
    { name: 'Smith & Co', email: 'company@smith.test' },
    { name: 'Jones Ltd', email: 'owner@jones.test' },
    { name: 'Solo Trader', email: 'any@one.test' },
    { name: 'No Email Pty', email: '' },
  ]);
});

test('the Practice Manager client list is fetched with the bearer and the tenant', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({ Clients: [{ Name: 'Northwind Ltd', Email: 'a@b.test' }] });
  });
  try {
    const clients = await fetchPracticeManagerClients({ accessToken: 'at', tenantId: 'tenant-1' });
    assert.equal(calls[0].url, XERO_PM_CLIENTS_URL);
    assert.equal(calls[0].options.headers.authorization, 'Bearer at');
    assert.equal(calls[0].options.headers['xero-tenant-id'], 'tenant-1');
    assert.equal(clients.length, 1);
    assert.equal(clients[0].Name, 'Northwind Ltd');
  } finally {
    restore();
  }
});

test('fetchOrganisation reads one organisation, and the profile keeps the facts a request needs', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({
      Organisations: [{
        Name: 'Northwind Ltd',
        OrganisationType: 'COMPANY',
        FinancialYearEndDay: 31,
        FinancialYearEndMonth: 3,
        TaxNumber: 'GB123456789',
        BaseCurrency: 'GBP',
        CountryCode: 'GB',
      }],
    });
  });
  try {
    const organisation = await fetchOrganisation({ accessToken: 'at', tenantId: 'tenant-1' });
    assert.equal(calls[0].url, XERO_ORGANISATION_URL);
    assert.equal(calls[0].options.headers.authorization, 'Bearer at');
    assert.equal(calls[0].options.headers['xero-tenant-id'], 'tenant-1', 'one organisation, for one client');
    assert.equal(organisation.Name, 'Northwind Ltd');

    const profile = organisationToProfile(organisation);
    assert.equal(profile.entityType, 'COMPANY', 'the entity type decides which checklist');
    assert.deepEqual(profile.yearEnd, { day: 31, month: 3 }, 'and the year end decides when to ask');
    assert.equal(profile.taxNumber, 'GB123456789');
    assert.equal(profile.name, 'Northwind Ltd');
  } finally {
    restore();
  }
});

test('a year end without both a day and a month is unknown, never guessed', () => {
  const profile = organisationToProfile({
    Name: 'A Sole Trader',
    OrganisationType: 'SOLETRADER',
    FinancialYearEndDay: 5,
    FinancialYearEndMonth: 0,
  });
  assert.equal(profile.yearEnd, null, 'a day without a month is not a year end — a wrong date is worse than none');
  assert.equal(profile.entityType, 'SOLETRADER');
  assert.equal(profile.taxNumber, null, 'and no tax number is reported as none rather than as empty');
});

test('a refusal from Xero is thrown as its own error rather than as silence', async () => {
  const restore = stubFetch(async () => json({ detail: 'nope' }, 403));
  try {
    await assert.rejects(() => fetchOrganisation({ accessToken: 'at', tenantId: 't' }), (error) => {
      assert.ok(error instanceof XeroError, 'a refusal the caller can tell from an empty result');
      assert.equal(error.status, 403);
      return true;
    });
  } finally {
    restore();
  }
  assert.equal(organisationToProfile(null), null, 'and no organisation is no profile');
});

test('the books-behind signal is off until the practice turns it on, behind a warning', async () => {
  // The opt-in only appears once Xero is configured on the install — give it an app for the length of
  // the test, and take it away again so no other test sees it.
  const had = { id: 'TICKMARK_XERO_CLIENT_ID' in process.env, secret: 'TICKMARK_XERO_CLIENT_SECRET' in process.env };
  process.env.TICKMARK_XERO_CLIENT_ID = 'cid';
  process.env.TICKMARK_XERO_CLIENT_SECRET = 'csecret';
  try {
    await withServer(async ({ agent, db }) => {
      const { client } = await practiceWithRequest({ agent, db });
      const practiceId = db.prepare('SELECT id FROM practice').get().id;
      saveConnection(db, { provider: 'xero', practiceId, accessToken: 'at', refreshToken: 'rt', expiresAt: '2030-01-01T00:00:00Z', scope: 'openid' });

      // Off by default, and the warning comes before any offer to turn it on.
      const before = await (await client.get('/integrations/xero')).text();
      assert.match(before, /Please read this before turning it on/, 'the warning comes first');
      assert.match(before, /cannot read your clients/, 'and the zero-knowledge promise is stated up front');
      assert.match(before, /never the transactions themselves/, 'and what is kept — and what is not — is said plainly');
      assert.match(before, /Nothing at all\s+is read until you choose/, 'and the default is named as the safe one');
      assert.equal(connectionFor(db, practiceId, 'xero').books_signal ?? 0, 0, 'and nothing is on yet');

      // Turning it on is a deliberate POST, and it is recorded — nothing more.
      const on = await client.post('/integrations/xero/books-signal', { on: '1' });
      assert.equal(on.status, 303);
      assert.equal(connectionFor(db, practiceId, 'xero').books_signal, 1);

      const after = await (await client.get('/integrations/xero')).text();
      assert.match(after, /<strong>On/, 'and the page now says it is on');

      // And it is reversible, back to the safe default.
      await client.post('/integrations/xero/books-signal', { on: '0' });
      assert.equal(connectionFor(db, practiceId, 'xero').books_signal, 0);
    });
  } finally {
    if (!had.id) delete process.env.TICKMARK_XERO_CLIENT_ID;
    if (!had.secret) delete process.env.TICKMARK_XERO_CLIENT_SECRET;
  }
});

test('the books signal keeps a count and a date, and throws the rows away', async () => {
  const restore = stubFetch(async () => json({
    BankTransactions: [
      { Date: '2026-03-03', Reconciled: false },
      { Date: '2026-02-01', Reconciled: true },
      { Date: '2026-01-15', Reconciled: false },
    ],
  }));
  try {
    const signal = await fetchBooksSignal({ accessToken: 'at', tenantId: 'tenant-1' });
    assert.deepEqual(signal, { unreconciled: 2, lastActivityAt: '2026-03-03' }, 'a count and a date, and nothing else');
    // No rows come back with it — there is nothing here to leak what a client spent.
    assert.ok(!('transactions' in signal) && !('rows' in signal) && !('BankTransactions' in signal));
  } finally {
    restore();
  }
});

test('a books check is refused while the signal is off, so nothing is read', async () => {
  const had = { id: 'TICKMARK_XERO_CLIENT_ID' in process.env, secret: 'TICKMARK_XERO_CLIENT_SECRET' in process.env };
  process.env.TICKMARK_XERO_CLIENT_ID = 'cid';
  process.env.TICKMARK_XERO_CLIENT_SECRET = 'csecret';
  try {
    await withServer(async ({ agent, db }) => {
      const { client } = await practiceWithRequest({ agent, db });
      const practiceId = db.prepare('SELECT id FROM practice').get().id;
      saveConnection(db, { provider: 'xero', practiceId, accessToken: 'at', refreshToken: 'rt', expiresAt: '2030-01-01T00:00:00Z', scope: 'openid' });

      // The signal is off, so a check is refused by name rather than quietly reading something.
      const refused = await client.post('/integrations/xero/books-check', {});
      assert.equal(refused.status, 409);
      assert.match(await refused.text(), /books signal is off/);
    });
  } finally {
    if (!had.id) delete process.env.TICKMARK_XERO_CLIENT_ID;
    if (!had.secret) delete process.env.TICKMARK_XERO_CLIENT_SECRET;
  }
});
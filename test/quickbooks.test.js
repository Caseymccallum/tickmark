/**
 * The QuickBooks adapter — OAuth plumbing and the client-list transform — tested without an Intuit
 * account.
 *
 * The `fetch`es are stubbed and the client list is a fixture, so this runs green on a machine that has
 * never touched QuickBooks. The shapes are asserted against Intuit's real Customer object
 * (`DisplayName`, `PrimaryEmailAddr.Address`) and its OAuth discovery document — not a mock of our own
 * invention — so the moment real credentials land, only the environment changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizationUrl,
  clientsToRows,
  exchangeCode,
  refreshTokens,
  companyInfoToProfile,
  fetchCompanyInfo,
  fetchQuickBooksClients,
  quickBooksFromEnvironment,
  QuickBooksError,
  QB_AUTHORIZE_URL,
  QB_TOKEN_URL,
  QB_QUERY_URL,
} from '../src/tenancy/quickbooks.js';
import { practiceWithRequest, withServer } from './helpers.js';

const config = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'http://localhost:3000/integrations/quickbooks/callback',
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

test('the authorization URL points at Intuit and carries the state', () => {
  const url = new URL(authorizationUrl({ config, state: 'nonce' }));
  assert.equal(url.origin + url.pathname, QB_AUTHORIZE_URL);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('state'), 'nonce');
  // Reads Customers (accounting scope) and asks to write nothing.
  assert.match(url.searchParams.get('scope'), /com\.intuit\.quickbooks\.accounting/);
});

test('configuration comes from the environment, and the redirect is derived from the base URL', () => {
  assert.equal(quickBooksFromEnvironment({}), null);
  const fromBase = quickBooksFromEnvironment({
    TICKMARK_QB_CLIENT_ID: 'cid',
    TICKMARK_QB_CLIENT_SECRET: 'csecret',
    TICKMARK_PUBLIC_URL: 'https://app.example.com/',
  });
  assert.equal(fromBase.redirectUri, 'https://app.example.com/integrations/quickbooks/callback');
});

test('a code is traded for tokens over Basic auth, and the refresh lifetime is kept', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: 'Bearer', scope: 'com.intuit.quickbooks.accounting' });
  });
  try {
    const tokens = await exchangeCode({ config, code: 'the-code' });
    assert.equal(tokens.accessToken, 'at');
    assert.equal(tokens.refreshToken, 'rt');
    assert.equal(tokens.expiresIn, 3600);
    assert.equal(tokens.refreshExpiresIn, 8640000);
    assert.equal(calls[0].url, QB_TOKEN_URL);
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
    return json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, x_refresh_token_expires_in: 8640000 });
  });
  try {
    const tokens = await refreshTokens({ config, refreshToken: 'rt1' });
    assert.equal(tokens.accessToken, 'at2');
    assert.equal(tokens.refreshToken, 'rt2');
    const body = new URLSearchParams(calls[0].options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'rt1');
  } finally {
    restore();
  }
});

test('a refusal from QuickBooks is thrown with its own words', async () => {
  const restore = stubFetch(async () => json({ error: 'invalid_grant', error_description: 'The code is wrong' }, 400));
  try {
    await assert.rejects(
      () => exchangeCode({ config, code: 'bad' }),
      (error) => {
        assert.ok(error instanceof QuickBooksError);
        assert.equal(error.status, 400);
        assert.match(error.message, /The code is wrong/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('the client list is queried against the realm, and the QueryResponse wrapper is read', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({ QueryResponse: { Customer: [{ DisplayName: 'Northwind Ltd' }] } });
  });
  try {
    const clients = await fetchQuickBooksClients({ accessToken: 'at', realmId: 'realm-1' });
    assert.equal(calls[0].url, `${QB_QUERY_URL}/realm-1/query?query=${encodeURIComponent('select * from Customer')}`);
    assert.equal(calls[0].options.headers.authorization, 'Bearer at');
    assert.equal(clients.length, 1);
  } finally {
    restore();
  }
});

test('customers become client rows with their name and their email', () => {
  // Name is `DisplayName` (falling back to `CompanyName`); email is `PrimaryEmailAddr.Address`. A
  // customer with no email still comes through as a name; one with no name is not a client at all.
  const rows = clientsToRows([
    { DisplayName: "Amy's Bird Sanctuary", PrimaryEmailAddr: { Address: 'amy@birdsnest.example' } },
    { CompanyName: 'Fallback Co', PrimaryEmailAddr: { Address: 'a@b.test' } },
    { DisplayName: 'No Email Pty' },
    { DisplayName: '   ', PrimaryEmailAddr: { Address: 'blank@name.test' } },
  ]);
  assert.deepEqual(rows, [
    { name: "Amy's Bird Sanctuary", email: 'amy@birdsnest.example' },
    { name: 'Fallback Co', email: 'a@b.test' },
    { name: 'No Email Pty', email: '' },
  ]);
});

test('a forged QuickBooks callback is refused before anything is exchanged or stored', async (t) => {
  process.env.TICKMARK_QB_CLIENT_ID = 'cid';
  process.env.TICKMARK_QB_CLIENT_SECRET = 'csecret';
  t.after(() => {
    delete process.env.TICKMARK_QB_CLIENT_ID;
    delete process.env.TICKMARK_QB_CLIENT_SECRET;
  });

  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const forged = await client.get('/integrations/quickbooks/callback?code=stolen&state=forged');
    assert.equal(forged.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection').get().n, 0);
  });
});

test('the filing profile is read from CompanyInfo, and the year end is honest', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({
      QueryResponse: {
        CompanyInfo: [{
          Name: 'Northwind Ltd',
          EntityType: 'LimitedLiabilityCompany',
          FiscalYearStartMonth: 'April',
          TaxIdentifier: 'GB123456789',
          Country: 'GB',
        }],
      },
    });
  });
  try {
    const companyInfo = await fetchCompanyInfo({ accessToken: 'at', realmId: 'realm-1' });
    assert.match(calls[0].url, /realm-1\/query/, 'scoped to the one company');
    assert.equal(calls[0].options.headers.authorization, 'Bearer at');

    const profile = companyInfoToProfile(companyInfo);
    assert.equal(profile.entityType, 'LimitedLiabilityCompany', 'the entity type decides which checklist');
    // A fiscal year that starts in April ends in March — but QuickBooks states no day, so none is
    // invented: the month is kept, the day is left null.
    assert.deepEqual(profile.yearEnd, { day: null, month: 3 });
    assert.equal(profile.taxNumber, 'GB123456789');
    assert.equal(profile.name, 'Northwind Ltd');
  } finally {
    restore();
  }
});

test('a January fiscal year wraps to a December end, and a missing one is unknown not guessed', () => {
  assert.deepEqual(companyInfoToProfile({ FiscalYearStartMonth: 'January' }).yearEnd, { day: null, month: 12 });
  assert.equal(companyInfoToProfile(null), null, 'no company is no profile');
  assert.equal(companyInfoToProfile({ Name: 'X' }).yearEnd, null, 'a fiscal start QuickBooks cannot name is no year end');
});
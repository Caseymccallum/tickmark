/**
 * The two integration pages and their action routes, which nothing exercised.
 *
 * These are the pages a practice sees when it decides whether to bring its client book across, and they have three
 * states that look identical if you only read the happy one: not configured, configured but not connected, connected.
 * The audit found `quickbooks-views.js` at 38% line coverage and 20% of its functions never called, which is what a
 * page that is only ever rendered in one of its states looks like.
 *
 * The interesting assertion in here is the negative one: a configuration state is not a server fault. These routes
 * answered `500`, which puts a page a stranger can reach into the operator's error rate, and told the reader nothing
 * they could act on. They now answer `409`, which is what this codebase already uses for "not connected".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PASSWORD, agent, practiceWithRequest, withServer } from './helpers.js';
import { booksSignalOn, connectionFor, saveConnection } from '../src/store.js';

const PROVIDERS = [
  {
    name: 'QuickBooks',
    key: 'quickbooks',
    base: '/integrations/quickbooks',
    idVar: 'TICKMARK_QB_CLIENT_ID',
    secretVar: 'TICKMARK_QB_CLIENT_SECRET',
    authorize: /^https:\/\/appcenter\.intuit\.com\/connect\/oauth2\?/,
    callback: '/integrations/quickbooks/callback?code=a-code&state=not-the-state&realmId=9130345',
  },
  {
    name: 'Xero',
    key: 'xero',
    base: '/integrations/xero',
    idVar: 'TICKMARK_XERO_CLIENT_ID',
    secretVar: 'TICKMARK_XERO_CLIENT_SECRET',
    authorize: /^https:\/\/login\.xero\.com\/identity\/connect\/authorize\?/,
    callback: '/integrations/xero/callback?code=a-code&state=not-the-state',
  },
];

/** Run `body` with the given environment, and always put back exactly what was there. */
async function withEnv(vars, body) {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const unset = (provider) => ({ [provider.idVar]: undefined, [provider.secretVar]: undefined });
const configured = (provider) => ({ [provider.idVar]: 'a-client-id', [provider.secretVar]: 'a-client-secret' });

/** The page as a reader sees it: tags gone, whitespace collapsed, so a phrase that wraps a line still matches. */
const flat = (rendered) => rendered.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

test('with no OAuth app configured, every action says so and none pretends to be a server fault', async () => {
  for (const provider of PROVIDERS) {
    await withEnv(unset(provider), () => withServer(async ({ db, agent }) => {
      const practice = await practiceWithRequest({ agent, db });

      const page = await practice.client.get(provider.base);
      assert.equal(page.status, 200, `${provider.name}: the page still renders`);
      const rendered = flat(await page.text());
      assert.ok(rendered.includes(`${provider.name} is not set up on this install`), `${provider.name}: says so`);
      assert.ok(rendered.includes(provider.idVar), 'and names the variable the operator has to set');
      assert.ok(rendered.includes(provider.secretVar));

      // A configuration state, not a fault: 409 rather than a 500 that inflates the error rate.
      const connect = await practice.client.get(`${provider.base}/connect`);
      assert.equal(connect.status, 409, `${provider.name}: connect is refused as a state, not as a fault`);

      const imported = await practice.client.post(`${provider.base}/import`, {});
      assert.equal(imported.status, 409, `${provider.name}: import is refused as a state, not as a fault`);
      assert.ok(
        flat(await imported.text()).includes('is not set up on this install'),
        `${provider.name}: and says which variable is missing`,
      );

      const signal = await practice.client.post(`${provider.base}/books-signal`, {});
      assert.equal(signal.status, 409, `${provider.name}: the books signal needs a connection first`);

      // Disconnecting when there is nothing connected is a no-op rather than an error.
      const disconnected = await practice.client.post(`${provider.base}/disconnect`, {});
      assert.equal(disconnected.status, 303, `${provider.name}: disconnecting nothing is harmless`);
      assert.equal(disconnected.headers.get('location'), provider.base);
    }));
  }
});

test('the integrations index names both providers and their state', async () => {
  await withEnv({ ...unset(PROVIDERS[0]), ...unset(PROVIDERS[1]) }, () => withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const rendered = flat(await (await practice.client.get('/integrations')).text());

    assert.ok(rendered.includes('Bring your client book across'));
    assert.ok(rendered.includes('Xero'));
    assert.ok(rendered.includes('QuickBooks'));
    assert.ok(rendered.includes('Not set up on this install'), 'both are shown as unconfigured');
    // The promise the page makes about what is read is the one that matters: names and addresses, never documents.
    assert.ok(rendered.includes('never their transactions'));
  }));
});

test('configured, the page offers to connect and the button leads to the provider', async () => {
  for (const provider of PROVIDERS) {
    await withEnv({ ...configured(provider), TICKMARK_PUBLIC_URL: 'https://tickmark.example.test' },
      () => withServer(async ({ db, agent }) => {
        const practice = await practiceWithRequest({ agent, db });

        const rendered = flat(await (await practice.client.get(provider.base)).text());
        assert.ok(rendered.includes(`Connect to ${provider.name}`), `${provider.name}: the button appears`);
        assert.ok(rendered.includes('read-only view'), 'and the page says what will be read');

        const connect = await practice.client.get(`${provider.base}/connect`);
        assert.equal(connect.status, 303);
        const location = connect.headers.get('location');
        assert.match(location, provider.authorize, `${provider.name}: sent to the provider, not somewhere else`);
        assert.match(location, /client_id=a-client-id/, 'with the configured app');
        assert.match(
          location,
          /redirect_uri=https%3A%2F%2Ftickmark\.example\.test%2F/,
          'and a redirect back to the address the operator declared, not one guessed from a Host header',
        );
        assert.match(location, /state=[A-Za-z0-9_-]{20,}/, 'with an unguessable state');

        // The state is parked in a cookie only this browser can read, which is what the callback checks.
        const cookies = connect.headers.getSetCookie();
        assert.ok(
          cookies.some((cookie) => cookie.includes('state=') && cookie.includes('HttpOnly')),
          `${provider.name}: the state is in an HttpOnly cookie`,
        );
      }));
  }
});

test('a connected practice can import its book, switch the signal on and off, and disconnect', async () => {
  for (const provider of PROVIDERS) {
    await withEnv({ ...configured(provider), TICKMARK_PUBLIC_URL: 'https://tickmark.example.test' },
      () => withServer(async ({ db, agent }) => {
        const practice = await practiceWithRequest({ agent, db });
        const practiceId = db.prepare('SELECT id FROM practice').get().id;
        // A connection row, written the way the callback writes one, with an expiry far enough out that no
        // refresh is attempted — so this test never reaches the provider's network at all.
        saveConnection(db, {
          provider: provider.key,
          practiceId,
          externalId: '9130345',
          accessToken: 'an-access-token',
          refreshToken: 'a-refresh-token',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          scope: 'a-read-only-scope',
          at: new Date().toISOString(),
        });

        // --- the page in its connected state ------------------------------------------------------
        const connected = flat(await (await practice.client.get(provider.base)).text());
        assert.ok(connected.includes(`Import from ${provider.name}`), `${provider.name}: offers an import`);
        assert.ok(connected.includes('Disconnect'), 'and a way out');
        assert.ok(connected.includes('Know whose books are behind'), 'and the optional signal, off by default');
        assert.ok(connected.includes('never the transactions themselves'), 'whose limit is stated plainly');
        assert.ok(connected.includes('Turn it on'), 'and which starts switched off');

        // --- the import, confirmed from the preview rather than fetched again ----------------------
        // The second half of the two-step import: the rows the preview showed are posted back. That is the
        // seam that makes this testable without talking to a provider.
        const imported = await practice.client.post(`${provider.base}/import`, {
          run: '1',
          rows: JSON.stringify([
            { name: 'Lodge & Co', email: 'accounts@lodge.example' },
            { name: 'Juniper Trading' },
            { name: '' },
          ]),
        });
        assert.equal(imported.status, 200);
        const summary = flat(await imported.text());
        assert.ok(summary.includes('Clients imported'), `${provider.name}: the book came across`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM client WHERE name = 'Lodge & Co'").get().n, 1);
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM client WHERE name = 'Juniper Trading'").get().n,
          1,
          'a customer with no email address is still a client — the address can come later',
        );
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM client WHERE name = ''").get().n,
          0,
          'and a row with no name is skipped rather than stored as a blank client',
        );

        // --- nothing to import ---------------------------------------------------------------------
        const nothing = await practice.client.post(`${provider.base}/import`, { run: '1', rows: '[]' });
        assert.equal(nothing.status, 200);
        assert.ok(flat(await nothing.text()).includes('Nothing to import'));
        const unparseable = await practice.client.post(`${provider.base}/import`, { run: '1', rows: 'not json' });
        assert.ok(flat(await unparseable.text()).includes('Nothing to import'), 'malformed rows are refused, not thrown');

        // --- the books-behind signal, which is off until somebody chooses it -----------------------
        const signalOn = () => booksSignalOn(connectionFor(db, practiceId, provider.key));
        assert.equal(signalOn(), false, `${provider.name}: off by default`);
        const on = await practice.client.post(`${provider.base}/books-signal`, { on: '1' });
        assert.equal(on.status, 303);
        assert.equal(signalOn(), true);
        const withSignal = flat(await (await practice.client.get(provider.base)).text());
        assert.ok(withSignal.includes('Turn it off'), 'and the page then offers to turn it off');

        const off = await practice.client.post(`${provider.base}/books-signal`, { on: '0' });
        assert.equal(off.status, 303);
        assert.equal(signalOn(), false);

        // --- disconnecting --------------------------------------------------------------------------
        const disconnected = await practice.client.post(`${provider.base}/disconnect`, {});
        assert.equal(disconnected.status, 303);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection').get().n, 0, `${provider.name}: the connection is gone`);
        // And the import refuses again, because there is nothing connected to import from.
        assert.equal((await practice.client.post(`${provider.base}/import`, { run: '1', rows: '[]' })).status, 409);
      }));
  }
});

test('configured but not connected: the import says which of the two states it is in', async () => {
  for (const provider of PROVIDERS) {
    await withEnv(configured(provider), () => withServer(async ({ db, agent }) => {
      const practice = await practiceWithRequest({ agent, db });
      const refused = await practice.client.post(`${provider.base}/import`, {});
      assert.equal(refused.status, 409);
      assert.ok(flat(await refused.text()).includes('has not connected'));
    }));
  }
});

test('a callback that cannot present the state cookie joins nothing', async () => {
  for (const provider of PROVIDERS) {
    await withEnv({ ...configured(provider), TICKMARK_PUBLIC_URL: 'https://tickmark.example.test' },
      () => withServer(async ({ base, db, agent }) => {
        await practiceWithRequest({ agent, db });

        // A fresh browser: signed in, but holding no state cookie — the shape of a forged or replayed callback.
        const stranger = agent(base);
        await stranger.post('/signin', { email: 'sam@practice.example', password: PASSWORD });
        const response = await stranger.get(provider.callback);

        assert.ok([303, 400, 403, 409].includes(response.status), `${provider.name}: refused (${response.status})`);
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM connection').get().n,
          0,
          `${provider.name}: nothing was stored — no tokens, no connection`,
        );
      }));
  }
});

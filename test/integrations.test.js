/**
 * The integrations home and the sync behaviour behind it.
 *
 * Three things are load-bearing and easy to lose in a refactor:
 *
 * - **It is in the nav.** A practice that wants to connect Xero or QuickBooks must not have to guess that
 *   the only way in is the "Import a CSV instead" button. A page nothing links to does not exist.
 * - **It says how bringing clients across works** — on demand and while you work, never on a timer, never a
 *   document or a transaction — because a practice expecting silent nightly sync will think the product is
 *   broken when a client added in Xero this morning is not here until the next look.
 * - **The quiet refresh is throttled.** A stale book is refreshed in the background; a fresh one is left
 *   alone, so a page load is never a licence to hammer a provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { practiceWithRequest, withServer } from './helpers.js';
import { connectionFor, saveConnection } from '../src/store.js';
import { maybeSyncOnActivity } from '../src/integrations-sync.js';

/**
 * Stub the provider's API for the length of one test — but only the provider. A sign-up link and an
 * ordinary page still go to the real `fetch`, or the test helper could not confirm an account underneath
 * the stub (which is what a blanket swap does).
 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    /xero\.com|intuit\.com|quickbooks/i.test(String(url)) ? handler(url, options) : original(url, options);
  return () => {
    globalThis.fetch = original;
  };
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** Point the Xero integration at a configured app for the length of a test. */
function withXeroConfig() {
  process.env.TICKMARK_XERO_CLIENT_ID = 'cid';
  process.env.TICKMARK_XERO_CLIENT_SECRET = 'csecret';
  return () => {
    delete process.env.TICKMARK_XERO_CLIENT_ID;
    delete process.env.TICKMARK_XERO_CLIENT_SECRET;
  };
}

/** A connection whose access token is still fresh, so no refresh is fetched mid-test. */
function connect(db, practiceId, provider = 'xero') {
  saveConnection(db, {
    provider,
    practiceId,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: '',
  });
}

test('integrations are reachable from the nav and say how bringing clients across works', async () => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const response = await client.get('/integrations');
    assert.equal(response.status, 200);
    const markup = await response.text();

    assert.match(markup, /<h1>Integrations<\/h1>/, 'the page is there');
    assert.match(markup, /<h2>Xero<\/h2>/, 'Xero is listed');
    assert.match(markup, /<h2>QuickBooks<\/h2>/, 'QuickBooks is listed');
    assert.match(markup, /href="\/integrations"/, 'the nav links to it from every page');
    assert.match(markup, /href="\/integrations\/xero"/, 'and it points at the Xero page');
    assert.match(markup, /href="\/integrations\/quickbooks"/, 'and at the QuickBooks page');

    // The honest line about *when* data is read — the sentence that stops "why is my client missing?".
    assert.match(markup, /names and email addresses/, 'it says what is read: the client list');
    assert.match(markup, /when you press Sync now/, 'and that it is on demand');
    assert.match(markup, /never their transactions/, 'and what it never reads');
    assert.match(markup, /only when you turn it\s+on/, 'and that the books signal is opt-in');
  });
});

test('the provider pages mark Integrations as the current section', async () => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    for (const path of ['/integrations/xero', '/integrations/quickbooks']) {
      const response = await client.get(path);
      assert.equal(response.status, 200);
      const markup = await response.text();
      assert.match(markup, /aria-current="page">Integrations</, `${path} highlights Integrations in the nav`);
    }
  });
});

test('Sync now brings the client book across and stamps when it last ran', async () => {
  const unconfig = withXeroConfig();
  const restore = stubFetch(async () => json([]));
  try {
    await withServer(async ({ agent, db }) => {
      const { client } = await practiceWithRequest({ agent, db });
      const practiceId = db.prepare('SELECT id FROM practice').get().id;
      connect(db, practiceId);
      assert.equal(connectionFor(db, practiceId, 'xero').last_synced_at ?? null, null, 'nothing synced yet');

      const res = await client.post('/integrations/sync', { provider: 'xero' });
      assert.equal(res.status, 303, 'it redirects back to the integrations page');
      assert.match(res.headers.get('location'), /synced=xero/, 'saying what it did');

      const after = connectionFor(db, practiceId, 'xero');
      assert.ok(after.last_synced_at, 'the connection records when clients were last brought across');
      const page = await (await client.get('/integrations')).text();
      assert.match(page, /Last brought across: <strong>just now/, 'and the page says how fresh it is');
    });
  } finally {
    restore();
    unconfig();
  }
});

test('the quiet refresh runs when the book is stale, and not again within the hour', async () => {
  const unconfig = withXeroConfig();
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return json([]);
  });
  try {
    await withServer(async ({ agent, db }) => {
      await practiceWithRequest({ agent, db });
      const practiceId = db.prepare('SELECT id FROM practice').get().id;
      connect(db, practiceId);

      // Never synced → a pass is launched, and it reads the client list exactly once.
      assert.equal(calls, 0);
      await Promise.all(maybeSyncOnActivity(db, practiceId, 'someone'));
      assert.equal(calls, 1, 'a stale book is refreshed in the background');
      assert.ok(connectionFor(db, practiceId, 'xero').last_synced_at, 'and stamped');

      // Fresh now → left alone until the hour is up.
      await Promise.all(maybeSyncOnActivity(db, practiceId, 'someone'));
      assert.equal(calls, 1, 'a fresh book is not re-fetched on every page load');
    });
  } finally {
    restore();
    unconfig();
  }
});
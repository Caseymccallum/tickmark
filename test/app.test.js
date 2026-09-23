/**
 * The application's tests: accounts, sessions, and a practice's own requests.
 *
 * These are written against the HTTP surface rather than against the handler functions,
 * because the things most likely to go wrong here are the things that live in the
 * boundary: a cookie that is not sent, a redirect that does not happen, a value that
 * reaches the page unescaped, a request that one practice can read and another cannot.
 * A test that calls a handler directly would pass while all of those were broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseItems } from '../src/app.js';
import { PASSWORD, signUp, withServer } from './helpers.js';

// The cookie jar and the server-starting helper live in `helpers.js`, shared with the
// link tests: two copies of a harness are two chances for it to be wrong in different
// ways, and then a red test is the harness's fault rather than the product's.

test('a practice can be created, and lands on its own dashboard', async () => {
  await withServer(async ({ agent }) => {
    const client = agent();
    const created = await signUp(client, 'sam@practice.example');

    assert.equal(created.status, 303, 'creating a practice redirects rather than rendering');
    assert.equal(created.headers.get('location'), '/requests');
    assert.match(client.cookie, /^tickmark_session=/, 'a session cookie is set');

    const dashboard = await client.get('/requests');
    assert.equal(dashboard.status, 200);
    const body = await dashboard.text();
    assert.match(body, /No requests yet/, 'a new practice has no requests');
    assert.match(body, /sam@practice\.example/, 'the page knows who is signed in');
  });
});

test('a password shorter than the floor is refused, and nothing is created', async () => {
  await withServer(async ({ agent, db }) => {
    const client = agent();
    const response = await signUp(client, 'short@practice.example', 'too short');

    assert.equal(response.status, 400);
    assert.match(await response.text(), /at least 12 characters/);
    assert.equal(client.cookie, '', 'no session was issued');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 0, 'and no account either');
  });
});

test('a wrong password and an unknown email are refused identically', async () => {
  await withServer(async ({ agent }) => {
    const client = agent();
    await signUp(client, 'sam@practice.example');
    const signedIn = agent();

    const wrongPassword = await signedIn.post('/signin', { email: 'sam@practice.example', password: 'not the password' });
    const unknownEmail = await signedIn.post('/signin', { email: 'nobody@practice.example', password: PASSWORD });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);

    // The *message* must be identical, which is the claim: the page may differ in what
    // the visitor typed (their email is echoed back into the form, which is helpful and
    // says nothing about who holds an account here).
    const message = (body) => /<p class="error">([^<]*)<\/p>/.exec(body)?.[1];
    const fromWrongPassword = message(await wrongPassword.text());
    const fromUnknownEmail = message(await unknownEmail.text());
    assert.ok(fromWrongPassword, 'the refusal is shown to the visitor');
    assert.equal(
      fromWrongPassword,
      fromUnknownEmail,
      'the two failures must read identically, or the page says which addresses have accounts',
    );
    assert.equal(signedIn.cookie, '', 'neither attempt produced a session');
  });
});

test('signing out actually revokes the session, which is why sessions are in the database', async () => {
  await withServer(async ({ agent, base, db }) => {
    const client = agent();
    await signUp(client, 'sam@practice.example');
    const stolen = client.cookie;
    assert.equal((await client.get('/requests')).status, 200, 'the cookie works before signing out');

    const out = await client.post('/signout', {});
    assert.equal(out.status, 303);

    // Present the old cookie by hand, as somebody holding a copy of it would. A signed
    // cookie could not have been un-signed, so this is the test that justifies the
    // session table existing at all.
    const replay = await fetch(`${base}/requests`, { headers: { cookie: stolen }, redirect: 'manual' });
    assert.equal(replay.status, 303, 'the old cookie no longer opens the dashboard');
    assert.equal(replay.headers.get('location'), '/signin');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get().n, 0, 'the session row is gone');
  });
});

test('the session cookie is HttpOnly, SameSite, and Secure by default', async () => {
  await withServer(async ({ agent }) => {
    const client = agent();
    const created = await signUp(client, 'sam@practice.example');
    const header = created.headers.getSetCookie().join('; ');
    assert.match(header, /HttpOnly/, 'script on the page must not be able to read the session');
    assert.match(header, /SameSite=Lax/, 'a cross-site form must not carry the session');
    assert.match(header, /Secure/, 'and it must not travel over plain HTTP');
    assert.match(header, /Path=\//);
  });
});

test('a signed-out visitor is sent to sign in rather than shown an error', async () => {
  await withServer(async ({ agent }) => {
    const response = await agent().get('/requests');
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/signin');
  });
});

test('one practice cannot see another practice\'s request, and cannot tell that it exists', async () => {
  await withServer(async ({ agent }) => {
    const mine = agent();
    await signUp(mine, 'mine@practice.example');
    const created = await mine.post('/requests', {
      client: 'Northwind Ltd',
      title: '2025 return',
      items: 'Bank statements\nSigned engagement letter',
    });
    const location = created.headers.get('location');
    assert.match(location, /^\/requests\/[0-9a-f-]{36}$/, 'creating a request lands on it');

    const theirs = agent();
    await signUp(theirs, 'theirs@practice.example');
    const peek = await theirs.get(location);
    assert.equal(peek.status, 404, 'a request belonging to another practice is not found');

    const nonsense = await theirs.get('/requests/00000000-0000-0000-0000-000000000000');
    assert.equal(nonsense.status, 404);
    assert.equal(
      await peek.text(),
      await nonsense.text(),
      'a foreign request and an imaginary one must be indistinguishable',
    );
  });
});

test('a client name that looks like markup is escaped, on every page that shows it', async () => {
  await withServer(async ({ agent }) => {
    const client = agent();
    await signUp(client, 'sam@practice.example');
    const nasty = '<script>alert(1)</script> & "quoted"';
    const created = await client.post('/requests', {
      client: nasty,
      title: '<b>2025</b>',
      items: 'Bank statements',
    });

    for (const page of [await client.get('/requests'), await client.get(created.headers.get('location'))]) {
      const body = await page.text();
      assert.ok(!body.includes('<script>alert(1)</script>'), 'the script tag must not be emitted as markup');
      assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'it must be visible as text instead');
      assert.ok(body.includes('&amp;'), 'an ampersand becomes an entity');
    }
  });
});

test('the items of a request are cleaned up: blanks dropped, duplicates collapsed, order kept', async () => {
  assert.deepEqual(parseItems('  Bank statements \n\n bank statements\nPhoto ID\n'), ['Bank statements', 'Photo ID']);
  assert.deepEqual(parseItems(''), []);
  assert.equal(parseItems(Array.from({ length: 80 }, (_, i) => `Item ${i}`).join('\n')).length, 50, 'capped');
  assert.equal(parseItems('x'.repeat(500))[0].length, 200, 'each label is capped');
});

test('a request is created with its client, its items, and a record of the fact', async () => {
  await withServer(async ({ agent, db }) => {
    const client = agent();
    await signUp(client, 'sam@practice.example');
    const created = await client.post('/requests', {
      client: 'Northwind Ltd',
      client_email: 'accounts@northwind.example',
      title: '2025 return',
      due: '2026-01-31',
      items: 'Bank statements\nSigned engagement letter\nBank statements',
    });

    const page = await client.get(created.headers.get('location'));
    const body = await page.text();
    assert.match(body, /Northwind Ltd/);
    assert.match(body, /Bank statements/);
    assert.match(body, /Signed engagement letter/);
    assert.match(body, /0 of 2 received/, 'the request starts entirely outstanding');
    assert.match(body, /request\.created/, 'the history records that it was created');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_item').get().n, 2, 'the duplicate was collapsed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client').get().n, 1);
  });
});

test('a request that breaks the rules is refused with the form still filled in', async () => {
  await withServer(async ({ agent, db }) => {
    const client = agent();
    await signUp(client, 'sam@practice.example');

    const noItems = await client.post('/requests', { client: 'Northwind Ltd', title: '2025 return', items: '   \n\n ' });
    assert.equal(noItems.status, 400);
    assert.match(await noItems.text(), /At least one document is required/);

    const noClient = await client.post('/requests', { client: '', title: '2025 return', items: 'Bank statements' });
    assert.equal(noClient.status, 400);
    assert.match(await noClient.text(), /A client is required/);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request').get().n, 0, 'nothing was created by a refusal');
  });
});

test('a body larger than the endpoint accepts is refused rather than read into memory', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${'x'.repeat(200 * 1024)}`,
    });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /larger than this endpoint accepts/);
  });
});

test('a practice can sign in again after signing out', async () => {
  await withServer(async ({ agent }) => {
    const first = agent();
    await signUp(first, 'sam@practice.example');
    await first.post('/signout', {});

    const second = agent();
    const response = await second.post('/signin', { email: 'SAM@practice.example', password: PASSWORD });
    assert.equal(response.status, 303, 'the email is matched case-insensitively');
    assert.equal((await second.get('/requests')).status, 200);
  });
});

test('the health check reports the number of practices, and which version is answering', async () => {
  await withServer(async ({ agent, base }) => {
    await signUp(agent(), 'sam@practice.example');
    const response = await fetch(`${base}/healthz`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.practices, 1, 'the count is what a health check is for');
    // The version is here because /healthz is the one address an operator can reach without signing in, and
    // "which build is running" is the first question asked when something is wrong. Asserted as a shape rather
    // than a value, so a release does not fail its own test suite.
    assert.match(body.version, /^\d+\.\d+\.\d+$/, 'and the version is answerable without signing in');
  });
});

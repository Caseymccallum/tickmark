/**
 * The security properties this product claims, attacked rather than admired.
 *
 * Written after an audit that found three things, and kept because "we check the practice id" is a claim that
 * decays: a route added in a year's time will not remember to be careful, and only a test that *tries* can fail.
 *
 * Every test here is an attack. A test that something works is not the same as a test that it cannot be made to
 * work for somebody else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeAt, counterAt } from '../src/totp.js';
import { twoFactorState } from '../src/auth.js';
import { uploadsOf } from '../src/store.js';
import { PASSWORD, createLink, practiceWithRequest, upload, withServer } from './helpers.js';

/** A second practice, with its own client, request, item and link. */
async function secondPractice(db, agent, base) {
  const other = await practiceWithRequest({ agent: () => agent(base), db }, 'ada@other.example');
  // The helper names every fixture client "Northwind Ltd", which would make an assertion about one practice not
  // seeing another's client names pass for the wrong reason. Renaming is the difference between a test that
  // checks isolation and a test that checks nothing.
  const clientId = db.prepare('SELECT client_id FROM request WHERE id = ?').get(other.requestId).client_id;
  db.prepare('UPDATE client SET name = ? WHERE id = ?').run('Contoso Ltd', clientId);
  const { token } = await createLink(other.client, other.requestId);
  await upload({
    base,
    token,
    itemId: other.itemIds[0],
    publicKey: other.keys.publicKey,
    plaintext: Buffer.from('Contoso private accounts'),
    filename: 'contoso-statements.pdf',
  });
  return { ...other, token };
}

test('one practice cannot reach another practice\u2019s records by guessing an address', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const mine = await practiceWithRequest({ agent, db });
    const theirs = await secondPractice(db, agent, base);

    // Every address that takes somebody else's id. A 404 is the right answer for all of them: not "forbidden",
    // which confirms the record exists, but "there is nothing at that address" — because for this practice
    // there is not.
    const attempts = [
      ['the request', `/requests/${theirs.requestId}`],
      ['editing it', `/requests/${theirs.requestId}/edit`],
      ['its link', `/requests/${theirs.requestId}/link`],
      ['its reminder', `/requests/${theirs.requestId}/remind`],
      ['closing it', `/requests/${theirs.requestId}/close`],
    ];

    for (const [what, path] of attempts) {
      const got = await mine.client.get(path);
      assert.ok(
        got.status === 404 || got.status === 405,
        `${what}: reached across practices (${got.status}) — a 404 is the only honest answer`,
      );
    }

    // And the documents themselves, by id, through the address that serves bytes.
    const [theirFile] = uploadsOf(db, theirs.requestId);
    const stolen = await mine.client.get(`/requests/${theirs.requestId}/files/${theirFile.id}`);
    assert.equal(stolen.status, 404, 'their document is not reachable from my practice');
    assert.ok(!(await stolen.text()).includes('Contoso'), 'and nothing about it leaks into the refusal');
  });
});

test('a client link opens one request and nothing else', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const mine = await practiceWithRequest({ agent, db });
    const { token } = await createLink(mine.client, mine.requestId);
    const theirs = await secondPractice(db, agent, base);

    // A link is a bearer token, so the question is how much it bears. It must reach exactly one request.
    const anonymous = agent(base);
    const page = await (await anonymous.get(`/r/${token}`)).text();
    assert.match(page, /Northwind Ltd/, 'my client is named');
    assert.ok(!page.includes('Contoso'), 'and the other practice is not');

    // Using my link to post at an item that belongs to *their* request: the item has to belong to the request
    // the token names, or a link is a key to every door in the building.
    const theirFile = uploadsOf(db, theirs.requestId)[0];
    const crossed = await anonymous.post(`/r/${token}/items/${theirFile.request_item_id}`, {});
    assert.ok(crossed.status >= 400, `an item from another request is refused (${crossed.status})`);

    const theirsPage = await (await anonymous.get(`/r/${theirs.token}`)).text();
    assert.ok(!theirsPage.includes('Northwind'), 'and a token names only its own request');
  });
});

test('a signed-out visitor gets nothing from a practice address', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { requestId } = await practiceWithRequest({ agent, db });
    const stranger = agent(base);

    for (const path of ['/requests', `/requests/${requestId}`, '/clients', '/files', '/keys', '/members']) {
      const got = await stranger.get(path);
      assert.ok(got.status === 303 || got.status === 401, `${path} answered a stranger with ${got.status}`);
      assert.ok(!(await got.text()).includes('Northwind'), `${path} leaked a client name to a stranger`);
    }
  });
});
test('a wrong code at the second factor cannot be ground down', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = db.prepare('SELECT id FROM practitioner LIMIT 1').get().id;
    await client.post('/account/two-factor/start', {});
    const secret = twoFactorState(db, id).secret;
    await client.post('/account/two-factor/confirm', { code: codeAt(secret, counterAt()) });

    // An attacker who *knows the password* is exactly the threat two-factor exists for. So the attack is: sign in
    // with the password, then walk the six-digit space. A million codes is a small space for a machine.
    const browser = agent();
    const started = await browser.post('/signin', { email: 'sam@practice.example', password: PASSWORD });
    assert.equal(started.status, 303, 'the password is accepted — that is the premise of this attack');

    const right = codeAt(secret, counterAt());
    let answered = 0;
    let shut = null;
    for (let guess = 0; guess < 20; guess += 1) {
      const candidate = String(guess).padStart(6, '0');
      if (candidate === right) continue; // never guess the right one by accident
      const response = await browser.post('/signin/code', { code: candidate });
      // A 401 whose body is the ordinary "that code was not right" is a *free guess*. Anything else — a 429 from
      // the account limiter, or a 410 because the challenge was destroyed — means the door shut.
      const body = await response.text();
      if (response.status === 401 && /Codes change every thirty seconds/.test(body)) {
        answered += 1;
        continue;
      }
      shut = response.status;
      break;
    }

    // The property, stated as the thing that matters: the number of free guesses is small and bounded. Which of
    // the two guards does the bounding is an implementation detail — that it *is* bounded is not.
    assert.ok(answered < 10, `${answered} free guesses at a six-digit code — the space is walkable`);
    assert.ok(shut === 429 || shut === 410, `the door shut with ${shut} after ${answered} guesses`);
  });
});

test('the second factor is asked for before a session exists, not after', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = db.prepare('SELECT id FROM practitioner LIMIT 1').get().id;
    await client.post('/account/two-factor/start', {});
    const secret = twoFactorState(db, id).secret;
    await client.post('/account/two-factor/confirm', { code: codeAt(secret, counterAt()) });

    const browser = agent();
    await browser.post('/signin', { email: 'sam@practice.example', password: PASSWORD });

    // The half-finished sign-in must not open anything. This is the assertion that would catch a refactor which
    // created the session first and checked the code afterwards — which is the mistake worth a test.
    for (const path of ['/requests', '/clients', '/files', '/members']) {
      const got = await browser.get(path);
      assert.ok(
        got.status === 303 || got.status === 401 || got.status === 403,
        `${path} opened before the code was given (${got.status})`,
      );
    }
  });
});
test('every response carries the headers this product depends on', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    // A client's URL *is* a credential — `/r/<token>` and nothing else — so the referrer policy is not a hardening
    // nicety here, it is the thing that stops a token travelling to whoever a client links to next.
    const portal = await client.get(`/r/${'x'.repeat(32)}`);
    assert.equal(portal.headers.get('referrer-policy'), 'no-referrer', 'a page whose URL is a secret does not leak it');

    for (const [what, path] of [
      ['a page', '/requests'],
      ['the documents page', '/files'],
      ['a JSON answer', '/healthz'],
      ['a CSV', '/requests.csv'],
    ]) {
      const headers = (await client.get(path)).headers;
      assert.equal(headers.get('x-frame-options'), 'DENY', `${what} cannot be framed`);
      assert.equal(headers.get('x-content-type-options'), 'nosniff', `${what} is not guessed at`);
      assert.equal(headers.get('referrer-policy'), 'no-referrer', `${what} does not leak where you came from`);
    }

    // And the response that serves a client's actual document — the one a browser could most easily be persuaded to
    // treat as something other than bytes.
    const [stored] = db.prepare('SELECT id FROM upload WHERE request_id = ?').all(requestId);
    if (stored) {
      const file = await client.get(`/requests/${requestId}/files/${stored.id}`);
      assert.equal(file.headers.get('x-content-type-options'), 'nosniff', 'a served document is not interpreted');
    }
  });
});



/**
 * The invitation flow over HTTP, which is the part a person actually uses.
 *
 * `test/invite.test.js` checks the store; this checks the pages and the routes, and goes one step
 * further than any of them: **the new member fetches a document uploaded before they existed, through
 * the ordinary file route, with their own session and their own passphrase.** That is the thing a
 * two-partner firm needs, and it is the only test here that proves the whole path rather than its parts.
 *
 * The browser is simulated by calling the same module functions `web/members.js` and `web/invite.js`
 * call. That is honest for the crypto — Web Crypto is the same API in Node — and it is what makes the
 * fragment secret checkable at all: this test holds the secret, exactly as the page does, and the server
 * never receives it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decryptEnvelope,
  newInviteSecret,
  openInviteBytes,
  privateKeyBytesForTransfer,
  readEnvelope,
  sealPrivateKey,
  unwrapPracticeKey,
  wrapBytesForInvite,
} from '../web/tickmark-crypto.js';

import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';
const NEWCOMER_PASSPHRASE = 'the newcomer passphrase';

/** What the owner's browser does: seal the key under a fresh secret, and post only the blob. */
async function inviteFromBrowser(client, { keyId, wrappedPrivateKey, passphrase }) {
  const secret = newInviteSecret();
  const sealed = await wrapBytesForInvite(
    await privateKeyBytesForTransfer(wrappedPrivateKey, passphrase),
    secret,
  );
  const response = await client.request('/members/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ key_id: keyId, sealed_key: sealed }).toString(),
  });
  return { response, secret, sealed, body: await response.json().catch(() => ({})) };
}

/** What the newcomer's browser does: open the blob with the fragment secret, re-seal, post that. */
async function acceptFromBrowser(client, token, secret, sealed, { email, password, passphrase }) {
  const wrapped = await sealPrivateKey(await openInviteBytes(sealed, secret), passphrase);
  return client.post(`/invite/${token}`, { email, password, wrapped_private_key: wrapped });
}

test('a new member joins through the link and can open a file that predates them', async () => {
  await withServer(async ({ agent, base, db }) => {
    // A practice with a key, a request, and a document already delivered.
    const firm = await practiceWithRequest({ agent, db });
    const link = await createLink(firm.client, firm.requestId);
    const sent = await upload({
      base,
      token: link.token,
      itemId: firm.itemIds[0],
      publicKey: firm.keys.publicKey,
      plaintext: Buffer.from('the bank statement, from before the newcomer arrived'),
      filename: 'statement.pdf',
    });

    const keyId = db.prepare('SELECT id FROM practice_key').get().id;

    // The owner makes an invitation from the members page.
    const membersPage = await firm.client.get('/members');
    const pageHtml = await membersPage.text();
    assert.equal(membersPage.status, 200);
    assert.match(pageHtml, /Invite someone/, 'the form is offered');
    assert.match(pageHtml, /Whoever opens the link gets the key/, 'and says plainly what the link is');
    assert.match(pageHtml, /id="invite-key"/, 'with the key handed to the browser to seal');

    const made = await inviteFromBrowser(firm.client, {
      keyId,
      wrappedPrivateKey: firm.keys.wrappedPrivateKey,
      passphrase: firm.keys.passphrase,
    });
    assert.equal(made.response.status, 201, 'the invitation was recorded');
    assert.ok(made.body.token, 'and the browser got a token to build the link from');

    // The server holds a blob it cannot open with the token it just handed out. This is the property the
    // whole design rests on, so it is asserted rather than assumed.
    const stored = db.prepare('SELECT sealed_key FROM invite').get().sealed_key;
    assert.equal(stored, made.sealed);
    await assert.rejects(
      () => openInviteBytes(stored, made.body.token),
      'the token does not open the invitation — only the fragment does',
    );

    // The newcomer opens the link. The page names the practice and stops there: the secret is in the
    // fragment, which the server never receives.
    const newcomer = agent();
    const landing = await newcomer.get(`/invite/${made.body.token}`);
    const landingHtml = await landing.text();
    assert.equal(landing.status, 200);
    assert.match(landingHtml, /Join My practice/, 'it names the practice');
    assert.match(landingHtml, /id="invite-blob"/, 'and hands the browser the blob to open');
    assert.ok(
      !landingHtml.includes(made.secret),
      'the secret is nowhere in what the server sent — it came from the fragment, which never reaches the server',
    );

    // They fill it in and join.
    const joined = await acceptFromBrowser(newcomer, made.body.token, made.secret, made.sealed, {
      email: 'newcomer@practice.example',
      password: 'a long enough password',
      passphrase: NEWCOMER_PASSPHRASE,
    });
    assert.equal(joined.status, 303, 'joining signs them in');
    assert.equal(joined.headers.get('location'), '/requests');
    assert.ok(joined.headers.getSetCookie().length > 0, 'with a session of their own');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 2, 'two members');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM key_wrapping').get().n, 2, 'each with their own copy');

    // The part that matters: fetch the file that arrived before they existed, with their session, and
    // open it with their own passphrase.
    const uploadId = db.prepare('SELECT id FROM upload').get().id;
    const fetched = await newcomer.get(`/requests/${firm.requestId}/files/${uploadId}`);
    assert.equal(fetched.status, 200, 'the newcomer can fetch it');
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    assert.ok(Buffer.from(bytes).equals(Buffer.from(sent.envelope)), 'and it is the same envelope');

    const theirId = db
      .prepare('SELECT id FROM practitioner WHERE email = ?')
      .get('newcomer@practice.example').id;
    const theirRecord = db
      .prepare('SELECT wrapped_private_key FROM key_wrapping WHERE practitioner_id = ?')
      .get(theirId).wrapped_private_key;
    const theirKey = await unwrapPracticeKey(theirRecord, NEWCOMER_PASSPHRASE);
    assert.equal(
      new TextDecoder().decode(await decryptEnvelope(theirKey, bytes)),
      'the bank statement, from before the newcomer arrived',
      'the document that predates them opens with their own passphrase',
    );
    assert.equal(readEnvelope(bytes).ok, true, 'and what they fetched really is an envelope');

    // The members page now lists them, and says they hold a copy.
    const after = await firm.client.get('/members');
    const afterHtml = await after.text();
    assert.match(afterHtml, /newcomer@practice\.example/, 'the new member is listed');
    assert.match(afterHtml, /2 people\s+in this practice/, 'and counted');
    assert.ok(!/hold no copy of the newest key/.test(afterHtml), 'nobody is flagged as unable to open files');
  });
test('an invitation that has been used cannot be used again, and says so', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await practiceWithRequest({ agent, db });
    const keyId = db.prepare('SELECT id FROM practice_key').get().id;
    const made = await inviteFromBrowser(firm.client, {
      keyId,
      wrappedPrivateKey: firm.keys.wrappedPrivateKey,
      passphrase: firm.keys.passphrase,
    });

    const first = await acceptFromBrowser(agent(), made.body.token, made.secret, made.sealed, {
      email: 'first@practice.example',
      password: 'a long enough password',
      passphrase: 'the first passphrase',
    });
    assert.equal(first.status, 303);

    const second = await acceptFromBrowser(agent(), made.body.token, made.secret, made.sealed, {
      email: 'second@practice.example',
      password: 'a long enough password',
      passphrase: 'the second passphrase',
    });
    assert.equal(second.status, 410, 'a used invitation is gone, not forbidden');
    assert.match(await second.text(), /works once/, 'and says why');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 2, 'two members, not three');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM key_wrapping').get().n, 2, 'and two key copies');
  });
});

test('a submission from a browser that did not run the script is refused, not half-accepted', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await practiceWithRequest({ agent, db });
    const keyId = db.prepare('SELECT id FROM practice_key').get().id;
    const made = await inviteFromBrowser(firm.client, {
      keyId,
      wrappedPrivateKey: firm.keys.wrappedPrivateKey,
      passphrase: firm.keys.passphrase,
    });

    // What a form post looks like with JavaScript off: the passphrase fields are filled and there is no
    // sealed record, because the sealing never happened.
    const plain = await agent().post(`/invite/${made.body.token}`, {
      email: 'nojs@practice.example',
      password: 'a long enough password',
      passphrase: 'typed but never used',
      again: 'typed but never used',
    });
    assert.equal(plain.status, 200, 'the page comes back with a sentence rather than a redirect');
    assert.match(await plain.text(), /needs JavaScript/, 'and the sentence says what is missing');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 1, 'nobody was created');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM key_wrapping').get().n, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM invite WHERE used_at IS NOT NULL').get().n,
      0,
      'and the invitation is still usable, so the person can retry with JavaScript on',
    );
  });
});

test('a submission with something that is not a key record is refused', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await practiceWithRequest({ agent, db });
    const keyId = db.prepare('SELECT id FROM practice_key').get().id;
    const made = await inviteFromBrowser(firm.client, {
      keyId,
      wrappedPrivateKey: firm.keys.wrappedPrivateKey,
      passphrase: firm.keys.passphrase,
    });

    for (const wrapped of ['', 'not a record', 'invite$sha-256$a$b$c', 'pbkdf2$sha-512$600000$a$b$c']) {
      const attempt = await agent().post(`/invite/${made.body.token}`, {
        email: 'odd@practice.example',
        password: 'a long enough password',
        wrapped_private_key: wrapped,
      });
      assert.equal(attempt.status, 200, `"${wrapped.slice(0, 20)}" is refused with the page, not a crash`);
      assert.match(await attempt.text(), /sealed copy of the key|needs JavaScript/);
    }

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 1, 'and nobody was created');
  });
});

test('the members page refuses to make an invitation from a key the practice does not hold', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await practiceWithRequest({ agent, db });
    const keyId = db.prepare('SELECT id FROM practice_key').get().id;

    // A well-formed blob, but for a key that is not this practice's.
    const strangerKey = await import('../web/tickmark-crypto.js').then((module) =>
      module.generatePracticeKey('a stranger passphrase'));
    const secret = newInviteSecret();
    const sealed = await wrapBytesForInvite(
      await privateKeyBytesForTransfer(strangerKey.wrappedPrivateKey, 'a stranger passphrase'),
      secret,
    );

    const attempt = await firm.client.request('/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ key_id: 'no-such-key', sealed_key: sealed }).toString(),
    });
    assert.equal(attempt.status, 400);
    assert.match(JSON.stringify(await attempt.json()), /not a key you hold a copy of/);

    // And the same with a real key id but a blob sealed from a different key — the id is checked, so this
    // is accepted, which is the honest limit: the server cannot tell one blob from another. It is stated
    // here rather than glossed, because it is the boundary of what this check can do.
    const withRealId = await firm.client.request('/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ key_id: keyId, sealed_key: sealed }).toString(),
    });
    assert.equal(withRealId.status, 201, 'a member may seal whatever they like, as long as it is a blob');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM invite').get().n,
      1,
      'but the invitation carries it, and the newcomer finds out when it does not open',
    );
  });
});
});
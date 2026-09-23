/**
 * A person's own sign-in: changing the password, changing the address, and seeing where they are
 * signed in — plus the two things around an account that protect everybody else: taking an
 * invitation back before it is used, and the practice being told when the people or the keys change.
 *
 * The rules these tests defend: a change costs the *current* password, a password change reaches
 * every session holding the old one, an invitation can be killed before it hands over a key, and the
 * one silent attack this product's threat model describes — a member adding a key of their own — is
 * never silent to the people who answer for the firm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, hashToken, newToken } from '../src/crypto.js';
import { claimInvite, createInvite, inviteByToken } from '../src/store.js';
import { generatePracticeKey } from '../web/tickmark-crypto.js';
import { startRelay } from './smtp-relay.js';
import { PASSPHRASE, PASSWORD, practiceWithRequest, signUp, withServer } from './helpers.js';

/** The mailer shape `sendMail` speaks to, pointed at the fake relay. */
const mailerAt = (port) => ({
  host: '127.0.0.1',
  port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Northwind Practice <office@practice.example>',
  timeoutMs: 3000,
  describe: () => `127.0.0.1:${port}`,
});

/**
 * Wait for a background send to land. The handlers answer the browser before they talk to the relay
 * — that ordering is a feature (see `notifyPracticeOfChange`) — so the test polls rather than
 * assuming the mail has arrived by the time the response has.
 */
async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test('a password can be changed, and everything holding the old one stops working', async (t) => {
  await withServer(async ({ agent: jar }) => {
    const owner = jar();
    await signUp(owner, 'sam@practice.example');
    // A second browser, signed in before the change — the one the change has to reach.
    const other = jar();
    assert.equal((await other.post('/signin', { email: 'sam@practice.example', password: PASSWORD })).status, 303);

    const wrong = await owner.post('/account/password', {
      current: 'not the password at all',
      fresh: 'a new long password',
      again: 'a new long password',
    });
    assert.equal(wrong.status, 400, 'the current password is the price of admission');
    assert.equal((await other.get('/requests')).status, 200, 'and a refusal changes nothing');

    const changed = await owner.post('/account/password', {
      current: PASSWORD,
      fresh: 'a new long password',
      again: 'a new long password',
    });
    assert.equal(changed.status, 303);
    assert.equal(changed.headers.get('location'), '/account/password?changed=1');

    assert.equal((await owner.get('/requests')).status, 200, 'the browser that made the change stays signed in');
    const evicted = await other.get('/requests');
    assert.equal(evicted.status, 303, 'the other one is signed out');
    assert.equal(evicted.headers.get('location'), '/signin', 'right back to the door');

    const fresh = jar();
    assert.equal((await fresh.post('/signin', { email: 'sam@practice.example', password: PASSWORD })).status, 401, 'the old password is dead');
    assert.equal(
      (await fresh.post('/signin', { email: 'sam@practice.example', password: 'a new long password' })).status,
      303,
      'and the new one signs in',
    );
  });
});

test('an address change needs the password and refuses one already taken', async (t) => {
  await withServer(async ({ agent: jar }) => {
    const owner = jar();
    await signUp(owner, 'sam@practice.example');
    await signUp(jar(), 'kim@practice.example');

    const wrong = await owner.post('/account/email', { current: 'nope nope nope', email: 'new@practice.example' });
    assert.equal(wrong.status, 400, 'the current password is asked for here too');

    const clash = await owner.post('/account/email', { current: PASSWORD, email: 'kim@practice.example' });
    assert.equal(clash.status, 400, 'an address somebody else holds is refused');

    const moved = await owner.post('/account/email', { current: PASSWORD, email: 'Sam.New@Practice.Example' });
    assert.equal(moved.status, 303);

    const fresh = jar();
    assert.equal(
      (await fresh.post('/signin', { email: 'sam.new@practice.example', password: PASSWORD })).status,
      303,
      'the new address signs in, as typed but lower-cased',
    );
  });
});

test('the sessions page names this one and ends the others on request', async (t) => {
  await withServer(async ({ agent: jar, db }) => {
    const first = jar();
    await signUp(first, 'sam@practice.example');
    const second = jar();
    await second.post('/signin', { email: 'sam@practice.example', password: PASSWORD });

    const page = await (await first.get('/account/sessions')).text();
    assert.match(page, /this one/, 'the session being held is named, so the list is readable');
    assert.equal((page.match(/Sign it out/g) ?? []).length, 1, 'and the other one has a button');

    // Ending the session you are holding is Sign out's job, and this route says so rather than
    // signing somebody out from under a form aimed at a row below.
    const mine = db.prepare('SELECT id FROM session ORDER BY created_at LIMIT 1').get().id;
    assert.equal((await first.post('/account/sessions/end', { id: mine })).status, 400, 'not this one');

    const ended = await first.post('/account/sessions/end-others', {});
    assert.equal(ended.status, 303);
    const gone = await second.get('/requests');
    assert.equal(gone.headers.get('location'), '/signin', 'the other browser is out');
    assert.equal((await first.get('/requests')).status, 200, 'and this one is untouched');
  });
});

test('an invitation can be taken back before it is used', async (t) => {
  await withServer(async ({ agent: jar, db }) => {
    const owner = jar();
    await signUp(owner, 'sam@practice.example');
    const person = db.prepare('SELECT id, practice_id FROM practitioner LIMIT 1').get();
    const token = newToken();
    const inviteId = createInvite(db, {
      practiceId: person.practice_id,
      createdBy: person.id,
      role: 'accountant',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const revoked = await owner.post(`/members/invite/${inviteId}/revoke`, {});
    assert.equal(revoked.status, 303, 'the owner takes it back');
    assert.equal(inviteByToken(db, token).state, 'revoked', 'and the link is dead');

    const page = await (await jar().get(`/invite/${token}`)).text();
    assert.match(page, /taken back/, 'the page says which kind of dead it is');

    const claimed = claimInvite(db, {
      token,
      email: 'lee@practice.example',
      passwordHash: await hashPassword(PASSWORD),
      wrappedPrivateKey: null,
    });
    assert.ok(claimed.state !== 'joined' && claimed.state !== 'rejoined', `nobody joins with it (got ${claimed.state})`);

    assert.equal((await owner.post(`/members/invite/${inviteId}/revoke`, {})).status, 400, 'and taking it back twice is refused');
  });
});

test('the practice is told when the keys or the people change', async (t) => {
  const relay = await startRelay(t);
  await withServer(
    async ({ agent: jar, db }) => {
      // Signing up and making a key, then making a *second* one — the rotation. The first key is
      // deliberately silent (see `saveKeys`); the announcement exists for the moment a practice that
      // already has a key gains another, which is the rotation-or-hijack case.
      const { client: owner } = await practiceWithRequest({ agent: jar, db }, 'sam@practice.example');
      const person = db.prepare('SELECT id, practice_id FROM practitioner LIMIT 1').get();
      const second = await generatePracticeKey(PASSPHRASE);
      const rotated = await owner.post('/setup', {
        public_key: JSON.stringify(second.publicKey),
        wrapped_private_key: second.wrappedPrivateKey,
      });
      assert.equal(rotated.status, 303, 'the rotation itself works');

      const token = newToken();
      createInvite(db, {
        practiceId: person.practice_id,
        createdBy: person.id,
        role: 'accountant',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const joined = claimInvite(db, {
        token,
        email: 'kim@practice.example',
        passwordHash: await hashPassword(PASSWORD),
        wrappedPrivateKey: null,
      });
      assert.equal(joined.state, 'joined');

      await owner.post(`/members/${joined.practitionerId}/role`, { role: 'assistant' });
      await owner.post(`/members/${joined.practitionerId}/remove`, {});

      assert.ok(
        await waitFor(() => relay.seen.messages.length >= 3),
        `three announcements arrive eventually — got ${relay.seen.messages.length}`,
      );
      const all = relay.seen.messages
        .map((message) => {
          const [headers, body = ''] = message.split('\r\n\r\n');
          // The body travels base64 (see `buildMessage`), so the words to assert on are one decode away.
          return `${headers}\n${Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')}`;
        })
        .join('\n---\n');
      assert.match(all, /Subject: A new encryption key was added/, 'the key is announced');
      assert.match(all, /Subject: A member's role changed/, 'so is the role change');
      assert.match(all, /Subject: A member was removed/, 'and the removal');
      assert.match(all, /kim@practice\.example/, 'each naming who it is about');
    },
    { mailer: mailerAt(relay.port) },
  );
});
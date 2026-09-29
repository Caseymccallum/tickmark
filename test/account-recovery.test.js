/**
 * Getting into an account: finishing a sign-up, and getting back in after a password is lost.
 *
 * The two things a practice's owner does once and then relies on, and the two a product holding
 * financial records cannot get wrong. Both are two-step on purpose, and these tests are mostly about
 * what the product *refuses* to say: that sign-up does not answer "is that address taken?", and that a
 * reset link is never handed to whoever asked for one.
 *
 * The link that finishes either is sent, never shown (when a mail server is configured), so a test reads
 * it out of the letter that carried it — `linkFromSent` — the same way the recipient would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PASSWORD, linkFromSent, sentMessages, signUp, withServer } from './helpers.js';

/**
 * A mail server the tests never actually dial: the two-step account letters are taken by the harness
 * before they reach the wire (see `test/helpers.js`), so `sendMail` returns before it opens a socket.
 * What matters is that a mailer is *configured* — that is the whole difference between a link being
 * sent and a link being shown on the page.
 */
const mailer = {
  host: '127.0.0.1',
  port: 9,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Tickmark <office@tickmark.example>',
  timeoutMs: 500,
  describe: () => 'a mail server',
};

const NEW_PASSWORD = 'a different long password';

test('sign-up does not answer whether an address is already here', async () => {
  await withServer(async ({ agent }) => {
    await signUp(agent(), 'taken@practice.example');

    const asNew = await agent().post('/signup', { email: 'brand@new.example', password: PASSWORD });
    const asTaken = await agent().post('/signup', { email: 'taken@practice.example', password: PASSWORD });

    for (const [what, response] of [['a new address', asNew], ['a taken address', asTaken]]) {
      assert.equal(response.status, 200, `${what} gets the same reply`);
      const page = await response.text();
      assert.match(page, /Check your email/, `${what} is told to check its email`);
      assert.ok(!/already exists|Sign in instead|there is already/i.test(page), `${what} is told nothing about who is here`);
    }
  });
});

test('nothing is created until the link is opened', async () => {
  await withServer(async ({ agent, db }) => {
    const client = agent();
    await client.post('/signup', { email: 'sam@practice.example', password: PASSWORD });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 0, 'a filled-in form makes no account');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practice').get().n, 0, 'and no practice');

    const token = linkFromSent('verify');
    assert.ok(token, 'the letter carries the link that finishes it');
    await client.get(`/verify/${token}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 0, 'looking at the page still makes nothing');

    const done = await client.post(`/verify/${token}`, {});
    assert.equal(done.status, 303, 'confirming is what makes the practice');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 1, 'one owner');
  }, { mailer });
});

test('with a mail server the link is sent and not shown', async () => {
  await withServer(async ({ agent }) => {
    const response = await agent().post('/signup', { email: 'sam@practice.example', password: PASSWORD });
    const page = await response.text();
    assert.match(page, /Check your email/);
    assert.ok(!/\/verify\//.test(page), 'the page does not carry the link — it is in the mailbox and nowhere else');

    const letter = sentMessages().at(-1);
    assert.equal(letter.subject, 'Finish creating your Tickmark practice');
    assert.match(letter.body, /\/verify\/[A-Za-z0-9_-]{20,}/, 'and the letter does carry it');
  }, { mailer });
});

test('a taken address is told so in its own mailbox, and the form-filler is told nothing', async () => {
  await withServer(async ({ agent }) => {
    await signUp(agent(), 'taken@practice.example');
    const response = await agent().post('/signup', { email: 'taken@practice.example', password: PASSWORD });
    assert.match(await response.text(), /Check your email/, 'the same page as a brand-new address');

    const letter = sentMessages().at(-1);
    assert.equal(letter.subject, 'You already have a Tickmark practice', 'the mailbox owner is told the truth');
    assert.ok(!/\/verify\//.test(letter.body), 'and is not sent a link that would make a second practice');
  }, { mailer });
});

test('a sign-up link works once, and a spent one says so rather than making a second practice', async () => {
  await withServer(async ({ agent, db }) => {
    const client = agent();
    await client.post('/signup', { email: 'sam@practice.example', password: PASSWORD });
    const token = linkFromSent('verify');
    await client.get(`/verify/${token}`);
    assert.equal((await client.post(`/verify/${token}`, {})).status, 303, 'the first time makes the practice');

    const again = await client.post(`/verify/${token}`, {});
    assert.match(await again.text(), /already (used|finished)/, 'the second time says it already happened');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practice').get().n, 1, 'and makes no second practice');
  }, { mailer });
});

test('a lost password is set again by way of the mailbox, and every old session dies with it', async () => {
  await withServer(async ({ agent }) => {
    const owner = agent();
    await signUp(owner, 'sam@practice.example');

    const asked = await agent().post('/forgot', { email: 'sam@practice.example' });
    assert.match(await asked.text(), /Check your email/, 'asked in public, answered as "check your email"');

    const token = linkFromSent('reset');
    assert.ok(token, 'the reset link went to the mailbox');
    assert.match(await (await agent().get(`/reset/${token}`)).text(), /Set a new password/);
    assert.equal((await agent().post(`/reset/${token}`, { password: NEW_PASSWORD, again: NEW_PASSWORD })).status, 303);

    // The point of a reset: whatever was holding the old password stops working. The session signed
    // into at the top is dead, the old password is refused, and the new one opens the door.
    assert.notEqual((await owner.get('/requests')).status, 200, 'the old session is signed out');
    assert.notEqual((await agent().post('/signin', { email: 'sam@practice.example', password: PASSWORD })).status, 303, 'the old password no longer opens it');
    assert.equal((await agent().post('/signin', { email: 'sam@practice.example', password: NEW_PASSWORD })).status, 303, 'the new one does');
  }, { mailer });
});

test('a reset link is refused the second time, so a reset cannot be replayed', async () => {
  await withServer(async ({ agent }) => {
    await signUp(agent(), 'sam@practice.example');
    await agent().post('/forgot', { email: 'sam@practice.example' });
    const token = linkFromSent('reset');
    assert.equal((await agent().post(`/reset/${token}`, { password: NEW_PASSWORD, again: NEW_PASSWORD })).status, 303);

    const again = await agent().post(`/reset/${token}`, { password: 'a third long password', again: 'a third long password' });
    assert.match(await again.text(), /already (used|finished)/, 'the second attempt says it was spent');
  }, { mailer });
});

test('asking for a reset does not say whether the address is here', async () => {
  await withServer(async ({ agent }) => {
    await signUp(agent(), 'here@practice.example');

    const asHere = await agent().post('/forgot', { email: 'here@practice.example' });
    const asGone = await agent().post('/forgot', { email: 'nobody@practice.example' });
    for (const [what, response] of [['a known address', asHere], ['an unknown address', asGone]]) {
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Check your email/, `${what} gets the same answer`);
    }
    assert.equal(sentMessages().at(-1).subject, 'Set a new password for Tickmark', 'only the real account is sent a link');
  }, { mailer });
});

test('with no mail server, a reset points at the operator and hands out no link', async () => {
  await withServer(async ({ agent }) => {
    await signUp(agent(), 'sam@practice.example');
    const response = await agent().post('/forgot', { email: 'sam@practice.example' });
    const page = await response.text();
    assert.match(page, /reset-password\.mjs/, 'it names the tool the operator runs');
    assert.ok(!/\/reset\//.test(page), 'and never shows a link that would reset anybody\u2019s password');
  });
});

test('a sign-up link can be sent again, and the re-sent one finishes the same sign-up', async () => {
  await withServer(async ({ agent, db }) => {
    const client = agent();
    const asked = await client.post('/signup', { email: 'sam@practice.example', password: PASSWORD });
    assert.match(await asked.text(), /Send it again/, 'the page offers to send it again');
    const first = linkFromSent('verify');

    const resent = await client.post('/resend', { email: 'sam@practice.example', for: 'verify' });
    assert.match(await resent.text(), /Sent again/, 'and says it was sent again');
    const second = linkFromSent('verify');
    assert.notEqual(second, first, 'a fresh link is minted, because the raw one is never stored');

    // The re-sent link carries the same waiting password, so it finishes the same sign-up — one
    // practice whichever of the two was opened, and no second one from the other.
    assert.equal((await client.post(`/verify/${second}`, {})).status, 303);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 1, 'one owner, one practice');
  }, { mailer });
});

test('a reset link can be sent again too', async () => {
  await withServer(async ({ agent }) => {
    await signUp(agent(), 'sam@practice.example');
    await agent().post('/forgot', { email: 'sam@practice.example' });
    const first = linkFromSent('reset');

    await agent().post('/resend', { email: 'sam@practice.example', for: 'reset' });
    const second = linkFromSent('reset');
    assert.notEqual(second, first);
    assert.equal((await agent().post(`/reset/${second}`, { password: NEW_PASSWORD, again: NEW_PASSWORD })).status, 303, 'the re-sent one sets the password');
  }, { mailer });
});

test('re-sending does not say whether the address is here', async () => {
  await withServer(async ({ agent }) => {
    await signUp(agent(), 'here@practice.example');

    const asHere = await agent().post('/resend', { email: 'here@practice.example', for: 'verify' });
    const asGone = await agent().post('/resend', { email: 'nobody@practice.example', for: 'verify' });
    for (const [what, response] of [['a known address', asHere], ['an unknown address', asGone]]) {
      assert.match(await response.text(), /Check your email/, `${what} gets the same answer`);
    }
  }, { mailer });
});
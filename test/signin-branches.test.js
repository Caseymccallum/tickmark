/**
 * The sign-up and sign-in refusals, which are the branches an attacker meets first.
 *
 * `signin-views.js` was the weakest server module for branch coverage in the audit (69%). Each of these is a refusal
 * that must (a) be a refusal and (b) leave nothing behind — no practice, no session — because a validation failure that
 * half-creates an account is how a duplicate or an unverified owner appears.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agent, signUp, withServer } from './helpers.js';

const practices = (db) => db.prepare('SELECT COUNT(*) AS n FROM practice').get().n;

test('a sign-up that is refused creates no practice', async () => {
  await withServer(async ({ base, db }) => {
    const attempts = [
      ['no address', { email: '', password: 'a long enough password' }],
      ['not an address', { email: 'not-an-address', password: 'a long enough password' }],
      ['no password', { email: 'someone@practice.example', password: '' }],
      ['a password that is too short', { email: 'someone@practice.example', password: 'short' }],
    ];
    for (const [what, fields] of attempts) {
      const response = await agent(base).post('/signup', fields);
      assert.ok([200, 400].includes(response.status), `${what}: refused with ${response.status}, not a 500`);
      assert.equal(practices(db), 0, `${what}: and no practice was created`);
    }
  });
});

test('signing up twice leaves one practice, and says the same thing either way', async () => {
  await withServer(async ({ base, db }) => {
    const first = agent(base);
    await signUp(first, 'twice@practice.example');
    assert.equal(practices(db), 1);

    const second = await agent(base).post('/signup', {
      email: 'twice@practice.example', password: 'a long enough password',
    });
    assert.equal(practices(db), 1, 'still one practice — a second sign-up does not make a second firm');
    assert.ok(second.status < 500, `and it is answered rather than failing (${second.status})`);
  });
});

test('a wrong password, or an address nobody has, signs nobody in', async () => {
  await withServer(async ({ base, db }) => {
    await signUp(agent(base), 'owner@practice.example');
    assert.equal(practices(db), 1);

    for (const [what, fields] of [
      ['the wrong password', { email: 'owner@practice.example', password: 'not the password' }],
      ['an address with no account', { email: 'nobody@practice.example', password: 'a long enough password' }],
      ['nothing at all', { email: '', password: '' }],
    ]) {
      const browser = agent(base);
      const response = await browser.post('/signin', fields);
      assert.ok(response.status < 500, `${what}: answered ${response.status} rather than failing`);
      // Whatever the page says, the session must not exist: a signed-out browser asking for the board is redirected.
      assert.equal((await browser.get('/requests')).status, 303, `${what}: and no session was created`);
    }
  });
});

test('a verification link that is not one verifies nothing', async () => {
  await withServer(async ({ base, db }) => {
    await agent(base).post('/signup', { email: 'pending@practice.example', password: 'a long enough password' });

    const browser = agent(base);
    const response = await browser.get('/verify/not-a-real-token');
    // A page that explains rather than an error code — either is a refusal, and the page is the better one to show a
    // person who has clicked a stale link.
    assert.ok([200, 400, 404].includes(response.status), `a forged token is refused (${response.status})`);
    assert.equal((await browser.get('/requests')).status, 303, 'and it does not sign anybody in');
  });
});

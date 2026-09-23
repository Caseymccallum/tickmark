/**
 * The two-factor flow: what it refuses, and the three ways it could lose somebody their account.
 *
 * The primitive is verified against the RFC in `two-factor.test.js`. What is tested here is the wiring, and the
 * failures worth writing tests for are the ones that lock a person *out* rather than the ones that let a
 * stranger in:
 *
 * 1. a code that works twice, which lets a shoulder-surfed code be reused;
 * 2. a challenge that never expires, which is a half-signed-in session sitting in a database;
 * 3. a recovery sheet that cannot be spent — the day the phone is gone, and the reason a practice turns a good
 *    security feature off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeAt, counterAt, generateSecret } from '../src/totp.js';
import { spendRecoveryCode, twoFactorState, unusedRecoveryCodes } from '../src/auth.js';
import { createAttemptLimiter } from '../src/ratelimit.js';
import { agent, PASSWORD, practiceWithRequest, withServer } from './helpers.js';

/** The signed-in person's row id. */
const onlyPerson = (db) => db.prepare('SELECT id FROM practitioner LIMIT 1').get().id;

/** Every recovery code on the page, in the order they were shown. */
const codesOn = (html) => [...html.matchAll(/<code>([A-Z2-9]{10})<\/code>/g)].map((match) => match[1]);

/**
 * A code from the next step, which is what somebody signs in with thirty seconds after setting the thing up.
 *
 * Worth being explicit about why this matters: the code that *arms* two-factor is recorded as used, so signing
 * in with the very same six digits is refused — correctly, because that is the single-use rule doing its job.
 * A test that reused it would be asserting the bug this feature exists to prevent.
 */
const nextCode = (secret) => codeAt(secret, counterAt() + 1);

/** Arm two-factor the way the page does, and hand back what the page showed. */
async function arm(client, db) {
  await client.post('/account/two-factor/start', {});
  const secret = twoFactorState(db, onlyPerson(db)).secret;
  assert.ok(secret, 'a secret is held, unarmed');
  const confirmed = await client.post('/account/two-factor/confirm', { code: codeAt(secret, counterAt()) });
  assert.equal(confirmed.status, 200, 'a correct code arms it');
  return { secret, codes: codesOn(await confirmed.text()) };
}

/**
 * Sign in with a password and hand back the browser, which now holds the challenge cookie the server set —
 * the same way a real browser would. Nothing is passed by hand, because a test that assembled the cookie
 * itself would not be testing that the server sets it.
 */
async function startSignIn(base) {
  const browser = agent(base);
  const response = await browser.post('/signin', { email: 'sam@practice.example', password: PASSWORD });
  return { browser, response };
}

test('two-factor is off until it is armed, and a wrong code does not arm it', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = onlyPerson(db);

    assert.equal(twoFactorState(db, id).state, 'off', 'nothing is set up to begin with');
    const page = await (await client.get('/account/two-factor')).text();
    assert.match(page, /not set up/, 'the page says so');
    assert.match(page, /add one of their own/, 'and gives the reason, which is the whole argument for it');

    await client.post('/account/two-factor/start', {});
    assert.equal(twoFactorState(db, id).state, 'unconfirmed', 'starting holds a secret');
    assert.equal(unusedRecoveryCodes(db, id), 0, 'and makes no codes yet');

    // A wrong code leaves it unarmed. That is what stops somebody locking themselves out by typing a secret in
    // wrong: the half-finished state is inert and the sign-in page ignores it entirely.
    const wrong = await client.post('/account/two-factor/confirm', { code: '000000' });
    assert.equal(wrong.status, 400, 'a wrong code is refused');
    assert.equal(twoFactorState(db, id).state, 'unconfirmed', 'and nothing is armed');

    const anonymous = agent();
    const signIn = await anonymous.post('/signin', { email: 'sam@practice.example', password: PASSWORD });
    assert.equal(signIn.status, 303, 'so signing in is unchanged');
    assert.equal(signIn.headers.get('location'), '/requests');
  });
});

test('a correct code arms it, and sign-in then wants two things', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = onlyPerson(db);

    const { secret, codes } = await arm(client, db);
    assert.equal(codes.length, 8, 'eight recovery codes are shown');
    assert.equal(unusedRecoveryCodes(db, id), 8, 'and all eight are usable');
    assert.equal(twoFactorState(db, id).state, 'on', 'it is armed');

    // The password alone no longer finishes a sign-in.
    const { browser, response } = await startSignIn(base);
    assert.equal(response.status, 303, 'the password is accepted');
    assert.equal(response.headers.get('location'), '/signin/code', 'and lands on the code page, not the board');
    assert.match(response.headers.getSetCookie().join('; '), /tickmark_challenge=/, 'a challenge cookie is set');
    // Counted before and after rather than asserted to be zero: the practice's own browser already holds a
    // session from signing up, and an assertion of zero would be measuring the fixture instead of the feature.
    const sessionsBefore = db.prepare('SELECT COUNT(*) AS n FROM session').get().n;

    // Fetching the page in between is fine, and is what a person does while finding their phone.
    assert.equal((await browser.get('/signin/code')).status, 200, 'the code page opens');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM session').get().n,
      sessionsBefore,
      'and a half-finished sign-in has added no session at all',
    );

    const completed = await browser.post('/signin/code', { code: nextCode(secret) });
    assert.equal(completed.status, 303, 'the code is accepted');
    assert.equal(completed.headers.get('location'), '/requests', 'and the sign-in finishes');
    assert.match(completed.headers.getSetCookie().join('; '), /tickmark_session=/, 'with a real session');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get().n, sessionsBefore + 1, 'exactly one more');
  });
});

test('a code works once, and a challenge is spent when it is used', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const { secret } = await arm(client, db);

    const code = nextCode(secret);
    const { browser } = await startSignIn(base);
    assert.equal((await browser.post('/signin/code', { code })).status, 303, 'the code works once');

    // The same six digits again, with a fresh challenge — which is what a shoulder-surfed code looks like. It
    // has already been used for this step, so it is refused for the rest of its ninety-second life.
    const second = await startSignIn(base);
    const reused = await second.browser.post('/signin/code', { code });
    assert.equal(reused.status, 401, 'and not twice');
    assert.match(await reused.text(), /Codes change every thirty seconds/, 'with a sentence explaining why');

    // The challenge is gone once spent: the browser that used it lands on the expired page, not the board.
    assert.equal((await browser.post('/signin/code', { code })).status, 410, 'and the spent challenge is gone');
    assert.equal((await agent().post('/signin/code', { code })).status, 410, 'nor is there one without a challenge');
  });
});

test('a recovery code stands in for the phone, once, and is refused afterwards', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = onlyPerson(db);
    const { codes } = await arm(client, db);

    const first = await startSignIn(base);
    const used = await first.browser.post('/signin/code', { code: codes[0] });
    assert.equal(used.status, 303, 'it works instead of a code from the app');
    assert.equal(unusedRecoveryCodes(db, id), 7, 'and there are seven left, not eight');

    // The same sheet used twice is exactly the failure single-use exists to prevent.
    const second = await startSignIn(base);
    assert.equal((await second.browser.post('/signin/code', { code: codes[0] })).status, 401, 'and never again');
    assert.equal(spendRecoveryCode(db, id, codes[0]), false, 'the store agrees');
  });
});

test('turning it off needs a code, and a recovery code is enough', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = onlyPerson(db);
    const { codes } = await arm(client, db);

    // A wrong code leaves it on. Without this, anybody at an unlocked laptop could remove the second factor —
    // which would make it worth nothing against exactly the threat it exists for.
    const refused = await client.post('/account/two-factor/off', { code: '000000' });
    assert.equal(refused.status, 400, 'a wrong code does not turn it off');
    assert.equal(twoFactorState(db, id).state, 'on', 'it is still on');

    // A recovery code turns it off, because the person who needs to is very often the person whose phone is
    // gone — and a feature that cannot be undone at the worst moment is one people disable early.
    const off = await client.post('/account/two-factor/off', { code: codes[1] });
    assert.equal(off.status, 303, 'a recovery code turns it off');
    assert.equal(twoFactorState(db, id).state, 'off', 'and it is off');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recovery_code').get().n, 0, 'the codes go with it');

    const { response } = await startSignIn(base);
    assert.equal(response.headers.get('location'), '/requests', 'and one password signs in again');
  });
});

test('new recovery codes need a code, and replace the old sheet rather than adding to it', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = onlyPerson(db);
    const { secret, codes } = await arm(client, db);

    const refused = await client.post('/account/two-factor/codes', { code: '000000' });
    assert.equal(refused.status, 400, 'a wrong code makes none');
    assert.equal(unusedRecoveryCodes(db, id), 8, 'and the old ones still work');

    // A code from the app one step on, because the step that armed it is already recorded as used.
    const fresh = await client.post('/account/two-factor/codes', { code: codeAt(secret, counterAt() + 1) });
    assert.equal(fresh.status, 200, 'a right code makes new ones');
    const second = codesOn(await fresh.text());
    assert.equal(second.length, 8, 'eight again');
    assert.equal(unusedRecoveryCodes(db, id), 8, 'still eight usable — replaced, not added to');
    assert.equal(spendRecoveryCode(db, id, codes[0]), false, 'so the old sheet is dead');
    assert.equal(spendRecoveryCode(db, id, second[0]), true, 'while the new one works');
  });
});

test('a secret held but never confirmed protects nothing, and says so', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const id = onlyPerson(db);

    // Reporting an unconfirmed setup as "on" would make somebody believe they are covered when they are not,
    // which is the one lie a security page must not tell.
    db.prepare('UPDATE practitioner SET totp_secret = ? WHERE id = ?').run(generateSecret(), id);
    assert.equal(twoFactorState(db, id).state, 'unconfirmed', 'held is not armed');

    const { response } = await startSignIn(base);
    assert.equal(response.headers.get('location'), '/requests', 'so a password still signs in');

    const page = await (await client.get('/account/two-factor')).text();
    assert.match(page, /Not armed yet/, 'and the page says exactly that');
  });
});

test('a stolen session cannot grind the two-factor actions', async (t) => {
  await withServer(
    async ({ agent, db }) => {
      const { client } = await practiceWithRequest({ agent, db });
      await arm(client, db);

      // Turning two-factor off needs a code — which is right, since it is the action a stolen session
      // would take to make itself permanent. What the sign-in path always had and this one lacked was
      // a *budget* for wrong codes: six digits with unlimited attempts is a million guesses against a
      // door that stays open for the life of the session.
      const first = await client.post('/account/two-factor/off', { code: '000000' });
      assert.equal(first.status, 400, 'a wrong code is refused');
      const second = await client.post('/account/two-factor/off', { code: '000000' });
      assert.equal(second.status, 400, 'and so is the next');
      const third = await client.post('/account/two-factor/off', { code: '000000' });
      assert.equal(third.status, 429, 'and then the endpoint stops accepting guesses at all');
      assert.match(await third.text(), /Too many wrong codes/, 'and says why');

      assert.equal(twoFactorState(db, onlyPerson(db)).state, 'on', 'two-factor is still on through all of it');
    },
    { signInLimiter: createAttemptLimiter({ limit: 2, windowMs: 60_000 }) },
  );
});

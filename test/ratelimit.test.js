/**
 * Being guessed at.
 *
 * `/signin` is the one endpoint a stranger can reach without a link, a token or an invitation, and nothing
 * was watching it. `docs/saas.md` had it on the list of things that would bite before charging anybody; it
 * bites a self-hosted install sooner, because a practice's address is on the internet the moment their
 * clients can upload to it.
 *
 * The rule the tests defend is the **scope of the bucket**: the account, not the address. Bucketing by IP
 * would let one attacker guess at many accounts, and behind the documented reverse-proxy deployment — where
 * every request arrives from the proxy — would let one attacker lock the whole practice out by failing ten
 * times. Both of those are worse than the thing being prevented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAttemptLimiter } from '../src/ratelimit.js';
import { PASSWORD, practiceWithRequest, signUp, withServer } from './helpers.js';

test('failures expire rather than locking anything, and a success wipes the slate', () => {
  let clock = 0;
  const limiter = createAttemptLimiter({ limit: 3, windowMs: 60_000, now: () => clock });

  assert.equal(limiter.blockedFor('sam@example.test'), 0, 'nothing has been tried yet');
  limiter.failed('sam@example.test');
  limiter.failed('sam@example.test');
  assert.equal(limiter.blockedFor('sam@example.test'), 0, 'two failures is not a lockout');

  limiter.failed('sam@example.test');
  assert.ok(limiter.blockedFor('sam@example.test') > 0, 'the third stops it answering');

  clock += 61_000;
  assert.equal(limiter.blockedFor('sam@example.test'), 0, 'and time alone releases it, with no reset button');

  limiter.failed('sam@example.test');
  limiter.succeeded('sam@example.test');
  assert.equal(limiter.blockedFor('sam@example.test'), 0, 'somebody who knows the password is not suspicious');
  assert.equal(limiter.size(), 0, 'and nothing is kept about them');
});

test('the bucket is one account, so one guesser cannot lock out a colleague', () => {
  let clock = 0;
  const limiter = createAttemptLimiter({ limit: 2, windowMs: 60_000, now: () => clock });

  limiter.failed('sam@example.test');
  limiter.failed('sam@example.test');
  limiter.failed('sam@example.test');

  assert.ok(limiter.blockedFor('sam@example.test') > 0, 'the guessed-at account is held');
  assert.equal(limiter.blockedFor('kim@example.test'), 0, 'and their colleague is untouched');
});

test('eleven wrong passwords stop the endpoint answering, and the right one afterwards still works', async (t) => {
  await withServer(
    async ({ agent }) => {
      const client = agent();
      await signUp(client, 'sam@practice.example');

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const refused = await client.post('/signin', { email: 'sam@practice.example', password: 'not the password' });
        assert.equal(refused.status, 401, `attempt ${attempt} is answered as a wrong password`);
      }

      const blocked = await client.post('/signin', { email: 'sam@practice.example', password: 'not the password' });
      assert.equal(blocked.status, 429, 'the fourth is not');
      const page = await blocked.text();
      assert.match(page, /Too many failed attempts for that address/, 'it says what is happening');
      assert.match(page, /Try again in 1 minute/, 'and how long for');
      assert.ok(!/do not match an account/.test(page), 'without pretending the password was the problem');

      // Guessing the *right* password is still refused while the account is held: the point is to stop the
      // conversation, not to score each attempt.
      const guessing = await client.post('/signin', { email: 'sam@practice.example', password: PASSWORD });
      assert.equal(guessing.status, 429, 'even a correct password waits');

      // And a different account is unaffected, which is the whole reason the bucket is the account.
      await signUp(agent(), 'kim@practice.example');
      const colleague = agent();
      const theirs = await colleague.post('/signin', { email: 'kim@practice.example', password: PASSWORD });
      assert.equal(theirs.status, 303, 'a colleague can still sign in');
    },
    { signInLimiter: createAttemptLimiter({ limit: 3, windowMs: 60_000 }) },
  );
});

test('signing in properly leaves no trace of suspicion behind', async (t) => {
  await withServer(
    async ({ agent }) => {
      const client = agent();
      await signUp(client, 'sam@practice.example');

      // Two fumbles, then the right password: the count must not survive it.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await client.post('/signin', { email: 'sam@practice.example', password: 'wrong again' });
      }
      const signedIn = await client.post('/signin', { email: 'sam@practice.example', password: PASSWORD });
      assert.equal(signedIn.status, 303, 'the right password works');

      // Two more fumbles after that still leave room, because the earlier ones were forgotten.
      const second = agent();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const refused = await second.post('/signin', { email: 'SAM@practice.example', password: 'wrong again' });
        assert.equal(refused.status, 401, 'and the count started from zero again');
      }
      assert.equal(
        (await second.post('/signin', { email: 'SAM@practice.example', password: PASSWORD })).status,
        303,
        'a third attempt is still allowed — the address is not held for the rest of the window',
      );
    },
    { signInLimiter: createAttemptLimiter({ limit: 4, windowMs: 60_000 }) },
  );
});

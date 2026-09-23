/**
 * The edges an attacker reaches first: a CSV a spreadsheet will execute, a cookie header the parser
 * would not survive, the host name that ends up inside emails, and the one password record the
 * tenancy layer writes without a password to go with it.
 *
 * Each of these was found by a full-codebase audit, and each test here fails against the code as it
 * was before the fix — which is the only kind of regression test worth writing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCookies } from '../src/auth.js';
import { hashPassword, hashToken, newToken, verifyPassword } from '../src/crypto.js';
import { createAttemptLimiter } from '../src/ratelimit.js';
import { claimInvite, createClient, createInvite, createRequest, filesForPractice, membersOf, recordUpload, removeMember, requestOwner } from '../src/store.js';
import { UNVERIFIABLE_PASSWORD_HASH } from '../src/tenancy/registry.js';
import { PASSWORD, createLink, practiceWithRequest, signUp, upload, withServer } from './helpers.js';

// --- CSV formula injection ---------------------------------------------------------------------

test('a CSV export refuses to hand a spreadsheet a formula to execute', async (t) => {
  await withServer(async ({ agent, db, base }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });

    // Two attacker-chosen strings: a client name (anybody a practice asks can end up being *typed*
    // like this by a hostile caller) and — the real one — a filename, which a client picks freely
    // on their own upload page.
    await client.post('/requests', {
      client: '=SUM(1,1)',
      title: 'Something else',
      items: 'One document',
    });

    const { token } = await createLink(client, requestId);
    await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: new TextEncoder().encode('hello'),
      filename: "=cmd|'/C calc'!A0",
    });

    const clients = (await (await client.get('/clients.csv')).text()).replace('\uFEFF', '');
    assert.ok(clients.includes(`'=SUM(1,1)`), `the client name is text, not a formula — got: ${clients}`);

    const files = (await (await client.get('/files.csv')).text()).replace('\uFEFF', '');
    assert.ok(files.includes(`'=cmd`), `the filename is text, not a formula — got: ${files}`);
  });
});

test('a CSV cell that needs no guard is left exactly as it was', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const csv = (await (await client.get('/clients.csv')).text()).replace('\uFEFF', '');
    assert.ok(csv.includes('Northwind Ltd'), 'an ordinary name is untouched');
    assert.ok(!csv.includes(`'Northwind`), 'and carries no guard apostrophe');
  });
});

// --- a cookie header that does not decode ---------------------------------------------------------

test('a malformed cookie is ignored rather than taking the page down with it', async (t) => {
  await withServer(async ({ base }) => {
    // `decodeURIComponent('%ZZ')` throws a URIError, and cookie parsing runs before every route.
    // Before the fix this answered 500 on every address; the right answer is "nobody is signed in".
    const response = await fetch(`${base}/`, { headers: { cookie: 'tickmark_session=%ZZ' } });
    assert.equal(response.status, 200, 'the home page still renders');
  });
});

test('parseCookies keeps an undecodable value raw instead of throwing', () => {
  const jar = parseCookies('a=%ZZ; b=plain');
  assert.equal(jar.a, '%ZZ', 'the raw value is kept, so it simply matches no token');
  assert.equal(jar.b, 'plain', 'and the rest of the header is parsed as usual');
});

// --- where a link in an email says it lives ---------------------------------------------------------

test('a configured public address wins over whatever host the request claims', async (t) => {
  await withServer(async ({ agent, db, base }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    // The notification a *client's* action triggers emails a link built from this origin, so a
    // client who forges the Host header must not be able to write the practice's next click.
    process.env.TICKMARK_PUBLIC_URL = 'https://practice.example/';
    try {
      const issued = await client.post(`/requests/${requestId}/link`, { days: '30' });
      const body = await issued.text();
      assert.ok(
        body.includes('https://practice.example/r/'),
        `the link is stamped with the configured address — got: ${body.slice(0, 400)}`,
      );
      assert.ok(!body.includes(`${new URL(base).host}/r/`), 'and not with the host the request arrived at');
    } finally {
      delete process.env.TICKMARK_PUBLIC_URL;
    }
  });
});

// --- the password record with no password ---------------------------------------------------

test('the fallback password record verifies against nothing a person would guess', async (t) => {
  assert.match(UNVERIFIABLE_PASSWORD_HASH, /^scrypt\$N=65536,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(UNVERIFIABLE_PASSWORD_HASH, 'scrypt$N=2,r=1,p=1$AAAA$AAAA', 'the old cheap placeholder is gone');
  for (const guess of [PASSWORD, '', 'password', 'scrypt', 'AAAA']) {
    assert.equal(await verifyPassword(guess, UNVERIFIABLE_PASSWORD_HASH), false, `"${guess}" does not open it`);
  }
});

// --- sign-up is priced, not free ---------------------------------------------------------

test('sign-up stops answering before it spends the machine\u2019s memory', async (t) => {
  await withServer(
    async ({ agent }) => {
      assert.equal((await signUp(agent(), 'one@practice.example')).status, 303, 'the first practice is created');
      assert.equal((await signUp(agent(), 'two@practice.example')).status, 303, 'and the second');
      // Every attempt counts — successful ones included — because the cost being defended is the
      // scrypt hash and the rows, not a wrong guess. Two buckets (the address and the caller) are
      // what stop one machine minting practices under sixty different emails.
      const third = await signUp(agent(), 'three@practice.example');
      assert.equal(third.status, 429, 'the third is held back');
    },
    { signUpLimiter: createAttemptLimiter({ limit: 2, windowMs: 60_000 }) },
  );
});

// --- one link, one small allowance ----------------------------------------------------------

test('a client link gets a small write allowance rather than an open tap', async (t) => {
  await withServer(
    async ({ base, agent, db }) => {
      const { client, requestId } = await practiceWithRequest({ agent, db });
      const { token } = await createLink(client, requestId);

      const say = (body) =>
        fetch(`${base}/r/${token}/message`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ body }).toString(),
        });

      assert.equal((await say('one')).status, 303, 'a message goes through');
      assert.equal((await say('two')).status, 303, 'and another');
      const third = await say('three');
      assert.equal(third.status, 429, 'then the link is asked to wait');
      assert.match(await third.text(), /a lot in the last minute/, 'and is told so rather than dropped quietly');
    },
    { clientLimiter: createAttemptLimiter({ limit: 2, windowMs: 60_000 }) },
  );
});

// --- one invitation, one member ---------------------------------------------------------

test('an invitation can only ever make one member', async (t) => {
  await withServer(async ({ agent, db }) => {
    await practiceWithRequest({ agent, db });
    const person = db.prepare('SELECT id, practice_id FROM practitioner LIMIT 1').get();
    const token = newToken();
    createInvite(db, {
      practiceId: person.practice_id,
      createdBy: person.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const hash = await hashPassword(PASSWORD);
    const first = claimInvite(db, { token, email: 'kim@practice.example', passwordHash: hash, wrappedPrivateKey: null });
    assert.equal(first.state, 'joined', 'the first caller joins');

    const second = claimInvite(db, { token, email: 'lee@practice.example', passwordHash: hash, wrappedPrivateKey: null });
    assert.ok(second.state !== 'joined' && second.state !== 'rejoined', `the second comes away with nothing (got ${second.state})`);
    assert.equal(membersOf(db, person.practice_id).length, 2, 'one practice member, plus the one who joined');
  });
});

// --- the documents list pages --------------------------------------------------------------

test('the documents list pages, and the export still gives everything', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { requestId, itemIds } = await practiceWithRequest({ agent, db });
    const practiceId = db.prepare('SELECT practice_id FROM request LIMIT 1').get().practice_id;
    // Rows made at the store layer: this is about the query's limit and offset, and three uploads
    // through the whole HTTP flow would only slow the test down.
    for (let index = 0; index < 3; index += 1) {
      recordUpload(db, {
        requestId,
        requestItemId: itemIds[0],
        filename: `file-${index}.bin`,
        sizeBytes: 10,
        sha256: 'x'.repeat(64),
        storagePath: `nothing/${index}.bin`,
      });
    }
    assert.equal(filesForPractice(db, practiceId, { limit: 2, offset: 0 }).length, 2, 'one page of two');
    assert.equal(filesForPractice(db, practiceId, { limit: 2, offset: 2 }).length, 1, 'and the remainder');
    assert.equal(filesForPractice(db, practiceId).length, 3, 'with no limit, the whole list — which is what the CSV takes');
  });
});

// --- a removed member stops being the one the practice hears from ---------------------------

test('a removed member is not the one told when their client does something', async (t) => {
  await withServer(async ({ agent, db }) => {
    await practiceWithRequest({ agent, db });
    const owner = db.prepare('SELECT id, email, practice_id FROM practitioner LIMIT 1').get();

    // Kim joins, asks a client for something, and then leaves the practice — the whole life of a
    // member in one test. Removal destroys their key copies and sessions, and the one thing that
    // used to outlive it was the notification: `requestOwner` answered with the creator's address
    // forever, so a removed member kept learning which client sent what.
    const token = newToken();
    createInvite(db, {
      practiceId: owner.practice_id,
      createdBy: owner.id,
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

    const clientId = createClient(db, { practiceId: owner.practice_id, createdBy: joined.practitionerId, name: 'Northwind Ltd' });
    const requestId = createRequest(db, {
      practiceId: owner.practice_id,
      createdBy: joined.practitionerId,
      clientId,
      title: '2025 return',
      items: ['Bank statements'],
    });
    assert.equal(requestOwner(db, requestId).id, joined.practitionerId, 'while they are here, the person who asked is the one told');

    removeMember(db, owner.practice_id, joined.practitionerId);
    const told = requestOwner(db, requestId);
    assert.equal(told.id, owner.id, 'once they are gone, somebody who can still act for the practice is told');
    assert.notEqual(told.email, 'kim@practice.example', 'and the removed member hears nothing more');
  });
});
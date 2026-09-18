/**
 * Removing a member, and the way back in.
 *
 * This is the last named gap in `docs/members.md`, and it was left unbuilt for two passes on purpose:
 * a button that looked like revocation of the past would be worse than no button. What is tested here is
 * therefore both halves of the honest claim —
 *
 * 1. **What it does.** Their key copies are destroyed, their sessions end, they cannot sign in, and an
 *    already-open session stops working.
 * 2. **What it does not do**, which is asserted as carefully: the row stays (so the history of who did
 *    what still points at a person), and the page that asks says out loud that a key they kept still
 *    opens under their passphrase.
 *
 * The third thing here is the surprising one: **an invitation brings a removed member back**, restoring
 * the same row. Without it the `UNIQUE` email column would mean somebody who left could never be invited
 * again at all — and the removal that was supposed to be about the future would quietly be about the
 * past.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decryptEnvelope,
  newInviteSecret,
  openInviteBytes,
  privateKeyBytesForTransfer,
  sealPrivateKey,
  unwrapPracticeKey,
  wrapBytesForInvite,
} from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memberIn, membersOf, removedMembersOf, removeMember } from '../src/store.js';

const SECOND = 'second@practice.example';
const SECOND_PASSPHRASE = 'the second passphrase, long enough';

/** The owner's browser: seal the key under a fresh secret and post only the blob. */
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

/** The newcomer's browser: open the blob with the fragment secret, re-seal, post that. */
async function acceptFromBrowser(client, token, secret, sealed, { email, password, passphrase }) {
  const wrapped = await sealPrivateKey(await openInviteBytes(sealed, secret), passphrase);
  return client.post(`/invite/${token}`, { email, password, wrapped_private_key: wrapped });
}

/** A practice whose second member joined through a real invitation, and holds a copy of the key. */
async function firmOfTwo({ agent, db }) {
  const firm = await practiceWithRequest({ agent, db });
  const keyId = db.prepare('SELECT id FROM practice_key').get().id;
  const made = await inviteFromBrowser(firm.client, {
    keyId,
    wrappedPrivateKey: firm.keys.wrappedPrivateKey,
    passphrase: firm.keys.passphrase,
  });
  const second = agent();
  const joined = await acceptFromBrowser(second, made.body.token, made.secret, made.sealed, {
    email: SECOND,
    password: 'a long enough password',
    passphrase: SECOND_PASSPHRASE,
  });
  if (joined.status !== 303) throw new Error(`the second member could not join: ${joined.status}`);
  const secondId = db.prepare('SELECT id FROM practitioner WHERE email = ?').get(SECOND).id;
  return { ...firm, second, secondId, keyId };
}

test('removing a member ends their access, destroys their copies, and keeps the record', async () => {
  await withServer(async ({ agent, base, db }) => {
    const firm = await firmOfTwo({ agent, db });

    // A document, so the second member has something they demonstrably could open.
    const link = await createLink(firm.client, firm.requestId);
    await upload({
      base,
      token: link.token,
      itemId: firm.itemIds[0],
      publicKey: firm.keys.publicKey,
      plaintext: Buffer.from('the bank statement'),
      filename: 'statement.pdf',
    });

    assert.equal((await firm.second.get('/requests')).status, 200, 'they are signed in and working');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE practitioner_id = ?').get(firm.secondId).n, 1);

    // The page that asks says all three things before anything happens.
    const asked = await firm.client.get(`/members/${firm.secondId}/remove`);
    const askedHtml = await asked.text();
    assert.equal(asked.status, 200);
    assert.match(askedHtml, /Remove second@practice\.example\?/, 'it names them');
    assert.match(askedHtml, /destroys their 1 copy of this practice's keys/, 'it says what will be destroyed');
    assert.match(askedHtml, /ends their 1 session/, 'and what will end');
    assert.match(
      askedHtml,
      /does not take back what they already have/,
      'and the thing the whole feature was held back for: it is not revocation of the past',
    );
    assert.match(askedHtml, /An invitation is how they would come back/, 'and how they would come back');

    const removed = await firm.client.post(`/members/${firm.secondId}/remove`, {});
    assert.equal(removed.status, 303);
    assert.equal(removed.headers.get('location'), `/members?removed=${encodeURIComponent(SECOND)}`);

    // What it did.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE practitioner_id = ?').get(firm.secondId).n,
      0,
      'their copies of the keys are gone',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM session WHERE practitioner_id = ?').get(firm.secondId).n,
      0,
      'their sessions are gone',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM practitioner WHERE id = ?').get(firm.secondId).n,
      1,
      'and the row stays, because the history of who did what points at it',
    );

    // A session that was already open stops working, which is the difference between signing out and
    // being removed.
    const after = await firm.second.get('/requests');
    assert.notEqual(after.status, 200, 'the open session no longer works');
    assert.equal(after.headers.get('location'), '/signin', 'they are sent to sign in, which they cannot do');

    // Signing in again is refused, and says why — after the password, not before.
    const again = await firm.second.post('/signin', { email: SECOND, password: 'a long enough password' });
    assert.equal(again.status, 403, 'refused with the password right');
    assert.match(
      await again.text(),
      /was removed from its practice on \d{4}-\d{2}-\d{2}/,
      'and told when, which is a fact about them and not a secret',
    );

    // The practice carries on, and the members page shows both questions separately.
    assert.equal((await firm.client.get('/requests')).status, 200, 'the practice still works');
    const page = await (await firm.client.get('/members')).text();
    assert.match(page, /One person\s+in this practice/, 'the member list counts current members only');
    assert.match(page, /<h2>Removed<\/h2>/, 'and former members have their own heading');
    assert.match(page, /No longer members/, 'with a sentence saying what the list is');
  });
});

test('a wrong password tells a removed member nothing', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await firmOfTwo({ agent, db });
    await firm.client.post(`/members/${firm.secondId}/remove`, {});

    const wrong = await firm.second.post('/signin', { email: SECOND, password: 'not their password' });
    const body = await wrong.text();
    assert.equal(wrong.status, 401, 'the same status as any other wrong password');
    assert.match(body, /do not match an account/);
    assert.ok(
      !/was removed/.test(body),
      'and nothing about the account — answering before the password would let anyone test who once worked here',
    );
  });
});

test('removing yourself is refused, and the store refuses the last member', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await firmOfTwo({ agent, db });
    const ownerId = db.prepare('SELECT id FROM practitioner WHERE email = ?').get('sam@practice.example').id;

    const mine = await firm.client.post(`/members/${ownerId}/remove`, {});
    assert.equal(mine.status, 400);
    assert.match(await mine.text(), /cannot remove yourself/, 'the act is for somebody who has left');
  });

  // The last-member guard, which **the UI cannot reach**: the only member is necessarily the person
  // asking, and removing yourself is refused first. So the two rules overlap, and this is where the
  // second one is exercised — where it matters, which is anybody calling the store directly.
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-last-'));
  const db = openDatabase(join(directory, 'tickmark.db'));
  try {
    db.prepare('INSERT INTO practice (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'A firm', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO practitioner (id, email, password_hash, created_at, practice_id) VALUES (?, ?, ?, ?, ?)').run(
      'm1',
      'alone@practice.example',
      'x',
      '2026-01-01T00:00:00.000Z',
      'p1',
    );

    assert.deepEqual(removeMember(db, 'p1', 'm1'), { state: 'last-member' });
    assert.equal(
      db.prepare('SELECT removed_at FROM practitioner WHERE id = ?').get('m1').removed_at,
      null,
      'and nothing happened, because a practice with nobody in it could never be signed in to again',
    );
    assert.equal(membersOf(db, 'p1').length, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a removal aimed at the wrong practice is nothing, and doing it twice is nothing', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await firmOfTwo({ agent, db });
    const other = await practiceWithRequest({ agent, db }, 'other@practice.example');
    const otherPerson = db.prepare('SELECT id FROM practitioner WHERE email = ?').get('other@practice.example').id;

    // The confirm page and the act both refuse a member of somebody else's practice.
    assert.equal((await firm.client.get(`/members/${otherPerson}/remove`)).status, 404, 'the page');
    assert.equal((await firm.client.post(`/members/${otherPerson}/remove`, {})).status, 404, 'the act');
    assert.equal(
      db.prepare('SELECT removed_at FROM practitioner WHERE id = ?').get(otherPerson).removed_at,
      null,
      'and nothing happened to them',
    );
    assert.equal((await other.client.get('/requests')).status, 200, 'their practice is untouched');

    // Twice is a 404 rather than a second removal: the second attempt is not a member any more.
    assert.equal((await firm.client.post(`/members/${firm.secondId}/remove`, {})).status, 303);
    assert.equal((await firm.client.post(`/members/${firm.secondId}/remove`, {})).status, 404);
  });
});

test('the page warns when the person being removed is the last who can open the newest files', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await firmOfTwo({ agent, db });

    // Rotate: the owner gets a copy of the new key and the second member does not, so the owner is the
    // only person who can open anything encrypted to it.
    const rotated = await firm.client.post('/setup', {
      public_key: JSON.stringify(firm.keys.publicKey),
      wrapped_private_key: firm.keys.wrappedPrivateKey,
    });
    assert.equal(rotated.status, 303, 'the key was rotated');

    const ownerId = db.prepare('SELECT id FROM practitioner WHERE email = ?').get('sam@practice.example').id;
    const warned = await (await firm.second.get(`/members/${ownerId}/remove`)).text();
    assert.match(
      warned,
      /last person who can open the files encrypted to the\s+newest key/,
      'the warning a practice would want before the act rather than after it',
    );

    // And it is a warning rather than a refusal: removal needs no key.
    assert.equal((await firm.second.post(`/members/${ownerId}/remove`, {})).status, 303);
  });
});

test('an invitation brings a removed member back, on the same row', async () => {
  await withServer(async ({ agent, base, db }) => {
    const firm = await firmOfTwo({ agent, db });
    const link = await createLink(firm.client, firm.requestId);
    await upload({
      base,
      token: link.token,
      itemId: firm.itemIds[0],
      publicKey: firm.keys.publicKey,
      plaintext: Buffer.from('a document from before they left'),
      filename: 'statement.pdf',
    });

    const practiceId = db.prepare('SELECT practice_id FROM practitioner WHERE id = ?').get(firm.secondId).practice_id;
    await firm.client.post(`/members/${firm.secondId}/remove`, {});
    assert.notEqual(memberIn(db, practiceId, firm.secondId).removed_at, null, 'they are removed');

    // The owner invites them again. The same email — which only works because the invitation restores
    // the row instead of inserting one, the email column being UNIQUE.
    const made = await inviteFromBrowser(firm.client, {
      keyId: firm.keyId,
      wrappedPrivateKey: firm.keys.wrappedPrivateKey,
      passphrase: firm.keys.passphrase,
    });
    assert.equal(made.response.status, 201, 'the invitation was made');

    const back = agent();
    const rejoined = await acceptFromBrowser(back, made.body.token, made.secret, made.sealed, {
      email: SECOND,
      password: 'a brand new password, long enough',
      passphrase: SECOND_PASSPHRASE,
    });
    assert.equal(rejoined.status, 303, 'and accepted');
    assert.equal(rejoined.headers.get('location'), '/requests', 'signing them in');

    assert.equal(
      db.prepare('SELECT id FROM practitioner WHERE email = ?').get(SECOND).id,
      firm.secondId,
      'the same row, so every request and file they ever touched still points at the same person',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 2, 'and no duplicate person');
    assert.equal(
      db.prepare('SELECT removed_at FROM practitioner WHERE id = ?').get(firm.secondId).removed_at,
      null,
      'the removal is cleared',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE practitioner_id = ?').get(firm.secondId).n,
      1,
      'with a fresh copy of the key, the one the invitation carried',
    );

    // The part that matters: back at work, opening the document that predates all of it.
    assert.equal((await back.get('/requests')).status, 200);
    const uploadId = db.prepare('SELECT id FROM upload').get().id;
    const fetched = await back.get(`/requests/${firm.requestId}/files/${uploadId}`);
    assert.equal(fetched.status, 200, 'they can fetch it');
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    const theirRecord = db
      .prepare('SELECT wrapped_private_key FROM key_wrapping WHERE practitioner_id = ?')
      .get(firm.secondId).wrapped_private_key;
    assert.equal(
      new TextDecoder().decode(await decryptEnvelope(await unwrapPracticeKey(theirRecord, SECOND_PASSPHRASE), bytes)),
      'a document from before they left',
      'and open it with the passphrase they sealed their new copy under',
    );

    // The members page counts them as a member again, and no longer lists anybody as removed.
    const page = await (await firm.client.get('/members')).text();
    assert.match(page, /2 people\s+in this practice/);
    assert.ok(!/<h2>Removed<\/h2>/.test(page), 'the removed section is gone, because nobody is removed');
  });
});

test('an invitation to somebody in another practice is still refused', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await firmOfTwo({ agent, db });
    const other = await practiceWithRequest({ agent, db }, 'other@practice.example');

    // A real invitation from the other practice, for its own key.
    const otherKeyId = db
      .prepare(
        `SELECT k.id FROM practice_key k JOIN practitioner p ON p.practice_id = k.practice_id
          WHERE p.email = ? ORDER BY k.created_at DESC LIMIT 1`,
      )
      .get('other@practice.example').id;
    const made = await inviteFromBrowser(other.client, {
      keyId: otherKeyId,
      wrappedPrivateKey: other.keys.wrappedPrivateKey,
      passphrase: other.keys.passphrase,
    });
    assert.equal(made.response.status, 201);

    // A member of the *first* practice is not "coming back" to the second one.
    const impostor = agent();
    const refused = await acceptFromBrowser(impostor, made.body.token, made.secret, made.sealed, {
      email: SECOND,
      password: 'a long enough password',
      passphrase: SECOND_PASSPHRASE,
    });
    assert.equal(refused.status, 200, 'the invitation page is shown again, with the reason');
    assert.match(await refused.text(), /already an account for that email address/);
    assert.equal(
      db.prepare('SELECT practice_id FROM practitioner WHERE email = ?').get(SECOND).practice_id,
      db.prepare('SELECT practice_id FROM practitioner WHERE email = ?').get('sam@practice.example').practice_id,
      'and they are still in the practice they were in',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE practitioner_id = ?').get(firm.secondId).n,
      1,
      'with no extra copy of anybody else key',
    );
  });
});

test('the store refuses a person from another practice, and a practice that does not exist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-removal-'));
  const db = openDatabase(join(directory, 'tickmark.db'));
  try {
    assert.deepEqual(removeMember(db, 'no-such-practice', 'no-such-person'), { state: 'not-found' });
    assert.deepEqual(membersOf(db, 'no-such-practice'), []);
    assert.deepEqual(removedMembersOf(db, 'no-such-practice'), []);
    assert.equal(memberIn(db, 'no-such-practice', 'no-such-person'), null);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a database that predates the removal column gets it, and nobody in it is considered removed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-removal-col-'));
  const file = join(directory, 'tickmark.db');
  try {
    // The table as the previous release created it: `practitioner`, with no `removed_at`.
    //
    // Built by hand rather than by dropping the column from a database written by this version, and that
    // is not a stylistic preference. `ALTER TABLE … DROP COLUMN` **fails on the declared floor** — Node
    // 24's SQLite 3.49.1 answers `error in table practitioner after drop column: incomplete input`,
    // because the column's comment lives inside the stored schema text, and rewriting that text trips
    // older SQLite. Node 26's SQLite 3.53.3 manages it. That difference cost an hour: the throw skipped
    // `close()`, the handle stayed open, and the `EPERM` from the cleanup hid the actual error. Writing
    // the old table is portable, and it is also more faithful — this is the shape the previous release
    // wrote, rather than something simulated by removing a column.
    const older = new DatabaseSync(file);
    try {
      older.exec(`
        CREATE TABLE practice (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE practitioner (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL, practice_id TEXT REFERENCES practice(id)
        );
      `);
      older.prepare('INSERT INTO practice (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'A firm', '2026-01-01T00:00:00.000Z');
      older
        .prepare('INSERT INTO practitioner (id, email, password_hash, created_at, practice_id) VALUES (?, ?, ?, ?, ?)')
        .run('m1', 'sam@practice.example', 'a hash', '2026-01-01T00:00:00.000Z', 'p1');
    } finally {
      older.close();
    }

    const again = openDatabase(file);
    try {
      assert.equal(
        again.prepare('SELECT removed_at FROM practitioner WHERE id = ?').get('m1').removed_at,
        null,
        'the column is there, and null — a database with no removals in it has none',
      );
      assert.equal(
        again.prepare('SELECT email FROM practitioner WHERE id = ?').get('m1').email,
        'sam@practice.example',
        'the row survived the migration',
      );
      assert.equal(membersOf(again, 'p1').length, 1, 'and everybody in it is a member');
      assert.deepEqual(removedMembersOf(again, 'p1'), []);
    } finally {
      again.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
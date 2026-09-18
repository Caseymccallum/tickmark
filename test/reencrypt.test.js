/**
 * Moving a practice's files onto its current key, so an old key can be retired.
 *
 * This is the only operation in the product that rewrites a stored document, and it is the thing that makes
 * "a key can be deleted" true rather than aspirational. What is asserted here is mostly about the ways it
 * could lose a document: a re-seal that does not decode back, a row that moves without its bytes, a key
 * retired while something still needs it.
 *
 * The browser half is exercised through the module the browser uses — `encryptFile`, `decryptEnvelope`,
 * `unwrapPracticeKey` — rather than through a browser. That is the same crypto, and it is what makes the
 * pass testable at all; what a browser adds is only that the private key never leaves it, which is a
 * property of `web/reencrypt.js` and of the endpoints refusing anything that is not an envelope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db.js';
import { filesPerKey, uploadsSealedTo } from '../src/store.js';
import { decryptEnvelope, encryptFile, unwrapPracticeKey } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, setUpKey, upload, withServer } from './helpers.js';

const PASSPHRASE = 'a passphrase long enough';
const FRESH = 'the second passphrase long enough';

/** The ids of a practice's keys, oldest first. */
const keyIds = (db) =>
  db.prepare('SELECT id FROM practice_key ORDER BY created_at, rowid').all().map((row) => row.id);

/**
 * The key a file would be sealed to right now — passed with every upload here.
 *
 * An upload that names no key is recorded as "which key? not known", and a pass that works from that record
 * skips it. That is not hypothetical: these tests were written without it first, and every file was
 * invisible to the move, which took a few failures to see because a file with no key at all looks a lot like
 * a file on some other key.
 */
const currentKeyId = (db) => keyIds(db).at(-1);

/** The message inside a refusal page, which is where the server's reason is. */
const words = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * One turn of the pass, done the way the browser does it.
 *
 * Fetch the pending list, take the first file, open it with the old private key, seal it to the current
 * public key, check the round trip, post it. Returns what happened, so a test can assert on it.
 */
async function moveOne({ client, base, oldKeyId, newKeyId, newPublicKey, newWrapped, wrappedOld, passphrase, newPassphrase = passphrase }) {
  const listed = await client.get(`/keys/${oldKeyId}/pending`);
  const { files } = await listed.json();
  if (files.length === 0) return { moved: null };

  // Two keys, because re-sealing needs both: the old private key to open what is stored, and the current
  // private key to check the result. The first version of this used the old key for both — so the round-trip
  // check was opening a new-key envelope with an old-key private key and failing every time. That is not a
  // test artefact: `web/reencrypt.js` had the same line, and the pass could never have completed.
  const privateKey = await unwrapPracticeKey(wrappedOld, passphrase);
  const currentPrivateKey = await unwrapPracticeKey(newWrapped, newPassphrase);

  const file = files[0];
  const response = await client.get(file.url);
  const envelope = new Uint8Array(await response.arrayBuffer());
  const plaintext = await decryptEnvelope(privateKey, envelope);
  const resealed = await encryptFile(newPublicKey, plaintext);
  const roundTrip = await decryptEnvelope(currentPrivateKey, resealed);

  const posted = await fetch(`${base}/files/${file.id}/reencrypt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-key-id': newKeyId,
      cookie: client.cookie,
    },
    body: resealed,
  });

  return { moved: file, plaintext, roundTrip: new Uint8Array(roundTrip), resealed, response: posted, files };
}

test('a file sealed to an old key is moved to the current one, byte for byte', async (t) => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    // The agent practiceWithRequest made is the signed-in one. A fresh agent() here would have its own
    // empty cookie jar, so every post below would come from a signed-out visitor, and the setup route
    // answers a signed-out visitor with a redirect that the helper counts as success. The rotation would
    // silently not happen and the test would be measuring nothing.
    const client = practice.client;
    const { token } = await createLink(practice.client, practice.requestId);
    const practiceId = db.prepare('SELECT practice_id FROM practitioner').get().practice_id;

    const document = Buffer.from('Northwind bank statement, Q1 — with an accent é');
    await upload({ base, token, itemId: practice.itemIds[0], publicKey: practice.keys.publicKey, plaintext: document, headers: { 'x-key-id': currentKeyId(db) } });
    await upload({ base, token, itemId: practice.itemIds[1], publicKey: practice.keys.publicKey, plaintext: Buffer.from('photo id'), headers: { 'x-key-id': currentKeyId(db) } });

    const [firstKey] = keyIds(db);
    const rotated = await setUpKey(client, FRESH);
    const currentKey = keyIds(db).at(-1);
    assert.notEqual(currentKey, firstKey, 'a rotation really did happen');

    assert.equal(filesPerKey(db, practiceId).get(firstKey), 2, 'both files start on the old key');
    assert.equal(filesPerKey(db, practiceId).get(currentKey), undefined, 'and none on the new one');

    const moved = await moveOne({
      client, base, oldKeyId: firstKey, newKeyId: currentKey, newPublicKey: rotated.publicKey, wrappedOld: practice.keys.wrappedPrivateKey, passphrase: PASSPHRASE, newWrapped: rotated.wrappedPrivateKey, newPassphrase: FRESH,
    });

    assert.equal(moved.response.status, 200, 'the pass accepted the re-sealed envelope');
    assert.deepEqual(
      moved.roundTrip,
      new Uint8Array(moved.plaintext),
      'the re-sealed copy opens back to the same document, which is the check the server cannot make',
    );

    // One file has moved; the other has not, and the count says so. This *is* the resume state.
    assert.equal(filesPerKey(db, practiceId).get(currentKey), 1);
    assert.equal(filesPerKey(db, practiceId).get(firstKey), 1);
    assert.equal(uploadsSealedTo(db, firstKey, practiceId).length, 1, 'the pending list is the progress');

    const second = await moveOne({
      client, base, oldKeyId: firstKey, newKeyId: currentKey, newPublicKey: rotated.publicKey, wrappedOld: practice.keys.wrappedPrivateKey, passphrase: PASSPHRASE, newWrapped: rotated.wrappedPrivateKey, newPassphrase: FRESH,
    });
    assert.equal(second.response.status, 200);
    assert.equal(filesPerKey(db, practiceId).get(firstKey), undefined, 'nothing is left on the old key');

    const pending = await (await client.get(`/keys/${firstKey}/pending`)).json();
    assert.deepEqual(pending.files, [], 'and the next turn of the loop has nothing to do');

    const events = db.prepare("SELECT detail FROM event WHERE kind = 'upload.re-encrypted'").all();
    assert.equal(events.length, 2, 'each move is recorded against the request it belongs to');
    assert.match(events[0].detail, /moved to a newer key/);
  });
});

test('a file moved twice, or a body that is not an envelope, is refused', async (t) => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    // The agent practiceWithRequest made is the signed-in one. A fresh agent() here would have its own
    // empty cookie jar, so every post below would come from a signed-out visitor, and the setup route
    // answers a signed-out visitor with a redirect that the helper counts as success. The rotation would
    // silently not happen and the test would be measuring nothing.
    const client = practice.client;
    const { token } = await createLink(practice.client, practice.requestId);

    await upload({ base, token, itemId: practice.itemIds[0], publicKey: practice.keys.publicKey, plaintext: Buffer.from('bank statements'), headers: { 'x-key-id': currentKeyId(db) } });
    const [firstKey] = keyIds(db);
    const rotated = await setUpKey(client, FRESH);
    const currentKey = keyIds(db).at(-1);

    const first = await moveOne({
      client, base, oldKeyId: firstKey, newKeyId: currentKey, newPublicKey: rotated.publicKey, wrappedOld: practice.keys.wrappedPrivateKey, passphrase: PASSPHRASE, newWrapped: rotated.wrappedPrivateKey, newPassphrase: FRESH,
    });
    assert.equal(first.response.status, 200);

    // The same file, moved again to the same key: nothing to do, and saying so beats a second rewrite of a
    // document that is already where it belongs.
    const again = await fetch(`${base}/files/${first.moved.id}/reencrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-key-id': currentKey, cookie: client.cookie },
      body: first.resealed,
    });
    assert.equal(again.status, 400, 'moving an already-moved file is refused, not repeated');
    assert.match(words(await again.text()), /already sealed to that key/);

    // A body that is not an envelope. This refusal matters most: a broken re-seal on the browser side must
    // not be able to replace a good document with rubbish.
    const junk = await fetch(`${base}/files/${first.moved.id}/reencrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-key-id': currentKey, cookie: client.cookie },
      body: Buffer.from('this is not an envelope'),
    });
    assert.equal(junk.status, 400);
    assert.match(words(await junk.text()), /Only an encrypted file can replace an encrypted file/);

    // And the document survives both refusals untouched.
    const practiceId = db.prepare('SELECT practice_id FROM practitioner').get().practice_id;
    assert.equal(filesPerKey(db, practiceId).get(currentKey), 1);
  });
});

test('a key that still opens something cannot be retired, and says how much', async (t) => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    // The agent practiceWithRequest made is the signed-in one. A fresh agent() here would have its own
    // empty cookie jar, so every post below would come from a signed-out visitor, and the setup route
    // answers a signed-out visitor with a redirect that the helper counts as success. The rotation would
    // silently not happen and the test would be measuring nothing.
    const client = practice.client;
    const { token } = await createLink(practice.client, practice.requestId);

    await upload({ base, token, itemId: practice.itemIds[0], publicKey: practice.keys.publicKey, plaintext: Buffer.from('bank statements'), headers: { 'x-key-id': currentKeyId(db) } });
    const [firstKey] = keyIds(db);
    await setUpKey(client, FRESH);

    // The current key: new files are sealed to it, so retiring it would leave nothing to receive with.
    const currentKey = keyIds(db).at(-1);
    const onCurrent = await client.post(`/keys/${currentKey}/retire`, { confirm: 'retire' });
    assert.equal(onCurrent.status, 400, 'the current key is refused');
    assert.match(words(await onCurrent.text()), /That is the current key/);

    // The old one, which is holding the file.
    const holding = await client.post(`/keys/${firstKey}/retire`, { confirm: 'retire' });
    assert.equal(holding.status, 400, 'a key that still opens a file is refused');
    const refusal = words(await holding.text());
    assert.match(refusal, /still opens 1 file/);
    assert.match(refusal, /Move it to a newer key first/);

    // The word has to be typed: a button alone does not make somebody read what it does.
    const untyped = await client.post(`/keys/${firstKey}/retire`, { confirm: '' });
    assert.equal(untyped.status, 400, 'the word has to be typed');
    assert.match(words(await untyped.text()), /The word has to be typed/);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE key_id = ?').get(firstKey).n,
      1,
      'and nothing was destroyed by a refusal',
    );
  });
});

test('retiring a key destroys its copies and keeps the record', async (t) => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    // The agent practiceWithRequest made is the signed-in one. A fresh agent() here would have its own
    // empty cookie jar, so every post below would come from a signed-out visitor, and the setup route
    // answers a signed-out visitor with a redirect that the helper counts as success. The rotation would
    // silently not happen and the test would be measuring nothing.
    const client = practice.client;
    const { token } = await createLink(practice.client, practice.requestId);

    await upload({ base, token, itemId: practice.itemIds[0], publicKey: practice.keys.publicKey, plaintext: Buffer.from('bank statements'), headers: { 'x-key-id': currentKeyId(db) } });
    const [firstKey] = keyIds(db);
    const rotated = await setUpKey(client, FRESH);
    const currentKey = keyIds(db).at(-1);

    await moveOne({
      client, base, oldKeyId: firstKey, newKeyId: currentKey, newPublicKey: rotated.publicKey, wrappedOld: practice.keys.wrappedPrivateKey, passphrase: PASSPHRASE, newWrapped: rotated.wrappedPrivateKey, newPassphrase: FRESH,
    });

    const retired = await client.post(`/keys/${firstKey}/retire`, { confirm: 'retire' });
    assert.equal(retired.status, 303);

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE key_id = ?').get(firstKey).n,
      0,
      'the wrapped copies are gone, which is what makes it able to open nothing',
    );
    const row = db.prepare('SELECT public_key, deleted_at FROM practice_key WHERE id = ?').get(firstKey);
    assert.ok(row, 'the row stays, because a record does not lose a row');
    assert.ok(row.deleted_at, 'and it carries the date it was retired');
    assert.ok(row.public_key, 'with the public half, which is the part that identifies what it opened');

    // Retiring it again would make the date meaningless.
    const twice = await client.post(`/keys/${firstKey}/retire`, { confirm: 'retire' });
    assert.equal(twice.status, 400);
    assert.match(words(await twice.text()), /already been retired/);

    // Followed the way a browser does: the redirect target carries the id of the key that was just retired,
    // and that is what puts the confirmation on the page.
    const target = retired.headers.get('location');
    assert.match(target, /^\/keys\?retired=/, 'the redirect says which key it was');
    const page = await (await client.get(target)).text();
    assert.match(page, /Retired keys/);
    assert.match(page, /its copies were destroyed, so it opens nothing/);
    assert.match(page, /Retired\./, 'and the confirmation says what happened');
    assert.equal(
      [...page.matchAll(/name="old"/g)].length,
      1,
      'only the live key has a passphrase form — no control that cannot work',
    );
  });
});
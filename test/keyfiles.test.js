/**
 * Which key a file was sealed to, and what that record is for.
 *
 * Nothing about an envelope's bytes says which key it was made for — the header carries the *ephemeral*
 * key, not the recipient. So the browser that encrypts says which practice key it used, and the server
 * checks the claim against the practice before recording it.
 *
 * The record exists for one reason: a rotated key cannot be discarded while anything is still sealed to
 * it, and before this column the only answer to "can we throw this key away?" was "keep it forever and
 * hope". These tests are about the answer being *right* rather than merely present, because a files
 * count that is wrong in the optimistic direction loses documents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, newId } from '../src/db.js';
import {
  addPracticeKey,
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  filesPerKey,
  itemsOf,
  recordUpload,
} from '../src/store.js';
import { generatePracticeKey } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

const PASSPHRASE = 'a passphrase long enough for a test';

/** A practice with one member, a key, a request, and an item to hang uploads off. */
async function firm(db, { name = 'Northwind', email = 'sam@practice.example' } = {}) {
  const practiceId = createPractice(db, { name });
  const person = createPractitioner(db, { practiceId, email, passwordHash: 'x' });
  const key = await generatePracticeKey(PASSPHRASE);
  const keyId = addPracticeKey(db, practiceId, {
    publicKey: key.publicKey,
    wrappedPrivateKey: key.wrappedPrivateKey,
    createdBy: person,
  });
  const clientId = createClient(db, { practiceId, createdBy: person, name: 'Northwind Ltd' });
  const requestId = createRequest(db, {
    practiceId,
    createdBy: person,
    clientId,
    title: '2025 return',
    items: ['Bank statements', 'Photo ID'],
  });

  return { practiceId, person, keyId, key, requestId, itemId: itemsOf(db, requestId)[0].id };
}

/** An upload row, without going through HTTP: the store's own contract. */
function anUpload(db, { requestId, itemId, keyId }) {
  const id = newId();
  recordUpload(db, {
    id,
    requestId,
    requestItemId: itemId,
    filename: `${id}.pdf`,
    sizeBytes: 100,
    sha256: 'a'.repeat(64),
    storagePath: `/tmp/${id}.bin`,
    keyId,
  });
  return id;
}

/** A standalone in-memory database for one test. */
function memoryDb(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

test('files are counted against the key they were sealed to', async (t) => {
  const db = memoryDb(t);
  const { practiceId, keyId, person, requestId, itemId } = await firm(db);

  anUpload(db, { requestId, itemId, keyId });
  anUpload(db, { requestId, itemId, keyId });
  assert.equal(filesPerKey(db, practiceId).get(keyId), 2, 'two files, both sealed to the key that was current');

  // A second key: the old one now holds two and the new one holds one, which is precisely the number
  // that decides whether the old key can be discarded.
  const key2 = await generatePracticeKey(PASSPHRASE);
  const newer = addPracticeKey(db, practiceId, {
    publicKey: key2.publicKey,
    wrappedPrivateKey: key2.wrappedPrivateKey,
    createdBy: person,
  });
  anUpload(db, { requestId, itemId, keyId: newer });

  const after = filesPerKey(db, practiceId);
  assert.equal(after.get(keyId), 2, 'the older key still holds the two files it always did');
  assert.equal(after.get(newer), 1);
});

test('a file whose key is not known is counted as unknown, not as zero', async (t) => {
  const db = memoryDb(t);
  const { practiceId, keyId, requestId, itemId } = await firm(db);

  anUpload(db, { requestId, itemId, keyId });
  anUpload(db, { requestId, itemId, keyId: null });

  const counts = filesPerKey(db, practiceId);
  assert.equal(counts.get(keyId), 1, 'the known one is counted');
  assert.equal(counts.get(null), 1, 'and the unknown one is reported as unknown, not folded into a key');

  // The distinction matters in the direction that loses documents: treating a missing key as zero would
  // say a key holds nothing, and a practice that believed that would throw away the key that opens this
  // file. `undefined` is "no files", `null` is "not known" — two different facts.
  assert.equal(counts.get(newId()), undefined, 'a key with no files has no entry at all, which is not the same as zero');
});

test('the count is per practice, not per installation', async (t) => {
  const db = memoryDb(t);
  const first = await firm(db, { name: 'Northwind', email: 'sam@practice.example' });
  const second = await firm(db, { name: 'Elsewhere', email: 'other@elsewhere.example' });

  anUpload(db, { requestId: second.requestId, itemId: second.itemId, keyId: second.keyId });

  assert.equal(filesPerKey(db, second.practiceId).get(second.keyId), 1);
  assert.equal(
    filesPerKey(db, first.practiceId).get(second.keyId),
    undefined,
    "one practice's files are not counted against another's keys",
  );
});

test('a key belonging to another practice is not a valid claim for this request', async (t) => {
  const db = memoryDb(t);
  const mine = await firm(db, { name: 'Northwind', email: 'sam@practice.example' });
  const theirs = await firm(db, { name: 'Elsewhere', email: 'other@elsewhere.example' });

  // This is the query the upload handler runs before recording a key: the key and the request have to
  // agree about the practice. Without it, a client could claim a file belonged to a key it was not
  // sealed to, and the number that decides whether a key can be discarded would be wrong in the
  // direction that loses files.
  const check = db.prepare(
    `SELECT k.id FROM practice_key k JOIN request r ON r.practice_id = k.practice_id WHERE k.id = ? AND r.id = ?`,
  );

  assert.ok(check.get(mine.keyId, mine.requestId), "this practice's own key is accepted for its own request");
  assert.equal(check.get(theirs.keyId, mine.requestId), undefined, "another practice's key is refused for this request");
  assert.equal(check.get(mine.keyId, theirs.requestId), undefined, 'and the reverse is refused too');
});

test('an upload records the key the browser named, so a practice can see what each key holds', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const practiceId = db.prepare('SELECT practice_id FROM practitioner').get().practice_id;
    const currentKey = db
      .prepare('SELECT id FROM practice_key ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get().id;

    const { response } = await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('Northwind bank statement, Q1'),
      headers: { 'x-key-id': currentKey },
    });

    assert.equal(response.status, 201, 'the upload is accepted, key id and all');
    assert.equal(
      filesPerKey(db, practiceId).get(currentKey),
      1,
      'and the file is counted against the key the browser said it used',
    );
  });
});

test('an upload naming a key this practice does not have is refused, and nothing is written', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const practiceId = db.prepare('SELECT practice_id FROM practitioner').get().practice_id;

    const { response } = await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('Northwind bank statement, Q1'),
      headers: { 'x-key-id': newId() },
    });

    assert.equal(response.status, 400, 'a key this practice does not hold is a refusal, not a note in a column');
    assert.match(await response.text(), /key this practice does not have/);

    // Refused *before* the file is written: a rejected upload that left bytes on disk would be a file
    // nobody can account for, and the count that decides whether a key can be discarded would not see it.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upload').get().n, 0, 'no upload row was recorded');
    assert.equal(filesPerKey(db, practiceId).get(null), undefined, 'and nothing was filed under "not known" either');
  });
});

test('an upload that names no key still arrives, and is counted as unknown', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const practiceId = db.prepare('SELECT practice_id FROM practitioner').get().practice_id;

    // This is a real case rather than a hypothetical: a client can be holding a page from before the
    // practice's key record existed, and refusing their file because it did not announce which key
    // sealed it would lose a document to record a number.
    const { response } = await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('Northwind bank statement, Q1'),
    });

    assert.equal(response.status, 201, 'the file is accepted');
    assert.equal(
      filesPerKey(db, practiceId).get(null),
      1,
      'and counted as not-known rather than folded into whichever key happens to be current',
    );
  });
});
/**
 * The three ways a client can speak to a practice, and the two that used to have no route at all.
 *
 * Before this pass a client holding a link could do exactly two things: answer an item, or press one of two
 * fixed buttons saying they could not. Anything else — the VAT return nobody asked for, a covering letter,
 * "the statements are in the post" — left the product and became an ordinary email, in the clear, outside the
 * record. That is the one thing this product exists to replace, so these tests are about a promise rather
 * than a feature.
 *
 * The migration gets a test of its own because it is a table rebuild: `upload` had to learn which *request*
 * it belongs to, and it learned it from a join. A rebuild that loses a row loses a client's document, so the
 * backfill is asserted by value rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/db.js';
import {
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  history,
  itemsOf,
  recordUpload,
  uploadsOf,
} from '../src/store.js';
import { hashToken } from '../src/crypto.js';

test('the upload rebuild carries every file across, pointed at its request', async (t) => {
  // A rebuild is the one migration that can lose a client's document rather than merely annoy somebody, so it
  // is tested against the *previous* shape rather than trusted. The fixture is built by the current code and
  // then put back the way the last release had it — which isolates the rebuild from every other migration and
  // makes the old shape explicit in one place instead of a whole historical schema.
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-upload-rebuild-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'tickmark.db');

  const before = openDatabase(file);
  const practiceId = createPractice(before, { name: 'Lodis Accountancy' });
  const practitionerId = createPractitioner(before, {
    practiceId,
    email: 'sam@example.test',
    passwordHash: 'scrypt$placeholder',
  });
  const clientId = createClient(before, {
    practiceId,
    createdBy: practitionerId,
    name: 'Northwind Ltd',
    email: 'accounts@northwind.example',
  });
  const requestId = createRequest(before, {
    practiceId,
    createdBy: practitionerId,
    clientId,
    title: '2025 return',
    items: ['Bank statements', 'Photo ID'],
  });
  const [statements, photo] = itemsOf(before, requestId);
  const sample = (over) =>
    recordUpload(before, {
      requestId,
      filename: 'x.pdf',
      sizeBytes: 10,
      sha256: 'abc',
      storagePath: '/blobs/x.bin',
      at: '2026-09-01T00:00:00.000Z',
      ...over,
    });
  sample({ requestItemId: statements.id, filename: 'statements.pdf', sha256: 'one' });
  sample({ requestItemId: photo.id, filename: 'passport.pdf', sha256: 'two', clientNote: 'front and back' });
  before.close();

  // Back to the last release's shape: the request reachable only through the item, and an item required.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE upload_narrow (
      id              TEXT PRIMARY KEY,
      request_item_id TEXT NOT NULL REFERENCES request_item(id),
      filename        TEXT NOT NULL,
      mime            TEXT,
      size_bytes      INTEGER NOT NULL,
      sha256          TEXT NOT NULL,
      storage_path    TEXT NOT NULL,
      client_note     TEXT,
      uploaded_at     TEXT NOT NULL,
      key_id          TEXT REFERENCES practice_key(id)
    );
    INSERT INTO upload_narrow (id, request_item_id, filename, mime, size_bytes, sha256, storage_path, client_note, uploaded_at, key_id)
      SELECT id, request_item_id, filename, mime, size_bytes, sha256, storage_path, client_note, uploaded_at, key_id FROM upload;
    DROP TABLE upload;
    ALTER TABLE upload_narrow RENAME TO upload;
  `);
  old.close();

  const after = openDatabase(file);
  assert.equal(after.migratedUploads, 1, 'the rebuild ran');

  const rows = after
    .prepare('SELECT id, request_id, request_item_id, filename, sha256, client_note, storage_path FROM upload ORDER BY filename')
    .all();
  assert.equal(rows.length, 2, 'both files are still here — the count is what the rebuild refuses to get wrong');
  for (const row of rows) {
    assert.equal(row.request_id, requestId, `${row.filename} points at the request it arrived under`);
    assert.ok(row.request_item_id, 'and still answers the item it answered');
  }
  // Every value, not just the keys: a rebuild that carried the ids and dropped the hash would be a rebuild
  // that lost the ability to tell whether a file had been tampered with.
  const passport = rows.find((row) => row.filename === 'passport.pdf');
  assert.equal(passport.sha256, 'two', 'the digest came across');
  assert.equal(passport.client_note, 'front and back', "the client's note came across");
  assert.equal(passport.storage_path, '/blobs/x.bin', 'and so did the path to the bytes');
  after.close();

  // Idempotent: the guard is the column's presence, so a second open has nothing to do.
  const again = openDatabase(file);
  assert.equal(again.migratedUploads, 0, 'a second open rebuilds nothing');
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM upload').get().n, 2, 'and the files are still there');
  again.close();
});

import { encryptFile } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, withServer } from './helpers.js';

/** Post an encrypted file that answers no item — the client's own document. */
async function uploadExtra({ base, token, publicKey, plaintext, filename = 'extra.pdf', note = null }) {
  const envelope = await encryptFile(publicKey, plaintext);
  const response = await fetch(`${base}/r/${token}/extra`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(filename),
      ...(note === null ? {} : { 'x-note': encodeURIComponent(note) }),
    },
    body: envelope,
  });
  return { response, envelope };
}

test('a client can send a document nobody asked for, and the practice gets it', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    const { response } = await uploadExtra({
      base,
      token,
      publicKey: keys.publicKey,
      plaintext: Buffer.from('the VAT return, which nobody asked for'),
      filename: 'vat-return-q3.pdf',
      note: 'You may as well have this too',
    });
    assert.equal(response.status, 201, 'the file is accepted');
    assert.equal((await response.json()).extra, true, 'and the answer says which kind it was');

    // It is stored against the request and against no item.
    const [stored] = uploadsOf(db, requestId);
    assert.equal(stored.filename, 'vat-return-q3.pdf');
    assert.equal(stored.request_id, requestId, 'it belongs to the request it was sent to');
    assert.equal(stored.request_item_id, null, 'and to no checklist line, because it answers nothing');

    // The record says where it came from. `upload.extra` rather than `upload.received`, because "a file
    // arrived for a document we asked for" and "the client sent us something else" are different facts.
    const kinds = history(db, requestId).map((event) => event.kind);
    assert.ok(kinds.includes('upload.extra'), `the history says it was an extra: ${kinds.join(', ')}`);
    assert.ok(!kinds.includes('upload.received'), 'and does not claim an item was answered');

    // The practice can see it and open it. This is the assertion that would have failed on the first
    // version of the change: every read of an upload reached the request *through* its item, so a file
    // with no item was invisible — sent, stored, and impossible to find.
    const page = await (await client.get(`/requests/${requestId}`)).text();
    assert.match(page, /Sent without being asked/, 'the practice page has a place for it');
    assert.match(page, /vat-return-q3\.pdf/, 'and names the file');
    assert.match(page, /You may as well have this too/, "with the client's own note");

    const download = await client.get(`/requests/${requestId}/files/${stored.id}`);
    assert.equal(download.status, 200, 'and it can be downloaded');

    // It answers nothing, so nothing about the checklist moves.
    assert.match(page, /0 of 3 received/, 'the checklist is untouched — an extra is not an answer');
  });
});

test('an extra upload is held to the same rules as an answer', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    // A plaintext file is refused at the same door. The check is not "is this an answer"; it is "is this
    // something the server can read", and it has to hold for a document nobody asked for exactly as it
    // holds for one they did.
    const plain = await fetch(`${base}/r/${token}/extra`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'notes.pdf' },
      body: Buffer.from('%PDF-1.4 not encrypted at all'),
    });
    assert.equal(plain.status, 400, 'a readable file is refused');
    assert.match(await plain.text(), /Only encrypted uploads are accepted/);
    assert.equal(uploadsOf(db, requestId).length, 0, 'and nothing was stored');

    // A key the practice does not have is refused the same way, because that column is what decides whether
    // a key can ever be thrown away — a false answer is worse than none.
    const unknownKey = await fetch(`${base}/r/${token}/extra`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': 'y.pdf',
        'x-key-id': 'a-key-this-practice-does-not-have',
      },
      body: await encryptFile(keys.publicKey, Buffer.from('hello again')),
    });
    assert.equal(unknownKey.status, 400, 'an upload naming an unknown key is refused');
    assert.equal(uploadsOf(db, requestId).length, 0, 'and still nothing was stored');

    // A revoked link is a revoked link, whatever is being sent through it. Closing the request is
    // deliberately *not* this: a closed request keeps its link working, because closing is a status and the
    // client may still be holding the page with a document to send.
    // Revoked by digest rather than by "whatever token this request has", because the test has already made
    // one link and this is a second one — an unordered SELECT would have revoked the wrong link and left the
    // one under test working, which is exactly what happened the first time this was written.
    const { token: doomed } = await createLink(client, requestId);
    const tokenId = db.prepare('SELECT id FROM access_token WHERE token_hash = ?').get(hashToken(doomed)).id;
    const revoked = await client.post(`/requests/${requestId}/revoke`, { token_id: tokenId });
    assert.equal(revoked.status, 303, 'the link is revoked');

    const before = uploadsOf(db, requestId).length;
    const afterRevoke = await uploadExtra({
      base,
      token: doomed,
      publicKey: keys.publicKey,
      plaintext: Buffer.from('too late'),
      filename: 'late.pdf',
    });
    assert.equal(afterRevoke.response.status, 410, 'a revoked link refuses an extra too');
    assert.equal(uploadsOf(db, requestId).length, before, 'and stores nothing');
  });
});

test('a client can say something that is not a file', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    const anonymous = agent();

    const sent = await anonymous.post(`/r/${token}/message`, {
      body: '  The statements are in the post — the bank said five working days.  ',
    });
    assert.equal(sent.status, 303, 'the message is accepted');
    assert.equal(sent.headers.get('location'), `/r/${token}?said=1`, 'and the client is told so');

    // Their own words, kept verbatim apart from the trim.
    const [event] = history(db, requestId).filter((row) => row.kind === 'client.messaged');
    assert.ok(event, 'the history keeps it');
    assert.equal(event.detail, 'The statements are in the post — the bank said five working days.');

    const page = await (await client.get(`/requests/${requestId}`)).text();
    assert.match(page, /In the client&rsquo;s own words|In the client's own words/, 'the practice page shows it');
    assert.match(page, /the bank said five working days/, 'in the client’s own words');

    // And the client sees their own message back, the same reasoning as the receipt: it is their message
    // returning, so showing it discloses nothing that was not already theirs.
    const theirs = await (await anonymous.get(`/r/${token}`)).text();
    assert.match(theirs, /What you have told them/, 'the client can see what they said');
    assert.match(theirs, /the bank said five working days/);

    // The confirmation is on the page the redirect lands on, which is why it carries the query.
    const landed = await (await anonymous.get(`/r/${token}?said=1`)).text();
    assert.match(landed, /Message sent/, 'and the confirmation is on the page they land on');
  });
});

test('a message is refused when empty or too long, rather than cut', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    const anonymous = agent();
    const said = () => history(db, requestId).filter((row) => row.kind === 'client.messaged').length;

    const empty = await anonymous.post(`/r/${token}/message`, { body: '   ' });
    assert.equal(empty.status, 400, 'nothing in it is nothing to send');
    assert.match(await empty.text(), /nothing in that message/);
    assert.equal(said(), 0, 'and nothing was recorded');

    const long = await anonymous.post(`/r/${token}/message`, { body: 'x'.repeat(2001) });
    assert.equal(long.status, 400, 'over the limit is refused');
    assert.match(await long.text(), /longer than 2000 characters/);
    assert.equal(said(), 0, 'refused rather than truncated — a message whose end is missing is not theirs');

    const atLimit = await anonymous.post(`/r/${token}/message`, { body: 'y'.repeat(2000) });
    assert.equal(atLimit.status, 303, 'and exactly at the limit is fine');
    assert.equal(said(), 1);
  });
});

test('what a client writes is escaped, because it is their text on the practice’s page', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    await agent().post(`/r/${token}/message`, { body: '<script>alert(1)</script> and a & sign' });

    const page = await (await client.get(`/requests/${requestId}`)).text();
    assert.ok(!page.includes('<script>alert(1)</script>'), 'the tag is not live on the practice page');
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'it is shown as the text they typed');
  });
});

test('the practice’s contact details reach the client’s page, and only when given', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    const anonymous = agent();

    // Nothing given: no block at all rather than an empty one. A heading with nothing under it reads as a
    // page that is broken.
    const before = await (await anonymous.get(`/r/${token}`)).text();
    assert.ok(!before.includes('Asking the practice something'), 'no contact block when nothing is set');

    const saved = await client.post('/members/name', {
      name: 'Northwind & Co',
      contact_email: 'hello@northwind.example',
      contact_phone: '+44 20 7946 0000',
    });
    assert.equal(saved.status, 303, 'the details are saved');

    const after = await (await anonymous.get(`/r/${token}`)).text();
    assert.match(after, /Asking the practice something/, 'now there is a block');
    assert.match(after, /mailto:hello@northwind\.example/, 'the address is a live mailto');
    assert.match(after, /\+44 20 7946 0000/, 'and the phone number is shown');

    // A nonsense address is refused rather than rendered as a mailto: that does nothing.
    const bad = await client.post('/members/name', { name: 'Northwind & Co', contact_email: 'not-an-address' });
    assert.equal(bad.status, 400, 'a bad address is refused');
    assert.equal(
      db.prepare('SELECT contact_email FROM practice').get().contact_email,
      'hello@northwind.example',
      'and the good one is left alone',
    );

    // Clearing the address is expressed by posting it blank — and it must clear, not be ignored, or a
    // practice could never take a wrong address back off their clients' page.
    await client.post('/members/name', { name: 'Northwind & Co', contact_email: '' });
    assert.equal(db.prepare('SELECT contact_email FROM practice').get().contact_email, null, 'it can be cleared');
  });
});

test('a rename that does not mention the contact details leaves them alone', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    await client.post('/members/name', {
      name: 'Northwind & Co',
      contact_email: 'hello@northwind.example',
      contact_phone: '01234 567890',
      timezone: 'Europe/London',
    });

    // A partial post — an older page, a script, a test — must not wipe what it never mentioned. `field()`
    // answers `null` for "posted blank" *and* for "not posted", which is why the handler asks `hasOwn`
    // instead; this is the test that would fail if it went back to `!== undefined`.
    const renamed = await client.post('/members/name', { name: 'Northwind Books' });
    assert.equal(renamed.status, 303);

    const practice = db.prepare('SELECT name, timezone, contact_email, contact_phone FROM practice').get();
    assert.equal(practice.name, 'Northwind Books', 'the name changed');
    assert.equal(practice.timezone, 'Europe/London', 'and the zone survived a rename that did not mention it');
    assert.equal(practice.contact_email, 'hello@northwind.example', 'and so did the address');
    assert.equal(practice.contact_phone, '01234 567890', 'and the phone');
  });
});

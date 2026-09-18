/**
 * Keys: rotating one, changing a passphrase, and the migration that moved a practice's single key
 * into the history it is now.
 *
 * The claim these tests defend: **rotation cannot orphan a file.** Every file already stored is
 * encrypted to the key that was current when it arrived, and nothing re-encrypts it — so a practice
 * must still be able to open its history after making a new key, or the feature that exists to
 * protect it destroys its records instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/db.js';
import { decryptEnvelope, decryptWithKeys, rewrapPrivateKey, unwrapPracticeKey } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, setUpKey, signUp, upload, withServer } from './helpers.js';

/** The schema exactly as the first version wrote it, before keys became a history. */
const OLD_SCHEMA = `
CREATE TABLE practitioner (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  public_key TEXT, wrapped_private_key TEXT, created_at TEXT NOT NULL
);`;

const NEW_PASSPHRASE = 'a different passphrase';

test('the old single-key columns become a key in the history, and the columns go', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'tickmark.db');

  // A database as the earlier version left it: one practice, one key, in two columns.
  const before = new DatabaseSync(file);
  before.exec(OLD_SCHEMA);
  before
    .prepare(
      'INSERT INTO practitioner (id, email, password_hash, public_key, wrapped_private_key, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      'p1',
      'sam@practice.example',
      'scrypt$placeholder',
      '{"kty":"EC"}',
      'pbkdf2$sha-256$600000$AA$AAAAAAAAAAAAAAAA$AA',
      '2026-09-01T00:00:00.000Z',
    );
  before.close();

  const db = openDatabase(file);
  assert.equal(db.migratedKeys, 1, 'the migration reports carrying one key');

  const keys = db.prepare('SELECT * FROM practice_key').all();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].practitioner_id, 'p1');
  assert.equal(keys[0].public_key, '{"kty":"EC"}', 'the key itself is the one that was in the column');
  assert.equal(keys[0].created_at, '2026-09-01T00:00:00.000Z', 'and it keeps the date it was made');

  const columns = db.prepare("SELECT name FROM pragma_table_info('practitioner')").all().map((row) => row.name);
  assert.ok(!columns.includes('public_key'), 'the old columns are gone, so nothing can read a stale copy');
  assert.ok(!columns.includes('wrapped_private_key'));
  db.close();

  // Running it again does nothing, which is what makes it safe on every open.
  const again = openDatabase(file);
  assert.equal(again.migratedKeys, 0);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM practice_key').get().n, 1, 'and does not duplicate the key');
  again.close();
});

test('a new key does not orphan the files sent under the old one', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('sent under the first key'),
    });

    // Rotate, the way the page does it.
    const rotated = await setUpKey(practice.client, NEW_PASSPHRASE);
    assert.equal(rotated.response.status, 303);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practice_key').get().n, 2, 'both keys are kept');

    // The file sent under the first key still opens with the first passphrase. This is the point.
    const row = db.prepare('SELECT storage_path FROM upload').get();
    const envelope = readFileSync(row.storage_path);
    const oldKey = await unwrapPracticeKey(practice.keys.wrappedPrivateKey, practice.keys.passphrase);
    assert.equal(
      Buffer.from(await decryptEnvelope(oldKey, envelope)).toString(),
      'sent under the first key',
      'the practice can still open its own history after rotating',
    );
  });
});

test('after a rotation, a new upload is sealed to the new key and the old key cannot open it', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    const before = await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('the old one'),
    });

    const rotated = await setUpKey(practice.client, NEW_PASSPHRASE);

    // The client's page must now carry the *new* key — that is what rotation buys.
    const page = await (await fetch(`${base}/r/${token}`)).text();
    const given = JSON.parse(/id="practice-key">([\s\S]*?)<\/script>/.exec(page)[1]);
    assert.equal(given.publicKey.x, rotated.publicKey.x, 'the client is handed the current key');
    assert.notEqual(given.publicKey.x, practice.keys.publicKey.x, 'and it is not the old one');

    // The id comes from the database rather than from the helper's return value: the id is what the
    // upload records, so the database is the thing that has to agree.
    const newestKeyId = db
      .prepare('SELECT id FROM practice_key ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get().id;
    assert.equal(given.keyId, newestKeyId, 'along with which key it is, so the practice can tell later which files it holds');

    const after = await upload({
      base,
      token,
      itemId: practice.itemIds[1],
      publicKey: given.publicKey,
      plaintext: Buffer.from('the new one'),
    });

    const oldOnly = [await unwrapPracticeKey(practice.keys.wrappedPrivateKey, practice.keys.passphrase)];
    const newOnly = [await unwrapPracticeKey(rotated.wrappedPrivateKey, NEW_PASSPHRASE)];
    assert.equal(Buffer.from(await decryptWithKeys(oldOnly, before.envelope)).toString(), 'the old one');
    assert.equal(Buffer.from(await decryptWithKeys(newOnly, after.envelope)).toString(), 'the new one');
    await assert.rejects(
      () => decryptEnvelope(newOnly[0], before.envelope),
      'and the new key does not open the file sent before it, which is what makes it a rotation',
    );
  });
});

test('the request page offers every key, current first, so an old file can still be opened', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await upload({ base, token, itemId: practice.itemIds[0], publicKey: practice.keys.publicKey, plaintext: Buffer.from('one') });

    const rotated = await setUpKey(practice.client, NEW_PASSPHRASE);
    await upload({ base, token, itemId: practice.itemIds[1], publicKey: rotated.publicKey, plaintext: Buffer.from('two') });

    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();
    const records = JSON.parse(/id="key-records">([\s\S]*?)<\/script>/.exec(page)[1]).keys;
    assert.equal(records.length, 2, 'both key records are offered to the page');
    assert.equal(records[0].wrapped, rotated.wrappedPrivateKey, 'current first, so the common case is one derivation');

    // One passphrase opens one of them, and the count is what tells the practice which.
    const opened = [];
    for (const record of records) {
      try {
        opened.push(await unwrapPracticeKey(record.wrapped, practice.keys.passphrase));
      } catch {
        // The other key is sealed with the other passphrase.
      }
    }
    assert.equal(opened.length, 1, 'the first passphrase opens exactly one of the two keys');
  });
});

test('changing a passphrase keeps the key, so nothing has to be re-encrypted', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const sent = await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('before the change'),
    });

    const keyId = db.prepare('SELECT id FROM practice_key').get().id;
    const changed = 'a brand new passphrase';
    const rewrapped = await rewrapPrivateKey(practice.keys.wrappedPrivateKey, practice.keys.passphrase, changed);

    const response = await practice.client.post(`/keys/${keyId}/passphrase`, { wrapped_private_key: rewrapped });
    assert.equal(response.status, 303);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practice_key').get().n, 1, 'no new key was made');
    assert.equal(db.prepare('SELECT wrapped_private_key FROM practice_key').get().wrapped_private_key, rewrapped);

    // The new passphrase opens the same key, so the same file opens; the old one no longer does.
    const viaNew = await unwrapPracticeKey(rewrapped, changed);
    assert.equal(Buffer.from(await decryptEnvelope(viaNew, sent.envelope)).toString(), 'before the change');
    await assert.rejects(() => unwrapPracticeKey(rewrapped, practice.keys.passphrase), /does not open this key/);
  });
});

test('one practice cannot change another\'s passphrase, and a malformed record is refused', async () => {
  await withServer(async ({ agent, db }) => {
    const mine = await practiceWithRequest({ agent, db }, 'mine@practice.example');
    const keyId = db.prepare('SELECT id FROM practice_key').get().id;
    const mineWrapped = mine.keys.wrappedPrivateKey;

    const theirs = agent();
    await signUp(theirs, 'theirs@practice.example');
    assert.equal((await theirs.post(`/keys/${keyId}/passphrase`, { wrapped_private_key: mineWrapped })).status, 404);
    assert.equal(
      db.prepare('SELECT wrapped_private_key FROM practice_key').get().wrapped_private_key,
      mineWrapped,
      'and nothing was changed',
    );

    const rubbish = await mine.client.post(`/keys/${keyId}/passphrase`, { wrapped_private_key: 'not a record' });
    assert.equal(rubbish.status, 400);
    assert.match(await rubbish.text(), /not in the form Tickmark writes/);
  });
});

test('the keys page shows the history and offers no way to delete a key', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    await setUpKey(practice.client, NEW_PASSPHRASE);

    const page = await (await practice.client.get('/keys')).text();
    assert.match(page, /<strong>current<\/strong>/, 'the current key is named');
    assert.match(page, /older — opens the files sent while it was current/);
    assert.match(page, /Make a new key/, 'rotation is offered');
    assert.match(page, /Change the passphrase/);
    assert.ok(
      !/>(delete|remove|revoke)<\/button>/i.test(page),
      'and there is no button that could orphan a season of files',
    );

    assert.equal((await fetch(`${base}/keys`, { redirect: 'manual' })).status, 303, 'a stranger is sent to sign in');
  });
});
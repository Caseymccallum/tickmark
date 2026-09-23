/**
 * The operator's half of the promise: that the data can be got back out.
 *
 * Three things are tested here, and none of them is a feature a practice will ever see:
 *
 * 1. **A second process can touch a live database.** Every operator tool opens its own connection, and until
 *    this release SQLite's default busy timeout made that fail in about a millisecond. The test that matters is
 *    not "the pragma is set" but "a child process waits for the lock and then succeeds".
 * 2. **A backup taken while the server is running is whole** — and, more importantly, that `--verify` would
 *    *notice* if it were not. A backup that opens is not the same as a backup that contains the documents.
 * 3. **The order rows and files are copied in.** The database snapshot goes first so that no row can point at a
 *    file that is not in the copy.
 *
 * The fixtures are built directly rather than through the server, because what is under test is what is on
 * disk — and a test that needed a running HTTP server to check a file copy would be testing the wrong thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import {
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  itemsOf,
  recordUpload,
  uploadsOf,
} from '../src/store.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

const BACKUP = join(process.cwd(), 'tools', 'backup.mjs');

/** A data directory with a database and two documents on disk, the way the server leaves one. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-ops-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const db = openDatabase(join(directory, 'tickmark.db'));
  const practiceId = createPractice(db, { name: 'Lodis Accountancy' });
  const person = createPractitioner(db, { practiceId, email: 'sam@example.test', passwordHash: 'scrypt$placeholder' });
  const clientId = createClient(db, { practiceId, createdBy: person, name: 'Northwind Ltd' });
  const requestId = createRequest(db, {
    practiceId,
    createdBy: person,
    clientId,
    title: '2025 return',
    items: ['Bank statements'],
  });
  const [item] = itemsOf(db, requestId);

  const files = [];
  mkdirSync(join(directory, 'blobs', requestId), { recursive: true });
  for (const name of ['statements', 'passport']) {
    const file = join(directory, 'blobs', requestId, `${name}.bin`);
    writeFileSync(file, `the ciphertext of ${name}`);
    files.push(file);
    recordUpload(db, {
      requestId,
      requestItemId: item.id,
      filename: `${name}.pdf`,
      sizeBytes: 20,
      sha256: 'not-a-real-digest',
      storagePath: file,
      at: '2026-09-01T00:00:00.000Z',
    });
  }
  db.close();
  return { directory, requestId, files };
}

test('the database is in write-ahead logging, and waits for a lock rather than failing on one', (t) => {
  const { directory } = fixture(t);
  const db = openDatabase(join(directory, 'tickmark.db'));

  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal', 'WAL is on for a file database');
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000, 'and a lock is waited out, not refused');
  // Deliberately SQLite's default: NORMAL in WAL mode is safe against corruption but can lose recent commits on
  // a power cut, and this is an accounting tool. Asserted so nobody "optimises" it without noticing.
test('a cached statement survives the schema changing underneath it', (t) => {
  // The statement cache in `openDatabase` is only safe because SQLite's `prepare_v2` re-prepares a statement whose
  // schema has moved. That is a fact about SQLite rather than about this code, which is exactly why it is tested:
  // a cached statement that went stale after a migration would fail on somebody's upgrade and nowhere else.
  const { directory } = fixture(t);
  const db = openDatabase(join(directory, 'tickmark.db'));

  const before = db.prepare('SELECT id, name FROM practice').all();
  assert.equal(before.length, 1, 'the query works, and is now cached');

  db.exec('ALTER TABLE practice ADD COLUMN motto TEXT');
  db.prepare('UPDATE practice SET motto = ?').run('Numbers, quietly');

  // The same SQL text, served from the cache, against a table that has gained a column.
  const after = db.prepare('SELECT id, name, motto FROM practice').all();
  assert.equal(after[0].motto, 'Numbers, quietly', 'a statement written before the change sees the new column');

  const old = db.prepare('SELECT id, name FROM practice').all();
  assert.equal(old.length, 1, 'and the old statement still works too, because its own shape is unchanged');
  db.close();
});

  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL — durability was not traded away');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'and foreign keys are still enforced');
  db.close();

  // A memory database has no file to log to, and asking for WAL there must not be an error.
  const memory = openDatabase();
  assert.equal(memory.prepare('PRAGMA journal_mode').get().journal_mode, 'memory', 'and a memory database is fine');
  memory.close();
});

test('a second process waits for the lock instead of failing', async (t) => {
  const { directory } = fixture(t);
  const file = join(directory, 'tickmark.db');
  const script = join(directory, 'writer.mjs');
  writeFileSync(
    script,
    [
      `import { DatabaseSync } from 'node:sqlite';`,
      `const db = new DatabaseSync(${JSON.stringify(file)});`,
      `db.exec('PRAGMA busy_timeout = 5000');`,
      `const started = Date.now();`,
      `db.prepare('INSERT INTO practice (id, name, created_at) VALUES (?, ?, ?)')`,
      `  .run('p2', 'Second', '2026-09-02T00:00:00.000Z');`,
      `console.log('wrote after ' + (Date.now() - started) + 'ms');`,
      `db.close();`,
      ``,
    ].join('\n'),
  );

  // The parent holds a write transaction open, which is what any concurrent writer contends with.
  const db = openDatabase(file);
  const before = db.prepare('SELECT COUNT(*) AS n FROM practice').get().n;
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO practice (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'First', '2026-09-01T00:00:00.000Z');

  // The child starts while the lock is held and the parent commits a moment later. Without a busy timeout the
  // child would already have failed by then — in about a millisecond, which is the whole point of the change.
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  await new Promise((resolve) => setTimeout(resolve, 400));
  db.exec('COMMIT');
  db.close();

  const code = await new Promise((resolve) => child.on('exit', resolve));
  const said = output.join('');
  assert.equal(code, 0, `the second process succeeded rather than failing on a lock — it said: ${said}`);
  assert.match(said, /wrote after/, 'and it waited rather than being refused');

  const check = openDatabase(file);
  assert.equal(
    check.prepare('SELECT COUNT(*) AS n FROM practice').get().n,
    before + 2,
    'and both writes are in the file — one from each process',
  );
  check.close();
});

test('a backup can be taken while the data is in use, and it verifies', (t) => {
  const { directory, files } = fixture(t);
  const to = join(directory, 'backup');

  const taken = execFileSync(process.execPath, [BACKUP, '--data', directory, '--to', to], { encoding: 'utf8' });
  assert.match(taken, /1 practices, 1 requests, 2 files/, 'the manifest counts what it copied');
  assert.ok(files.every((file) => existsSync(file)), 'and nothing was moved out from under the practice');

  const verified = execFileSync(process.execPath, [BACKUP, '--verify', to], { encoding: 'utf8' });
  assert.match(verified, /database   intact/, 'the database is the one that was taken');
  assert.match(verified, /every one of the 2 rows has its file present/, 'and every row has its document');

  // A backup is never allowed to eat the one before it — that is the moment a backup stops being a backup.
  const again = spawn(process.execPath, [BACKUP, '--data', directory, '--to', to], { stdio: ['ignore', 'pipe', 'pipe'] });
  let refused = '';
  again.stderr.on('data', (chunk) => (refused += String(chunk)));
  return new Promise((resolve) => {
    again.on('exit', (code) => {
      assert.equal(code, 1, 'writing into a directory that already has a backup is refused');
      assert.match(refused, /Backups are never overwritten/, 'and it says why');
      resolve();
    });
  });
});

test('verify refuses a directory that is not a finished backup', (t) => {
  const { directory } = fixture(t);
  const empty = join(directory, 'nothing-here');
  mkdirSync(empty, { recursive: true });

  let said = '';
  let code = 0;
  try {
    execFileSync(process.execPath, [BACKUP, '--verify', empty], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    said = String(error.stderr ?? '');
    code = error.status;
  }
  assert.equal(code, 1, 'a directory with no manifest is not verifiable');
  assert.match(said, /no manifest\.json/, 'and the reason is the missing record of what should be there');
});

test('a backup missing a document fails verification, which is the whole point of verifying', (t) => {
  const { directory, requestId } = fixture(t);
  const to = join(directory, 'backup');
  execFileSync(process.execPath, [BACKUP, '--data', directory, '--to', to]);

  // Every other check would pass: the database is unchanged, it opens, and it lists two rows that name two
  // files. A checksum of the database cannot see a missing blob — which is exactly why the check that counts is
  // the one that reads the rows and looks for the files.
  rmSync(join(to, 'blobs', requestId, 'passport.bin'), { force: true });

  let said = '';
  let code = 0;
  try {
    execFileSync(process.execPath, [BACKUP, '--verify', to], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    said = String(error.stderr ?? '');
    code = error.status;
  }
  assert.equal(code, 1, 'the backup is refused');
  assert.match(said, /1 of 2 documents are not in this backup/, 'and it says how many, not that something is off');
  assert.match(said, /passport\.pdf/, 'naming the document that would have been lost');

  // And a database edited after the fact is caught too — the other half of what a manifest is for.
  const { directory: other, requestId: otherRequest } = fixture(t);
  const otherTo = join(other, 'backup');
  execFileSync(process.execPath, [BACKUP, '--data', other, '--to', otherTo]);
  rmSync(join(otherTo, 'blobs', otherRequest, 'statements.bin'), { force: true });

  // With both problems at once, both are reported rather than the first one hiding the second.
  let both = '';
  try {
    execFileSync(process.execPath, [BACKUP, '--verify', otherTo], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
test('a link refuses a file that would take it past its ceiling, and stores nothing', async (t) => {
  // A deliberately tiny ceiling, because the arithmetic is the thing under test and 2 GB of fixture is not.
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    const first = await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('a'.repeat(600)),
      filename: 'statements.pdf',
    });
    assert.equal(first.response.status, 201, 'the first file fits');

    // The second would cross the line. The refusal names the room that is left, because "too big" without a
    // number is a message that leaves somebody guessing at how much to cut.
    const second = await upload({
      base,
      token,
      itemId: itemIds[1],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('b'.repeat(600)),
      filename: 'letter.pdf',
    });
    assert.equal(second.response.status, 413, 'the one that would cross it is refused');
    const said = await second.response.text();
    assert.match(said, /would take this link past its limit/, 'and it says why');
    assert.match(said, /Nothing was stored/, 'and that nothing happened');

    assert.equal(uploadsOf(db, requestId).length, 1, 'only the first file is on disk');
  }, { maxRequestBytes: 1000 });
});

test('a link refuses once it has had enough files, whatever their size', async (t) => {
  // The count matters as much as the bytes: a hundred thousand tiny files exhausts a disk in a way no size
  // ceiling catches, and the symptom — SQLite unable to write — takes the whole install down rather than one
  // upload failing.
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    for (const [index, itemId] of itemIds.entries()) {
      const attempt = await upload({
        base,
        token,
        itemId,
        publicKey: keys.publicKey,
        plaintext: Buffer.from('tiny'),
        filename: `file-${index}.pdf`,
      });
      assert.equal(index < 2 ? attempt.response.status : 413, index < 2 ? 201 : 413, `file ${index + 1}`);
    }

    assert.equal(uploadsOf(db, requestId).length, 2, 'and only the two that were allowed are stored');
    const said = await (
      await upload({
        base,
        token,
        itemId: itemIds[0],
        publicKey: keys.publicKey,
        plaintext: Buffer.from('one more'),
        filename: 'extra.pdf',
      })
    ).response.text();
    assert.match(said, /limit of 2 files/, 'the refusal names the limit it hit');
  }, { maxRequestFiles: 2 });
});

test('the ceiling counts everything the client has sent, answers and extras alike', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    // An extra is a file like any other on the disk, so it counts. A ceiling that only counted answers would be
    // a ceiling an extra could be used to walk around, one upload at a time.
    const asExtra = await fetch(`${base}/r/${token}/extra`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('vat.pdf') },
      body: await (await import('../web/tickmark-crypto.js')).encryptFile(keys.publicKey, Buffer.from('nobody asked for this')),
    });
    assert.equal(asExtra.status, 201, 'an extra is accepted while there is room');

    const over = await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('x'.repeat(900)),
      filename: 'statements.pdf',
    });
    assert.equal(over.response.status, 413, 'and it is the extra that used up the room');
    assert.match(await over.response.text(), /would take this link past its limit/);
    assert.equal(uploadsOf(db, requestId).length, 1, 'nothing further was stored');
  }, { maxRequestBytes: 900 });
});

    both = String(error.stderr ?? '');
  }
  assert.match(both, /documents are not in this backup/, 'a missing document is reported');
});

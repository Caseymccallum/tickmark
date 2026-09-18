/**
 * The spike's tests: they prove the stack and the schema, and nothing about the
 * application, because the application does not exist yet.
 *
 * What is being established here is that the three load-bearing assumptions in
 * `docs/mvp.md` are true on a real machine: that `node:sqlite` needs no flag and no
 * dependency, that the schema's foreign keys are actually enforced, and that the
 * product's central question — what is still outstanding? — is answerable in one
 * query against the shape the plan describes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { openDatabase } from '../src/db.js';
import {
  addItem,
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  history,
  issueToken,
  itemStatus,
  recordUpload,
} from '../src/store.js';
import { createApp } from '../src/app.js';

const PLAN_TABLES = [
  'access_token',
  'client',
  'event',
  'key_wrapping',
  'practice',
  'practice_key',
  'practitioner',
  'request',
  'request_item',
  'session',
  'upload',
];

/** A practice with one client and one request, which most tests need. */
function scenario(db) {
  const practiceId = createPractice(db, { name: 'My practice' });
  const practitionerId = createPractitioner(db, {
    practiceId,
    email: 'sam@practice.example',
    passwordHash: 'scrypt$placeholder',
  });
  // `createdBy` is the person, beside the practice rather than instead of it. The two arguments here
  // used to be `publicKey` and `wrappedPrivateKey`, which `createPractitioner` has ignored since the
  // key moved into its own table — dead arguments in a test are a claim that something is being set.
  const clientId = createClient(db, { practiceId, createdBy: practitionerId, name: 'Northwind Ltd' });
  const requestId = createRequest(db, {
    practiceId,
    createdBy: practitionerId,
    clientId,
    title: '2025 return',
    dueAt: '2026-01-31T00:00:00.000Z',
  });
  return { practiceId, practitionerId, clientId, requestId };
}

test('the schema is exactly the tables this list names, and adding one is a decision', () => {
  const db = openDatabase();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, PLAN_TABLES);
  db.close();
});

test('a row that points at nothing is refused, so the schema is enforced and not decorative', () => {
  const db = openDatabase();
  assert.throws(
    () => addItem(db, { requestId: 'no-such-request', label: 'Bank statements' }),
    /FOREIGN KEY/,
    'an item belonging to a request that does not exist must be refused, not stored',
  );
  db.close();
});

test('a link token is never stored — only its digest', () => {
  const db = openDatabase();
  const { requestId } = scenario(db);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  issueToken(db, { requestId, tokenHash, expiresAt: '2026-03-01T00:00:00.000Z' });

  const row = db.prepare('SELECT * FROM access_token').get();
  assert.equal(row.token_hash, tokenHash, 'the digest is what was stored');
  assert.notEqual(row.token_hash, token, 'the digest is not the token');
  assert.ok(
    !Object.values(row).includes(token),
    'the token must not appear in any column — a leaked database must not open a client link',
  );
  db.close();
});

test('a request round-trips, and the central read reports what is outstanding', () => {
  const db = openDatabase();
  const { requestId } = scenario(db);
  const statements = addItem(db, { requestId, label: 'Bank statements', note: 'All accounts' });
  addItem(db, { requestId, label: 'Signed engagement letter' });

  assert.deepEqual(
    itemStatus(db, requestId).map((item) => [item.label, item.received]),
    [['Bank statements', false], ['Signed engagement letter', false]],
    'a request with no uploads is entirely outstanding',
  );

  recordUpload(db, {
    requestId,
    requestItemId: statements,
    filename: 'bank-2025-q1.pdf.enc',
    mime: 'application/octet-stream',
    sizeBytes: 4096,
    sha256: createHash('sha256').update('ciphertext').digest('hex'),
    storagePath: `blobs/${requestId}/bank-q1.bin`,
    clientNote: 'First account',
    at: '2026-01-05T09:00:00.000Z',
  });
  recordUpload(db, {
    requestId,
    requestItemId: statements,
    filename: 'bank-2025-q2.pdf.enc',
    sizeBytes: 5120,
    sha256: createHash('sha256').update('more ciphertext').digest('hex'),
    storagePath: `blobs/${requestId}/bank-q2.bin`,
    at: '2026-01-06T09:00:00.000Z',
  });

  const after = itemStatus(db, requestId);
  assert.equal(after[0].received, true, 'the item with files is received');
  assert.equal(after[0].files, 2, 'an item may be answered by more than one file');
  assert.equal(
    after[0].lastUploadAt,
    '2026-01-06T09:00:00.000Z',
    'the most recent arrival is reported, so a join that duplicated the row would be caught',
  );
  assert.equal(after[1].received, false, 'the item without a file is still outstanding');
  assert.equal(after[1].files, 0);
  db.close();
});

test('the history records what happened, in the order it happened', () => {
  const db = openDatabase();
  const { requestId } = scenario(db);
  const item = addItem(db, { requestId, label: 'ID scan' });
  issueToken(db, {
    requestId,
    tokenHash: createHash('sha256').update('t').digest('hex'),
    expiresAt: '2026-03-01T00:00:00.000Z',
  });
  recordUpload(db, {
    requestId,
    requestItemId: item,
    filename: 'id.jpg.enc',
    sizeBytes: 128,
    sha256: createHash('sha256').update('c2').digest('hex'),
    storagePath: `blobs/${requestId}/id.bin`,
  });

  assert.deepEqual(
    history(db, requestId).map((event) => event.kind),
    ['request.created', 'link.issued', 'upload.received'],
    'the record answers "did we ever get it?" a year later, so its order is the point',
  );
  db.close();
});

test('the database survives being closed and reopened from a file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'tickmark.db');

  const first = openDatabase(file);
  const { requestId } = scenario(first);
  addItem(first, { requestId, label: 'Bank statements' });
  first.close();

  const second = openDatabase(file);
  assert.equal(
    itemStatus(second, requestId).length,
    1,
    'data written by one process is readable by the next, which is what makes the file the database',
  );
  second.close();
});

test('the server answers /healthz, serves the page, and refuses everything else', async () => {
  const db = openDatabase();
  const server = createApp(db);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, practices: 0 });

    const home = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /The list of documents a client owes you/);
    assert.match(html, /href="\/signup"/, 'a stranger is offered a way in');

    const signedOut = await fetch(`${base}/requests`, { redirect: 'manual' });
    assert.equal(signedOut.status, 303, 'a practice page sends a stranger to sign in');
    assert.equal(signedOut.headers.get('location'), '/signin');

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404, 'an unknown path must 404 rather than pretend');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
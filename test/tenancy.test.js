/**
 * Stage A of `docs/members.md`, tested against a database as version one left it.
 *
 * The migration that gives every practitioner a practice is the one piece of this work that touches an
 * existing operator's data, so the tests here are about what it *must not* do as much as what it does:
 * nothing is deleted, every backfilled row points at the practice its creator's work belongs to, and
 * running it a second time changes nothing.
 *
 * The fixture is built by hand rather than by the current code, because a migration tested against the
 * schema it is migrating *to* proves nothing. This is the old shape: the tenant is the practitioner,
 * and no row has ever heard of a practice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/db.js';
import {
  addKeyWrapping,
  addPracticeKey,
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  membersOf,
  practiceFor,
  practiceKeys,
  replaceWrappedKey,
  requestFor,
} from '../src/store.js';
import { createSession, sessionFor } from '../src/auth.js';
import {
  decryptEnvelope,
  encryptFile,
  generatePracticeKey,
  privateKeyBytesForTransfer,
  sealPrivateKey,
  unwrapPracticeKey,
} from '../web/tickmark-crypto.js';
import { signUp, withServer } from './helpers.js';

const OLD_SCHEMA = `
CREATE TABLE practitioner (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE practice_key (
  id TEXT PRIMARY KEY, practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  public_key TEXT NOT NULL, wrapped_private_key TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE client (
  id TEXT PRIMARY KEY, practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  name TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL
);
CREATE TABLE request (
  id TEXT PRIMARY KEY, practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  client_id TEXT NOT NULL REFERENCES client(id), title TEXT NOT NULL,
  due_at TEXT, closed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

const AT = '2026-09-01T00:00:00.000Z';

/** A database as version one left it: two practices, each with a client, a request, a key and a session. */
function oldDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-tenancy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'tickmark.db');

  const before = new DatabaseSync(file);
  before.exec(OLD_SCHEMA);
  const person = before.prepare(
    'INSERT INTO practitioner (id, email, password_hash, created_at) VALUES (?,?,?,?)',
  );
  const key = before.prepare(
    'INSERT INTO practice_key (id, practitioner_id, public_key, wrapped_private_key, created_at) VALUES (?,?,?,?,?)',
  );
  const client = before.prepare(
    'INSERT INTO client (id, practitioner_id, name, email, created_at) VALUES (?,?,?,?,?)',
  );
  const request = before.prepare(
    'INSERT INTO request (id, practitioner_id, client_id, title, created_at) VALUES (?,?,?,?,?)',
  );
  const session = before.prepare(
    'INSERT INTO session (id, practitioner_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)',
  );

  for (const [who, label] of [['sam', 'Northwind'], ['ada', 'Contoso']]) {
    const id = `person-${who}`;
    person.run(id, `${who}@practice.example`, 'scrypt$placeholder', AT);
    key.run(`key-${who}`, id, `{"kty":"EC","kid":"${who}"}`, `pbkdf2$salt-${who}`, AT);
    client.run(`client-${who}`, id, label, null, AT);
    request.run(`request-${who}`, id, `client-${who}`, `${label} 2025 return`, AT);
    session.run(`session-${who}`, id, `hash-${who}`, '2027-01-01T00:00:00.000Z', AT);
  }
  before.close();
  return file;
}

test('every practitioner gets a practice of their own, and their work is moved into it', (t) => {
  const file = oldDatabase(t);
  const db = openDatabase(file);

  assert.equal(
    db.migratedTenancy,
    8,
    'two practices created and six rows adopted: three tables, two rows each',
  );

  // Each key's wrapped copy became a wrapping belonging to the member who made it, so a database that
  // predates two-member practices arrives with one copy per key and nothing to reconcile.
  assert.equal(db.migratedWrappings, 2, 'one wrapping per key, owned by its creator');
  const wrappings = db
    .prepare('SELECT w.practitioner_id, k.practitioner_id AS created_by FROM key_wrapping w JOIN practice_key k ON k.id = w.key_id')
    .all();
  assert.equal(wrappings.length, 2);
  for (const wrapping of wrappings) {
    assert.equal(wrapping.practitioner_id, wrapping.created_by, 'the copy belongs to the person who made the key');
  }

  const practices = db.prepare('SELECT id, name FROM practice').all();
  assert.equal(practices.length, 2, 'one practice per practitioner, and no more');
  assert.equal(new Set(practices.map((p) => p.id)).size, 2, 'and they are different practices');

  const people = db.prepare('SELECT id, practice_id FROM practitioner ORDER BY id').all();
  assert.deepEqual(people.map((p) => p.id), ['person-ada', 'person-sam']);
  for (const person of people) {
    assert.ok(person.practice_id, `${person.id} belongs to a practice`);
  }
  assert.notEqual(people[0].practice_id, people[1].practice_id, 'and the two are not the same one');

  // Each thing points at the practice of whoever made it — driven by the join, not by position.
  for (const [table, idColumn, expected] of [
    ['practice_key', 'key-sam', 'person-sam'],
    ['client', 'client-sam', 'person-sam'],
    ['request', 'request-sam', 'person-sam'],
    ['practice_key', 'key-ada', 'person-ada'],
    ['client', 'client-ada', 'person-ada'],
    ['request', 'request-ada', 'person-ada'],
  ]) {
    const row = db.prepare(`SELECT practice_id FROM ${table} WHERE id = ?`).get(idColumn);
    const owner = db.prepare('SELECT practice_id FROM practitioner WHERE id = ?').get(expected);
    assert.equal(row.practice_id, owner.practice_id, `${table}.${idColumn} went to ${expected}'s practice`);
  }

  db.close();
});

test('the migration loses nothing: every row and every value is still there', (t) => {
  const file = oldDatabase(t);
  const db = openDatabase(file);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practice_key').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get().n, 2);

  // Not just the count: the values that matter, read back exactly as they went in.
  assert.equal(db.prepare('SELECT name FROM client WHERE id = ?').get('client-ada').name, 'Contoso');
  assert.equal(
    db.prepare('SELECT title FROM request WHERE id = ?').get('request-sam').title,
    'Northwind 2025 return',
  );
  assert.equal(
    db.prepare('SELECT public_key FROM practice_key WHERE id = ?').get('key-ada').public_key,
    '{"kty":"EC","kid":"ada"}',
    'and a key is still the key it was',
  );
  assert.equal(
    db.prepare('SELECT wrapped_private_key FROM practice_key WHERE id = ?').get('key-sam').wrapped_private_key,
    'pbkdf2$salt-sam',
    'including the wrapped copy, which is the one thing here that cannot be regenerated',
  );

  // The old columns are left in place on purpose, so the previous release can still read this file.
  assert.equal(
    db.prepare('SELECT practitioner_id FROM request WHERE id = ?').get('request-sam').practitioner_id,
    'person-sam',
    'the column the old code reads is untouched',
  );

  db.close();
});

test('running the migration twice changes nothing the second time', (t) => {
  const file = oldDatabase(t);

  const first = openDatabase(file);
  const afterFirst = first.prepare('SELECT id FROM practice ORDER BY id').all().map((row) => row.id);
  const placements = first
    .prepare('SELECT id, practice_id FROM practitioner ORDER BY id')
    .all()
    .map((row) => `${row.id}=${row.practice_id}`);
  assert.equal(first.migratedTenancy, 8);
  first.close();

  const second = openDatabase(file);
  assert.equal(second.migratedTenancy, 0, 'nothing left to do');
  assert.equal(second.migratedColumns, 0, 'and no column was added twice');
  assert.equal(second.migratedKeys, 0);
  assert.deepEqual(
    second.prepare('SELECT id FROM practice ORDER BY id').all().map((row) => row.id),
    afterFirst,
    'the practices are the same ones, not new ones',
  );
  assert.deepEqual(
    second.prepare('SELECT id, practice_id FROM practitioner ORDER BY id').all().map((row) => `${row.id}=${row.practice_id}`),
    placements,
    'and nobody was moved to a different practice',
  );
  second.close();
});

test('a fresh database invents no practices, and its schema needs no migration', (t) => {
  const db = openDatabase();

  assert.equal(db.migratedTenancy, 0, 'there is nobody to give a practice to');
  assert.equal(db.migratedColumns, 0, 'and every column is already there');
  assert.equal(db.migratedSession, 0, 'and there is no session column to remove on a fresh database');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practice').get().n, 0, 'so the table is empty');

  // The columns exist and are indexed, which is what stage B will rely on.
  // `sqlite_%` is SQLite's own namespace — the auto-indexes behind PRIMARY KEY and UNIQUE. Filtering
  // them out is the documented way to list the indexes a schema actually declares.
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%practice%' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name)
    .sort();
  assert.deepEqual(indexes, [
    'client_practice',
    'practice_key_owner',
    'practice_key_practice',
    'practitioner_practice',
    'request_practice',
  ], 'every tenant table is indexed by practice, beside the older index on the key owner');


/**
 * The tests below are stage B: the code reads the practice, not the person.
 *
 * The difference is invisible with one member — which is why stage A could land with no behaviour
 * change and why these tests have to assert a capability that did not exist before, rather than an
 * existing one that still works. **Two people in one firm seeing the same client's records** is that
 * capability: under the old shape it was unrepresentable, because a person *was* the tenant.
 */
test('signing up creates a practice, and the person belongs to it', async () => {
  await withServer(async ({ db, agent }) => {
    const client = agent();
    const created = await signUp(client, 'sam@firm.example');
    assert.equal(created.status, 303, 'the sign-up was accepted');

    const practices = db.prepare('SELECT id, name FROM practice').all();
    assert.equal(practices.length, 1, 'exactly one practice was created');
    assert.equal(practices[0].name, 'My practice', 'with the placeholder name stage C will replace');

    const person = db
      .prepare('SELECT practice_id FROM practitioner WHERE email = ?')
      .get('sam@firm.example');
    assert.equal(person.practice_id, practices[0].id, 'and the person belongs to it, not to nobody');

    // A second sign-up makes a second practice rather than joining the first.
    const other = await signUp(agent(), 'ada@firm.example');
    assert.equal(other.status, 303);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM practice').get().n, 2, 'two people, two firms');
    assert.notEqual(
      db.prepare('SELECT practice_id FROM practitioner WHERE email = ?').get('ada@firm.example').practice_id,
      person.practice_id,
    );
  });
});

test('two members of one practice share its client records, which the old shape could not express', (t) => {
  const db = openDatabase();
  t.after(() => db.close());

  const practiceId = createPractice(db, { name: 'Two partners' });
  // Created in the **opposite order to their timestamps**, on purpose. A query that returned rows in
  // insertion order would list sam first, so this is what makes "oldest first" a claim the test can
  // fail on. The first version of this inserted them in timestamp order, and removing the `ORDER BY`
  // from `membersOf` did not fail it — the assertion was being satisfied by the storage order by
  // accident, which is a test that looks like it checks something and does not.
  const sam = createPractitioner(db, {
    practiceId,
    email: 'sam@firm.example',
    passwordHash: 'x',
    at: '2026-09-01T00:00:01.000Z',
  });
  const ada = createPractitioner(db, {
    practiceId,
    email: 'ada@firm.example',
    passwordHash: 'x',
    at: '2026-09-01T00:00:00.000Z',
  });

  const clientId = createClient(db, { practiceId, createdBy: ada, name: 'Northwind Ltd' });
  const requestId = createRequest(db, {
    practiceId,
    createdBy: ada,
    clientId,
    title: '2025 return',
    items: ['Bank statements'],
  });

  // Ada made it; Sam can see it. The tenant is the firm.
  assert.ok(requestFor(db, practiceId, requestId), 'the practice sees its own request');
  assert.equal(requestFor(db, practiceId, requestId).title, '2025 return');
  assert.equal(membersOf(db, practiceId).length, 2, 'and both people are members of it');
  assert.deepEqual(
    membersOf(db, practiceId).map((person) => person.email),
    ['ada@firm.example', 'sam@firm.example'],
    'ordered by when they joined, not by when the row was written: ada joined first but was created second',
  );

  // The row still records who did it, beside the practice rather than instead of it.
  const row = db.prepare('SELECT practice_id, practitioner_id FROM request WHERE id = ?').get(requestId);
  assert.equal(row.practice_id, practiceId, 'the tenant is the practice');
  assert.equal(row.practitioner_id, ada, 'and the creator is the person, which is provenance');

  // Another firm sees nothing of it, which is the property that must not have been traded away.
  const other = createPractice(db, { name: 'Somebody else' });
  assert.equal(requestFor(db, other, requestId), null, 'a different practice finds nothing');
  assert.equal(membersOf(db, other).length, 0);
  assert.equal(practiceFor(db, practiceId).name, 'Two partners');
  assert.equal(practiceFor(db, 'no-such-practice'), null);
});

test('a key belongs to the practice, so the other member can be sent files', (t) => {
  const db = openDatabase();
  t.after(() => db.close());

  const practiceId = createPractice(db, { name: 'Two partners' });
  const ada = createPractitioner(db, { practiceId, email: 'ada@firm.example', passwordHash: 'x' });
  const sam = createPractitioner(db, { practiceId, email: 'sam@firm.example', passwordHash: 'x' });

  addPracticeKey(db, practiceId, {
    publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    wrappedPrivateKey: 'pbkdf2$sha-256$600000$AA$AAAAAAAAAAAAAAAA$AA',
    createdBy: ada,
  });

  // The key was added by Ada and belongs to the firm: whether a client can be sent a file is a question
  // about the practice, so both members answer yes.
  const forAda = db
    .prepare('SELECT EXISTS (SELECT 1 FROM practice_key k WHERE k.practice_id = p.practice_id) AS has_key FROM practitioner p WHERE p.id = ?')
    .get(ada);
  const forSam = db
    .prepare('SELECT EXISTS (SELECT 1 FROM practice_key k WHERE k.practice_id = p.practice_id) AS has_key FROM practitioner p WHERE p.id = ?')
    .get(sam);
  assert.equal(forAda.has_key, 1);
  assert.equal(forSam.has_key, 1, 'the second member sees the firm has a key without adding one');

  const row = db.prepare('SELECT practice_id, practitioner_id FROM practice_key').get();
  assert.equal(row.practice_id, practiceId, 'the key belongs to the practice');
  assert.equal(row.practitioner_id, ada, 'and records who rotated it');
});

test('a session carries the practice, so a page knows whose records it is showing', (t) => {
  const db = openDatabase();
  t.after(() => db.close());

  const practiceId = createPractice(db, { name: 'One person' });
  const person = createPractitioner(db, { practiceId, email: 'sam@firm.example', passwordHash: 'x' });

  const { token } = createSession(db, person);
  const who = sessionFor(db, token);

  assert.equal(who.id, person, 'the session still identifies the person');
  assert.equal(who.practiceId, practiceId, 'and now carries the firm');
  assert.equal(who.hasKey, false, 'with no key yet');
  assert.equal(sessionFor(db, 'not-a-token'), null);
});

  db.close();
});

test('stage B removes the session column stage A added, because nothing read it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-stageb-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'tickmark.db');

  // A database as stage A left it: `session` carries a practice_id, with an index on it. The index
  // matters — SQLite refuses to drop a column an index refers to, so a removal that forgot to drop the
  // index first would fail here rather than in production.
  const before = new DatabaseSync(file);
  before.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, practitioner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
  before.exec('ALTER TABLE session ADD COLUMN practice_id TEXT');
  before.exec('CREATE INDEX session_practice ON session(practice_id)');
  before
    .prepare(
      'INSERT INTO session (id, practitioner_id, token_hash, expires_at, created_at, practice_id) VALUES (?,?,?,?,?,?)',
    )
    .run('s1', 'p1', 'hash-one', '2027-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'the-practice');
  before.close();

  const db = openDatabase(file);
  assert.equal(db.migratedSession, 1, 'the column was removed');
  const columns = db.prepare("SELECT name FROM pragma_table_info('session')").all().map((row) => row.name);
  assert.ok(!columns.includes('practice_id'), 'and it is gone from the table');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get().n, 1, 'with the session itself kept');
  assert.equal(db.prepare('SELECT token_hash FROM session').get().token_hash, 'hash-one', 'and its value intact');
  db.close();

  const again = openDatabase(file);
  assert.equal(again.migratedSession, 0, 'a second open has nothing left to do');
  again.close();
});
 
test("a member with no copy of a key sees none, rather than a colleague's", async () => {
  const db = openDatabase();
  try {
    const practiceId = createPractice(db, { name: 'Two partners' });
    const ada = createPractitioner(db, { practiceId, email: 'ada@firm.example', passwordHash: 'x' });
    const sam = createPractitioner(db, { practiceId, email: 'sam@firm.example', passwordHash: 'x' });

    const key = await generatePracticeKey('ada passphrase long enough');
    addPracticeKey(db, practiceId, {
      publicKey: key.publicKey,
      wrappedPrivateKey: key.wrappedPrivateKey,
      createdBy: ada,
    });

    const forSam = practiceKeys(db, practiceId, sam);
    assert.equal(forSam.length, 1, 'Sam can see that the practice has a key');
    assert.equal(forSam[0].wrappedPrivateKey, null, 'and is told he has no copy of it');
    assert.equal(forSam[0].publicKey.kty, 'EC', 'so the public half is still there, which is the part that is published');
  } finally {
    db.close();
  }
});

test("one member changing their passphrase leaves the other member's copy alone", async () => {
  const db = openDatabase();
  try {
    const practiceId = createPractice(db, { name: 'Two partners' });
    const ada = createPractitioner(db, { practiceId, email: 'ada@firm.example', passwordHash: 'x' });
    const sam = createPractitioner(db, { practiceId, email: 'sam@firm.example', passwordHash: 'x' });

    const key = await generatePracticeKey('ada passphrase long enough');
    const keyId = addPracticeKey(db, practiceId, {
      publicKey: key.publicKey,
      wrappedPrivateKey: key.wrappedPrivateKey,
      createdBy: ada,
    });
    const samCopy = 'pbkdf2$sha-256$600000$c2Ft$c2Ft$c2Ft';
    addKeyWrapping(db, { keyId, practitionerId: sam, wrappedPrivateKey: samCopy });

    const adaNew = 'ada new passphrase here';
    assert.equal(replaceWrappedKey(db, practiceId, ada, keyId, adaNew), true);

    // Sam's copy is untouched.
    assert.equal(
      practiceKeys(db, practiceId, sam)[0].wrappedPrivateKey,
      samCopy,
      "a colleague's copy is not disturbed",
    );

    // And the older column — kept for the previous release to read — was updated, because it is Ada's
    // own copy, and leaving it stale would mean her old passphrase still opened the key there.
    assert.equal(
      db.prepare('SELECT wrapped_private_key FROM practice_key WHERE id = ?').get(keyId).wrapped_private_key,
      adaNew,
      'the column the previous release reads does not go stale',
    );

    // A member cannot re-wrap a key their practice does not own, or one they have no copy of.
    const other = createPractice(db, { name: 'Somebody else' });
    assert.equal(replaceWrappedKey(db, other, ada, keyId, adaNew), false);
    assert.equal(replaceWrappedKey(db, practiceId, 'no-such-person', keyId, adaNew), false);
  } finally {
    db.close();
  }
});

/**
 * Per-member key wrappings, which is what makes two people in one practice possible at all.
 *
 * The claim in the middle of this block is the one a firm cares about: **the same document opens with
 * either partner's own passphrase.** Not that two rows exist — that both people can read the client's
 * file, without sharing a passphrase and without either being able to derive the other's.
 */
test('one key, two members, two copies — and either passphrase opens the same file', async () => {
  const db = openDatabase();
  try {
    const practiceId = createPractice(db, { name: 'Two partners' });
    const ada = createPractitioner(db, { practiceId, email: 'ada@firm.example', passwordHash: 'x' });
    const sam = createPractitioner(db, { practiceId, email: 'sam@firm.example', passwordHash: 'x' });

    // Ada makes the practice's key, under her own passphrase.
    const adaPassphrase = 'ada passphrase long enough';
    const key = await generatePracticeKey(adaPassphrase);
    const keyId = addPracticeKey(db, practiceId, {
      publicKey: key.publicKey,
      wrappedPrivateKey: key.wrappedPrivateKey,
      createdBy: ada,
    });

    // A client sends a document to the practice's public key, before Sam has anything.
    const envelope = await encryptFile(key.publicKey, new TextEncoder().encode('Northwind bank statement'));

    // The invitation produces Sam's copy from the same key material, sealed under his own passphrase.
    // These are the two crypto calls the invitation flow makes.
    const samPassphrase = 'sam passphrase long enough';
    const samCopy = await sealPrivateKey(
      await privateKeyBytesForTransfer(key.wrappedPrivateKey, adaPassphrase),
      samPassphrase,
    );
    addKeyWrapping(db, { keyId, practitionerId: sam, wrappedPrivateKey: samCopy });

    // Both copies exist, and they are different records of the same key.
    const wrappings = db.prepare('SELECT wrapped_private_key FROM key_wrapping').all();
    assert.equal(wrappings.length, 2, 'one copy per member');
    assert.notEqual(wrappings[0].wrapped_private_key, wrappings[1].wrapped_private_key, 'and they are different records');

    // Each member is shown their own copy, and only theirs.
    assert.equal(practiceKeys(db, practiceId, ada)[0].wrappedPrivateKey, key.wrappedPrivateKey);
    assert.equal(practiceKeys(db, practiceId, sam)[0].wrappedPrivateKey, samCopy);
    assert.notEqual(
      practiceKeys(db, practiceId, sam)[0].wrappedPrivateKey,
      practiceKeys(db, practiceId, ada)[0].wrappedPrivateKey,
      "a member is never handed a colleague's copy",
    );

    // The file that predates Sam opens with Sam's passphrase — and with Ada's.
    const samKey = await unwrapPracticeKey(samCopy, samPassphrase);
    assert.equal(new TextDecoder().decode(await decryptEnvelope(samKey, envelope)), 'Northwind bank statement');
    const adaKey = await unwrapPracticeKey(key.wrappedPrivateKey, adaPassphrase);
    assert.equal(new TextDecoder().decode(await decryptEnvelope(adaKey, envelope)), 'Northwind bank statement');

    // Sam cannot open his copy with Ada's passphrase, so the two are genuinely separate secrets.
    await assert.rejects(() => unwrapPracticeKey(samCopy, adaPassphrase));
  } finally {
    db.close();
  }
});


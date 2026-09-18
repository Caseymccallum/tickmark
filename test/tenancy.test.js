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
    10,
    'two practices created and eight rows adopted: four tables, two rows each',
  );

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
    ['session', 'session-sam', 'person-sam'],
    ['practice_key', 'key-ada', 'person-ada'],
    ['client', 'client-ada', 'person-ada'],
    ['request', 'request-ada', 'person-ada'],
    ['session', 'session-ada', 'person-ada'],
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
  assert.equal(first.migratedTenancy, 10);
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
    'session_practice',
  ], 'every tenant table is indexed by practice, beside the older index on the key owner');

  db.close();
});
/**
 * The database: one file, eight tables, no dependencies.
 *
 * `node:sqlite` ships in the runtime, so a practice that self-hosts this inherits no
 * driver, no ORM and no native module to compile. That matters more here than it would
 * in most projects: the operator is running software that holds other people's
 * financial records, and every third-party package in the tree is a thing they have to
 * trust and keep patched.
 *
 * The schema lives here rather than in a migrations directory because version one has
 * exactly one schema. When there is a second, this becomes a migrations directory and
 * this comment goes away.
 *
 * The plan in `docs/mvp.md` said seven tables. There are eight: `session` was added
 * because signing out has to actually revoke access, and that needs server-side state
 * — a signed cookie could be told to stop being valid, but only by keeping a list of
 * secrets the process would lose on restart.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS practitioner (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

-- A practice's keys, as a history rather than a single value.
--
-- Rotation cannot be a swap. Every file already stored is encrypted to the key that was current
-- when it arrived, and ECDH offers no way to move an envelope to a new key without the old private
-- key — so a practice that rotates *must* keep the old key, or every document its clients have sent
-- becomes unopenable. The row stays, and the newest row is the one new uploads use.
--
-- What that means for a compromise is stated in docs/encryption.md rather than glossed: rotation
-- protects what arrives afterwards. It cannot un-disclose what has already been taken.
CREATE TABLE IF NOT EXISTS practice_key (
  id                  TEXT PRIMARY KEY,
  practitioner_id     TEXT NOT NULL REFERENCES practitioner(id),
  public_key          TEXT NOT NULL,
  wrapped_private_key TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client (
  id              TEXT PRIMARY KEY,
  practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  name            TEXT NOT NULL,
  email           TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request (
  id              TEXT PRIMARY KEY,
  practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  client_id       TEXT NOT NULL REFERENCES client(id),
  title           TEXT NOT NULL,
  due_at          TEXT,
  closed_at       TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_item (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES request(id),
  label      TEXT NOT NULL,
  note       TEXT,
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- The token itself is never stored. A database that leaks must not let anyone
-- open a client's link.
CREATE TABLE IF NOT EXISTS access_token (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES request(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- sha256 is over the ciphertext, never over the plaintext.
CREATE TABLE IF NOT EXISTS upload (
  id              TEXT PRIMARY KEY,
  request_item_id TEXT NOT NULL REFERENCES request_item(id),
  filename        TEXT NOT NULL,
  mime            TEXT,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  storage_path    TEXT NOT NULL,
  client_note     TEXT,
  uploaded_at     TEXT NOT NULL
);

-- Append-only: what was sent, what arrived, when. This is the table that answers
-- "did we ever get the bank statements?" eleven months later.
CREATE TABLE IF NOT EXISTS event (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES request(id),
  kind       TEXT NOT NULL,
  detail     TEXT,
  at         TEXT NOT NULL
);

-- A signed-in practice. The session token is stored the same way a link token is:
-- hashed, so a stolen database is not a set of working sessions.
CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,
  practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS request_client ON request(client_id);
CREATE INDEX IF NOT EXISTS item_request   ON request_item(request_id, position);
CREATE INDEX IF NOT EXISTS upload_item    ON upload(request_item_id);
CREATE INDEX IF NOT EXISTS event_request  ON event(request_id, at);
CREATE INDEX IF NOT EXISTS session_token  ON session(token_hash);
CREATE INDEX IF NOT EXISTS practice_key_owner ON practice_key(practitioner_id, created_at);
`;

/**
 * Bring an older database up to this schema.
 *
 * There is exactly one migration so far, and it exists because the first version kept a practice's
 * key in two columns on `practitioner`. Any database created by that version has them, and a key
 * sitting in a column this code no longer reads is a key that would be silently lost.
 *
 * The columns are dropped rather than left in place: a dead column that could later be read by
 * mistake is the kind of thing this project flags. The data moves first, in the same function, and
 * there is a test that runs it against a database made with the old schema.
 */
function migrate(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('practitioner')").all().map((row) => row.name);
  if (!columns.includes('public_key')) return 0;

  const carried = db
    .prepare('SELECT id, public_key, wrapped_private_key, created_at FROM practitioner WHERE public_key IS NOT NULL')
    .all();
  const insert = db.prepare(
    'INSERT INTO practice_key (id, practitioner_id, public_key, wrapped_private_key, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of carried) {
    insert.run(randomUUID(), row.id, row.public_key, row.wrapped_private_key, row.created_at);
  }

  db.exec('ALTER TABLE practitioner DROP COLUMN public_key');
  db.exec('ALTER TABLE practitioner DROP COLUMN wrapped_private_key');
  return carried.length;
}

/** Open the database, creating the file and its directory if they are not there. */
export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.migratedKeys = migrate(db);
  return db;
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
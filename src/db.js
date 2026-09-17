/**
 * The database: one file, seven tables, no dependencies.
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

CREATE INDEX IF NOT EXISTS request_client ON request(client_id);
CREATE INDEX IF NOT EXISTS item_request   ON request_item(request_id, position);
CREATE INDEX IF NOT EXISTS upload_item    ON upload(request_item_id);
CREATE INDEX IF NOT EXISTS event_request  ON event(request_id, at);
`;

/** Open the database, creating the file and its directory if they are not there. */
export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
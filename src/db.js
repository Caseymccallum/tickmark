/**
 * The database: one file, twelve tables, no dependencies.
 *
 * `node:sqlite` ships in the runtime, so a practice that self-hosts this inherits no
 * driver, no ORM and no native module to compile. That matters more here than it would
 * in most projects: the operator is running software that holds other people's
 * financial records, and every third-party package in the tree is a thing they have to
 * trust and keep patched.
 *
 * The schema lives here rather than in a migrations directory because version one had
 * exactly one schema. When there is a second, this becomes a migrations directory and
 * this comment goes away.
 *
 * The table count has been wrong twice in this comment's life, which is why it now says
 * what the count *is* rather than what a plan expected. The plan in `docs/mvp.md` said
 * seven. `session` made it eight, because signing out has to actually revoke access and
 * that needs server-side state — a signed cookie could be told to stop being valid, but
 * only by keeping a list of secrets the process would lose on restart. `practice` made it
 * ten, because a firm with two partners cannot be represented by one login; see
 * `docs/members.md`. `key_wrapping` made it eleven, because two partners cannot share one
 * passphrase either — the same key needs one sealed copy per member. `invite` made it
 * twelve, because the copy the second member gets has to come from somewhere.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
-- A practice: the firm, which is the thing that owns client records, keys and requests.
--
-- Version one had no such row, and a practitioner *was* the practice — one login, one firm. That is
-- fine until a firm has two partners, at which point "whose client is this?" has no answer that a
-- shared password can give. See docs/members.md for the decision and what it costs.
CREATE TABLE IF NOT EXISTS practice (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practitioner (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  -- The practice this person belongs to. Nullable *here* and enforced in stage B: SQLite cannot add a
  -- NOT NULL column to a table that already has rows, so the migration below creates the practices
  -- first and backfills. New rows always set it.
  practice_id         TEXT REFERENCES practice(id)
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
--
-- wrapped_private_key here is the copy belonging to the member who created the key. It is kept
-- because the previous release reads it, so a database that has been migrated stays readable by the
-- software that wrote it. THE COPIES THAT MATTER ARE IN key_wrapping, one per member: two people in one
-- practice each hold the same key sealed under their own passphrase, which is the whole point of
-- docs/members.md and is not expressible in a single column.
CREATE TABLE IF NOT EXISTS practice_key (
  id                  TEXT PRIMARY KEY,
  practitioner_id     TEXT NOT NULL REFERENCES practitioner(id),
  public_key          TEXT NOT NULL,
  wrapped_private_key TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  practice_id         TEXT REFERENCES practice(id)
);

CREATE TABLE IF NOT EXISTS key_wrapping (
  id                  TEXT PRIMARY KEY,
  key_id              TEXT NOT NULL REFERENCES practice_key(id),
  practitioner_id     TEXT NOT NULL REFERENCES practitioner(id),
  wrapped_private_key TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS wrap_key    ON key_wrapping(key_id);
CREATE INDEX IF NOT EXISTS wrap_member ON key_wrapping(practitioner_id);

-- An invitation to join a practice.
--
-- The practice's private key travels in sealed_key, sealed under a secret that only ever exists in the
-- link's fragment — the part of a URL a browser does not send to a server. So this row holds something
-- the server cannot read, and it holds it for the same reason it holds client documents: the operator
-- must be able to run this without being trusted with what is inside.
--
-- key_id matters: the sealed copy belongs to one key, and the new member's wrapping has to be attached
-- to that key. Without it, a member invited today could be recorded as holding a copy of the newest key
-- while holding one for an older key, and the files they could not open would be a mystery.
--
-- Rows are marked used rather than deleted, because "someone was invited, and accepted" is part of the
-- record of a firm.
CREATE TABLE IF NOT EXISTS invite (
  id          TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practice(id),
  created_by  TEXT NOT NULL REFERENCES practitioner(id),
  key_id      TEXT NOT NULL REFERENCES practice_key(id),
  token_hash  TEXT NOT NULL UNIQUE,
  sealed_key  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  used_by     TEXT REFERENCES practitioner(id),
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS invite_token ON invite(token_hash);

CREATE TABLE IF NOT EXISTS client (
  id              TEXT PRIMARY KEY,
  practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  name            TEXT NOT NULL,
  email           TEXT,
  created_at      TEXT NOT NULL,
  practice_id     TEXT REFERENCES practice(id)
);

CREATE TABLE IF NOT EXISTS request (
  id              TEXT PRIMARY KEY,
  practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  client_id       TEXT NOT NULL REFERENCES client(id),
  title           TEXT NOT NULL,
  due_at          TEXT,
  closed_at       TEXT,
  created_at      TEXT NOT NULL,
  practice_id     TEXT REFERENCES practice(id)
);

CREATE TABLE IF NOT EXISTS request_item (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES request(id),
  label      TEXT NOT NULL,
  note       TEXT,
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- Withdrawn rather than deleted, for the same reason a request is closed rather than deleted: a
  -- file may already point at this row, and a record that can lose a row is not a record. The item
  -- stops being asked for; it does not stop having been asked for.
  withdrawn_at   TEXT,
  -- Set by the practice when what arrived is not usable: an unreadable scan, the wrong document,
  -- half a statement. It keeps the item in the outstanding list, so reminders go on asking for it,
  -- and the client's page says what is wrong rather than repeating the same request.
  attention_at   TEXT,
  attention_note TEXT,
  -- Set by the practice once somebody has actually looked at what arrived.
  --
  -- This is the column that separates "received" from "ready", which is the point of the product: a
  -- packet can be complete and still need a preparer's eye, and hiding that difference removes the
  -- signal that somebody had to check. Cleared automatically when a new file arrives against the
  -- item, because new material has not been looked at.
  reviewed_at    TEXT,
  -- What the client said when they could not send something: "I don't have this", "I'll send it
  -- later". Stored so that silence and a stated reason are different things in the list, and so the
  -- practice can see it without reading back through an email thread.
  client_says    TEXT,
  client_says_at TEXT
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
  uploaded_at     TEXT NOT NULL,
  -- Which practice key this envelope was sealed to.
  --
  -- Nothing about the bytes says so: an envelope's header carries the *ephemeral* key it was made
  -- with, not the recipient. So the browser that made it says which key it used, and the server checks
  -- that the key belongs to this practice before recording it.
  --
  -- Nullable, and null means "not known" rather than "no key": rows written before this existed have
  -- no answer, and a re-encryption pass — the thing this column exists for — has to try each of the
  -- practice's keys in turn rather than trust a number it invented.
  key_id          TEXT REFERENCES practice_key(id)
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
 * Indexes on the practice columns, created here rather than in `SCHEMA`.
 *
 * `SCHEMA` runs before `migrate()` on an existing database, so an index naming a column that
 * `migrate()` has not added yet fails — which is exactly what happened when these were first written
 * into `SCHEMA`, and the old-schema migration test in `test/keys.test.js` caught it. The columns must
 * exist first; then these.
 */
const PRACTICE_INDEXES = `
CREATE INDEX IF NOT EXISTS practitioner_practice  ON practitioner(practice_id);
CREATE INDEX IF NOT EXISTS client_practice        ON client(practice_id);
CREATE INDEX IF NOT EXISTS request_practice       ON request(practice_id);
CREATE INDEX IF NOT EXISTS practice_key_practice  ON practice_key(practice_id, created_at);
`;

/**
 * Stage B of `docs/members.md` removes a column stage A added.
 *
 * Stage A put `practice_id` on `session`, before the design had settled. Stage B found the practitioner
 * row is the single source of truth for which practice a session acts in — `sessionFor` reads it from
 * `practitioner`, which it joins anyway for the email — so the column was written by the migration and
 * read by nothing. A column nothing reads is a claim nobody checks, so it goes rather than sitting
 * there looking meaningful.
 *
 * The index has to go first: SQLite refuses to drop a column an index refers to.
 */
function sessionPracticeColumnGoes(db) {
  if (!columnsOf(db, 'session').includes('practice_id')) return 0;
  db.exec('DROP INDEX IF EXISTS session_practice');
  db.exec('ALTER TABLE session DROP COLUMN practice_id');
  return 1;
}

/**
 * Every key's wrapped copy becomes a wrapping belonging to the member who made it.
 *
 * Before this, a key carried one wrapped copy and a practice had one login, so "whose passphrase" was
 * not a question. It is now: the copy belongs to a person, and the same key has one per member.
 *
 * The copy is not moved so much as **copied**: the column keeps its value so the previous release can
 * still read the database, and the new table gets the same value for the same person. Nothing is
 * rewritten, and a database that has been through this twice is unchanged — the insert is conditional on
 * no wrapping existing for that pair.
 */
function keyWrappingsFromKeyColumn(db) {
  if (!columnsOf(db, 'key_wrapping').includes('key_id')) return 0;

  const carried = db
    .prepare(
      `SELECT k.id AS key_id, k.practitioner_id, k.wrapped_private_key, k.created_at
         FROM practice_key k
        WHERE k.wrapped_private_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM key_wrapping w WHERE w.key_id = k.id AND w.practitioner_id = k.practitioner_id
          )`,
    )
    .all();
  if (carried.length === 0) return 0;

  const insert = db.prepare(
    'INSERT INTO key_wrapping (id, key_id, practitioner_id, wrapped_private_key, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const row of carried) {
      insert.run(randomUUID(), row.key_id, row.practitioner_id, row.wrapped_private_key, row.created_at);
      changed += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return changed;
}

/**
 * Bring an older database up to this schema.
 *
 * Two kinds of step, both idempotent, because this runs on every open. `added` counts what changed,
 * and a test asserts that running it twice changes nothing the second time.
 */
function migrate(db) {
  // Counted separately rather than as one number. The first version of this returned a single total,
  // and adding the practice migration silently made `migratedKeys` mean something else — which a test
  // caught, and which would have been a lie in the one place an operator looks to see what happened to
  // their database.
  const changes = { keys: singleKeyColumnsToTable(db), columns: 0, tenancy: 0, session: 0, wrappings: 0 };
  for (const [table, column, definition] of [
    ['request_item', 'withdrawn_at', 'TEXT'],
    ['request_item', 'attention_at', 'TEXT'],
    ['request_item', 'attention_note', 'TEXT'],
    ['request_item', 'reviewed_at', 'TEXT'],
    ['request_item', 'client_says', 'TEXT'],
    ['request_item', 'client_says_at', 'TEXT'],
    ['practitioner', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['practice_key', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['client', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['request', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['upload', 'key_id', 'TEXT REFERENCES practice_key(id)'],
  ]) {
    changes.columns += addColumnIfMissing(db, table, column, definition);
  }
  changes.tenancy = practitionerGetsAPractice(db);
  changes.session = sessionPracticeColumnGoes(db);
  // After tenancy, because a wrapping needs the practitioner's practice to make sense of — and the
  // person who made the key is exactly the person the copy belongs to.
  changes.wrappings = keyWrappingsFromKeyColumn(db);
  // After the columns, not before: see the note on PRACTICE_INDEXES.
  db.exec(PRACTICE_INDEXES);
  return changes;
}

/**
 * Stage A of `docs/members.md`: give every existing practitioner a practice of their own, and point
 * everything they own at it.
 *
 * This is the one migration in this file that can lose data if it is wrong, so it is written to be
 * dull and checkable:
 *
 * - **It never deletes or rewrites a row it does not have to.** The backfill is an `UPDATE … WHERE
 *   practice_id IS NULL`, so a database that has already been through this is left alone, and the only
 *   rows touched are the ones with nothing in the new column.
 * - **Every backfill is driven by a join back through the creator.** `client`, `request`, `session` and
 *   `practice_key` all record the practitioner who made them, so the practice each one belongs to is
 *   already implied by the existing data rather than guessed.
 * - **It is idempotent**, like every other step here, and a test asserts that running it twice reports
 *   no change the second time.
 *
 * The old `practitioner_id` columns are deliberately **left in place**. They are what the previous
 * release reads, so a migrated database is still readable by the software that wrote it — which is the
 * difference between a migration and a one-way door. Stage B drops them once nothing reads them.
 */
function practitionerGetsAPractice(db) {
  if (!columnsOf(db, 'practitioner').includes('practice_id')) return 0;

  const orphans = db
    .prepare('SELECT id, email, created_at FROM practitioner WHERE practice_id IS NULL')
    .all();
  if (orphans.length === 0) return 0;

  const createPractice = db.prepare('INSERT INTO practice (id, name, created_at) VALUES (?, ?, ?)');
  const attach = db.prepare('UPDATE practitioner SET practice_id = ? WHERE id = ?');
  const adopt = {
    practice_key: db.prepare(
      'UPDATE practice_key SET practice_id = (SELECT practice_id FROM practitioner WHERE id = practice_key.practitioner_id) WHERE practice_id IS NULL',
    ),
    client: db.prepare(
      'UPDATE client SET practice_id = (SELECT practice_id FROM practitioner WHERE id = client.practitioner_id) WHERE practice_id IS NULL',
    ),
    request: db.prepare(
      'UPDATE request SET practice_id = (SELECT practice_id FROM practitioner WHERE id = request.practitioner_id) WHERE practice_id IS NULL',
    ),
  };

  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const person of orphans) {
      const practiceId = randomUUID();
      // A placeholder name. Nothing about an existing row says what the firm is called, and inventing
      // one from the email would be worse than a neutral label the owner can change in stage C.
      createPractice.run(practiceId, 'My practice', person.created_at);
      attach.run(practiceId, person.id);
      changed += 1;
    }
    for (const statement of Object.values(adopt)) changed += statement.run().changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return changed;
}

function columnsOf(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);
}

function addColumnIfMissing(db, table, column, definition) {
  if (columnsOf(db, table).includes(column)) return 0;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return 1;
}

/**
 * The first version kept a practice's key in two columns on `practitioner`. A key sitting in a column
 * this code no longer reads is a key that would be silently lost, so it moves into the history and
 * the columns are dropped rather than left in place.
 */
function singleKeyColumnsToTable(db) {
  if (!columnsOf(db, 'practitioner').includes('public_key')) return 0;

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
  const changes = migrate(db);
  db.migratedKeys = changes.keys;
  db.migratedColumns = changes.columns;
  db.migratedTenancy = changes.tenancy;
  db.migratedSession = changes.session;
  db.migratedWrappings = changes.wrappings;
  return db;
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
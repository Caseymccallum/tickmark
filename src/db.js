/**
 * The database: one file, fourteen tables, no dependencies.
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
 * twelve, because the copy the second member gets has to come from somewhere. `template`
 * and `template_item` made it fourteen, because the same forty document names were being
 * typed again for the fifty-first client.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The invitation table, in its own constant because **two things need it**: the schema a fresh database is
 * built from, and the migration that rebuilds it on an upgrade. SQLite cannot relax a `NOT NULL` in place,
 * so the only way to let an invitation exist without a key in it is to build the table again and copy the
 * rows across — and two copies of this DDL would drift, leaving migrated and fresh databases quietly
 * different from each other. One definition, used by both, is the only version of this that stays true.
 */
const INVITE_TABLE = `CREATE TABLE IF NOT EXISTS invite (
  id          TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practice(id),
  created_by  TEXT NOT NULL REFERENCES practitioner(id),
  -- **Nullable**, because an invitation does not always hand over a key. An assistant is being asked to
  -- chase documents, not to read them, so there is nothing to seal and nothing for their browser to open —
  -- and an invitation that carried a key anyway would put the practice's private key in a browser that has
  -- no business holding it, whatever the server later chose to store.
  --
  -- Which is also why the two are constrained together: an invitation either carries a key or it does not,
  -- and a row with one of these set and the other empty is a bug rather than a state. The CHECK is what
  -- makes the schema's claim true rather than aspirational; it is also why this table is rebuilt on
  -- upgrade, since SQLite cannot relax NOT NULL in place (see \`sealedInvites\` below).
  key_id      TEXT REFERENCES practice_key(id),
  token_hash  TEXT NOT NULL UNIQUE,
  sealed_key  TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  used_by     TEXT REFERENCES practitioner(id),
  created_at  TEXT NOT NULL,
  -- What the person who accepts this will be. Nullable, and null reads as 'owner' — the powers an
  -- invitation granted before roles existed, which is the convention everywhere else in this file. It
  -- barely matters in practice: an invitation lives fourteen days, so the window in which a null means
  -- anything closes almost immediately.
  role        TEXT,
  -- Set when the practice takes the invitation back before anyone used it — the one escape hatch a
  -- leaked link needed. Nullable, and null means "still live": a status, not a deletion, like every
  -- other end-of-life column in this file.
  revoked_at  TEXT,
  CHECK ((key_id IS NULL) = (sealed_key IS NULL))
);
`;

export const SCHEMA = `
-- A practice: the firm, which is the thing that owns client records, keys and requests.
--
-- Version one had no such row, and a practitioner *was* the practice — one login, one firm. That is
-- fine until a firm has two partners, at which point "whose client is this?" has no answer that a
-- shared password can give. See docs/members.md for the decision and what it costs.
CREATE TABLE IF NOT EXISTS practice (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- How many days must pass before the batch chase will write to the same client again. **0 means no
  -- limit**, and 0 is the default: docs/product-needs.md says a threshold is a decision and not a default,
  -- so Tickmark does not guess at a number for a firm. A practice sets this for itself, or leaves it off.
  --
  -- Nullable, and null reads as 0 — every practice written before this column existed had no cadence, and
  -- the previous release's behaviour was to send every time.
  cadence_days INTEGER,
  -- Where the practice is, as an IANA zone name ("Europe/London"), or null for UTC. Stored because the one
  -- piece of arithmetic this product does about time — whether a request is overdue — has to happen on the
  -- practice's calendar, not Greenwich's. Stored as a *zone* rather than an offset so that daylight saving
  -- is somebody else's problem; see src/clock.js.
  timezone TEXT,
  -- Whether the practice is emailed when a client sends something. **Nullable, and anything other than 0 means
  -- yes**, which is the opposite of the convention the other columns here follow — and the reason is in the
  -- next sentence. Every other nullable column in this file reads null as "the behaviour before it existed",
  -- because an upgrade should not silently change what the software does. This one exists because the software
  -- did something it should have been doing all along: a practice that configured a mail server in order to
  -- write to clients wants to be told when work arrives, and a product that knows and says nothing is worse
  -- than one that does not know. So the column records the *decision to stop*, not a decision to start, and a
  -- database written before it existed starts being useful rather than starting silent.
  notify_on_upload INTEGER,
  -- Where a client can reach the practice, shown on the page they upload to. Nullable, and null means "not
  -- given" — a practice that has not filled this in gets no contact block rather than an empty one. It is
  -- here because that page otherwise offers exactly one route: post a file. A client with a question left the
  -- portal and found an old email, which is the moment the portal stopped being where the work happens.
  contact_email TEXT,
  contact_phone TEXT
);

CREATE TABLE IF NOT EXISTS practitioner (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  -- The practice this person belongs to. Nullable *here* and enforced in stage B: SQLite cannot add a
  -- NOT NULL column to a table that already has rows, so the migration below creates the practices
  -- first and backfills. New rows always set it.
  practice_id         TEXT REFERENCES practice(id),
  -- Set when a member is removed: their key copies and sessions are destroyed, they can no longer sign
  -- in, and **the row stays**. It stays for two reasons, and both are the reason there is no row
  -- deletion anywhere in this file: every client, request and key records who made it, so deleting the
  -- person would orphan the history that says who did what; and an invitation can restore the same row,
  -- which is how someone who left is able to come back.
  --
  -- Nullable, and null means "a member". A database written before this column existed has no removals,
  -- which is the only honest reading of it.
  removed_at          TEXT,
  -- What this person may do: 'owner', 'accountant' or 'assistant' — see src/roles.js, which is where the
  -- model is written down and where the one interesting role is explained.
  --
  -- Nullable, and null reads as 'owner': the behaviour before this column existed, when every member of a
  -- practice could do everything. An install that upgrades keeps every power it already had and tightens
  -- its roles deliberately, rather than discovering a silent downgrade nobody asked for.
  role                TEXT,
  -- Two-factor: the shared secret, stored in the clear because the server has to compute the same six digits
  -- the phone does. That is not a weakness — a secret that could not be read by the server could not be
  -- checked by it — and what it protects is worth naming: it is the *account* that is being defended, not
  -- the documents, which stay sealed to a key this row has nothing to do with.
  --
  -- Nullable, and null means "not set up". A database written before this existed has no second factor,
  -- which is what everybody had.
  totp_secret         TEXT,
  -- Set only once a code has been checked against the secret, which is what stops somebody locking
  -- themselves out by typing a secret wrong: a started-but-unconfirmed setup is inert, and the sign-in page
  -- ignores it. Nullable, and null means "asked for nothing yet".
  totp_confirmed_at   TEXT,
  -- The last time step a code was accepted for. A code is live for up to ninety seconds — long enough for a
  -- person to type, short enough not to be worth watching for — and without this the same six digits would
  -- work for that whole window *after* they had already been used once. Nullable, and null means no code has
  -- ever been accepted, which is the only honest reading for a row that predates this.
  totp_last_step      INTEGER
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
  practice_id         TEXT REFERENCES practice(id),
  -- Set when the key is retired: its wrapped copies are destroyed, so it can open nothing, and the row
  -- stays as a tombstone rather than vanishing. A key that disappeared would take with it the only
  -- evidence of what it opened, and this project's rule is that a record does not lose a row.
  --
  -- Nullable, and null means "live": every key written before this column existed is live, which is the
  -- only honest reading — those keys were in use, and no file has been moved off them.
  deleted_at          TEXT
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
${INVITE_TABLE}

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
  -- The practice's own words to the client: why these documents are wanted, by when. Shown at
  -- the top of the client's page, above the list, in a box of its own — it is the sentence that
  -- answers "why am I being asked for this?" before the list asks "where is it?". Written when
  -- the request is made or duplicated; plain text, escaped on the way out, newlines kept.
  client_note     TEXT,
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

-- A saved checklist, and the answer to the year's most repeated task: typing the same forty document
-- names again for the fifty-first client.
--
-- A template is **not a record**. Everything else in this file keeps a row forever because something
-- points at it and something happened; a template is a starting point, and requests copy its items at
-- the moment they are made rather than referring to them. That is why this is the one table with a
-- real delete: removing a template that nobody is using discards a draft nobody needs, and leaving it
-- behind would mean a practice's list of lists slowly filling with the names of work they no longer do.
--
-- The items are copied, not referenced, for the same reason a request is closed rather than deleted:
-- rewriting a template next year must not change what was asked of a client this year.
CREATE TABLE IF NOT EXISTS template (
  id          TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practice(id),
  name        TEXT NOT NULL,
  -- The practice's standing words for this kind of job — "please send these by the end of the month".
  -- A default the request form starts from and the practice edits, not something the client ever sees
  -- unbidden: the request's own client_note is what a client reads.
  note        TEXT,
  created_by  TEXT NOT NULL REFERENCES practitioner(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_item (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES template(id),
  label       TEXT NOT NULL,
  note        TEXT,
  position    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS template_item_of ON template_item(template_id);

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
  -- **An upload belongs to a request, and may answer one of its items.** That distinction is what lets a
  -- client send something nobody asked for — the P60, the covering letter, last year's return — without
  -- inventing a checklist entry for it. Before this column existed the request was reached *through* the
  -- item, so an upload with no item had nowhere to live and the only way to send one was email.
  request_id      TEXT NOT NULL REFERENCES request(id),
  -- Nullable: an item answers a question the practice asked, and this is the answer. A client's own document
  -- is not an answer to anything, and storing it as one would put a file the practice never requested into
  -- their checklist — which is the sort of small lie this schema is otherwise careful about.
  request_item_id TEXT REFERENCES request_item(id),
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

-- A password that was right, and a code that has not been given yet.
--
-- Two-factor splits sign-in in half, and the half-finished state has to live somewhere. It lives here rather
-- than in the session table because it is a different thing: a session is proof of identity, this is the
-- absence of it — a row that grants nothing and expires in minutes. Keeping them apart means a bug in this
-- table cannot produce a signed-in stranger, which is the property worth protecting.
--
-- The token is stored hashed like every other token in this file, so a stolen database is not a set of
-- sign-ins waiting to be finished.
CREATE TABLE IF NOT EXISTS login_challenge (
  id              TEXT PRIMARY KEY,
  practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  -- How many wrong codes this challenge has been given. Nullable, and null reads as zero.
  --
  -- The account-level rate limiter is the main guard, and this is deliberately a *second* one: the limiter is
  -- injected, so a deployment that swaps it for something with a different policy — or that passes nothing at
  -- all — must still not offer a million free guesses at a six-digit code. Five is enough for somebody who
  -- mistyped and not enough to be worth grinding.
  attempts        INTEGER
);

-- Ten-character codes for the day the phone is gone.
--
-- **Hashed, like a password**, because that is what they are: an alternative way into an account. Not
-- encrypted with the practice key and not readable by the operator either — a recovery code the server could
-- read is a second password the server knows.
--
-- used_at is what makes them single-use. A sheet of codes where one has been spent should say so rather
-- than quietly working again, and there is no delete anywhere in this file.
CREATE TABLE IF NOT EXISTS recovery_code (
  id              TEXT PRIMARY KEY,
  practitioner_id TEXT NOT NULL REFERENCES practitioner(id),
  code_hash       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  used_at         TEXT
);

CREATE INDEX IF NOT EXISTS request_client ON request(client_id);
CREATE INDEX IF NOT EXISTS item_request   ON request_item(request_id, position);
CREATE INDEX IF NOT EXISTS upload_item    ON upload(request_item_id);
CREATE INDEX IF NOT EXISTS event_request  ON event(request_id, at);
CREATE INDEX IF NOT EXISTS session_token  ON session(token_hash);
CREATE INDEX IF NOT EXISTS practice_key_owner ON practice_key(practitioner_id, created_at);
CREATE INDEX IF NOT EXISTS challenge_token     ON login_challenge(token_hash);
CREATE INDEX IF NOT EXISTS recovery_owner      ON recovery_code(practitioner_id, used_at);
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
  const changes = { keys: singleKeyColumnsToTable(db), columns: 0, tenancy: 0, session: 0, wrappings: 0, invites: 0, uploads: 0 };
  for (const [table, column, definition] of [
    ['request_item', 'withdrawn_at', 'TEXT'],
    ['request_item', 'attention_at', 'TEXT'],
    ['request_item', 'attention_note', 'TEXT'],
    ['request_item', 'reviewed_at', 'TEXT'],
    ['request_item', 'client_says', 'TEXT'],
    ['request_item', 'client_says_at', 'TEXT'],
    ['practitioner', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['practice_key', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['practice_key', 'deleted_at', 'TEXT'],
    ['client', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['request', 'practice_id', 'TEXT REFERENCES practice(id)'],
    ['request', 'client_note', 'TEXT'],
    ['upload', 'key_id', 'TEXT REFERENCES practice_key(id)'],
    ['practitioner', 'removed_at', 'TEXT'],
    ['practice', 'cadence_days', 'INTEGER'],
    ['practice', 'timezone', 'TEXT'],
    ['practice', 'notify_on_upload', 'INTEGER'],
    ['practice', 'contact_email', 'TEXT'],
    ['practice', 'contact_phone', 'TEXT'],
    ['practitioner', 'role', 'TEXT'],
    ['practitioner', 'totp_secret', 'TEXT'],
    ['practitioner', 'totp_confirmed_at', 'TEXT'],
    ['practitioner', 'totp_last_step', 'INTEGER'],
    ['login_challenge', 'attempts', 'INTEGER'],
    // Before `sealedInvites` below runs: the rebuild takes its columns from INVITE_TABLE, which
    // already carries this one, and a database mid-way between the two shapes needs it either way.
    ['invite', 'revoked_at', 'TEXT'],
  ]) {
    changes.columns += addColumnIfMissing(db, table, column, definition);
  }
  changes.tenancy = practitionerGetsAPractice(db);
  // After the column loop and before anything reads an invitation, because an invitation's shape is what
  // changed here rather than its contents.
  changes.invites = sealedInvites(db);
  // A shape change too, and it has to happen before anything reads an upload — `key_id` above was added to
  // the old table, and the rebuild carries it across.
  changes.uploads = uploadsLearnTheirRequest(db);
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

/**
 * An invitation can now exist without a key in it, so the two key columns have to become nullable.
 *
 * An assistant is asked to chase documents, not to read them, so their invitation carries nothing to
 * unseal — and an invitation that carried a key anyway would put the practice's private key into a browser
 * that has no business holding it, whatever the server afterwards decided to store. That is the whole
 * reason this migration exists: not tidiness, but not handing a key to somebody who will not be keeping it.
 *
 * **SQLite cannot relax a `NOT NULL` in place**, so the table is built again and the rows copied across.
 * This is the first migration in this file to do that, and what makes it safe is worth writing down rather
 * than assuming. `invite` has **no incoming foreign keys** — nothing in the schema references it — so there
 * is no web of constraints to unhook and the copy cannot break a row somewhere else. And all of it runs in
 * one transaction, so a process that dies halfway leaves the old table exactly as it was rather than a
 * half-built replacement nobody reads.
 *
 * What it checks for is the thing it actually cares about — whether `sealed_key` is *still* NOT NULL —
 * rather than a version number. A database that has been through this stays through it, and a database
 * built by the current `SCHEMA` never enters.
 */
function sealedInvites(db) {
  const sealed = db
    .prepare(`SELECT name, "notnull" FROM pragma_table_info('invite')`)
    .all()
    .find((column) => column.name === 'sealed_key');
  if (!sealed || sealed.notnull === 0) return 0;

  // Named columns rather than `SELECT *`, because the two tables differ by exactly one column and this is
  // where that is said out loud. The new `role` is deliberately not carried: there is nothing to carry it
  // from, and null reads as the powers an invitation granted before roles existed (`src/roles.js`).
  const carried =
    'id, practice_id, created_by, key_id, token_hash, sealed_key, expires_at, used_at, used_by, created_at';

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE invite RENAME TO invite_narrow');
    db.exec(INVITE_TABLE);
    db.exec(`INSERT INTO invite (${carried}) SELECT ${carried} FROM invite_narrow`);
    db.exec('DROP TABLE invite_narrow');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return 1;
}

/**
 * Every upload learns which request it belongs to, and stops being required to answer an item.
 *
 * The request used to be reachable only *through* the item, which made "a client sent something nobody asked
 * for" unrepresentable — the only way to send one was email, which is the one thing this product exists to
 * replace. The rebuild is not merely structural: the rows are backfilled from the join that every reader was
 * already doing, so a file already on disk keeps pointing at the request it arrived under.
 *
 * SQLite cannot relax `NOT NULL` in place, which is the only reason this is a rebuild rather than an
 * `ALTER TABLE`. The guard is the column's presence, so a database that has been through it is unchanged on
 * the second run.
 */
function uploadsLearnTheirRequest(db) {
  if (columnsOf(db, 'upload').includes('request_id')) return 0;

  const before = db.prepare('SELECT COUNT(*) AS n FROM upload').get().n;

  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE upload_with_request (
      id              TEXT PRIMARY KEY,
      request_id      TEXT NOT NULL REFERENCES request(id),
      request_item_id TEXT REFERENCES request_item(id),
      filename        TEXT NOT NULL,
      mime            TEXT,
      size_bytes      INTEGER NOT NULL,
      sha256          TEXT NOT NULL,
      storage_path    TEXT NOT NULL,
      client_note     TEXT,
      uploaded_at     TEXT NOT NULL,
      key_id          TEXT REFERENCES practice_key(id)
    )`);

    const copied = db
      .prepare(
        `INSERT INTO upload_with_request
           (id, request_id, request_item_id, filename, mime, size_bytes, sha256, storage_path, client_note, uploaded_at, key_id)
         SELECT u.id, i.request_id, u.request_item_id, u.filename, u.mime, u.size_bytes, u.sha256,
                u.storage_path, u.client_note, u.uploaded_at, u.key_id
           FROM upload u JOIN request_item i ON i.id = u.request_item_id`,
      )
      .run().changes;

    // Every file already on disk has an item — there was no way to write one without it — so a count that
    // disagrees means the rename below would drop a row. It stops instead, because a database that refuses
    // to open is recoverable and a file nobody can find again is not.
    if (copied !== before) {
      throw new Error(`the upload rebuild would carry ${copied} of ${before} rows; nothing has been changed`);
    }

    db.exec('DROP TABLE upload');
    db.exec('ALTER TABLE upload_with_request RENAME TO upload');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return 1;
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

  /**
   * **Every `prepare` is a parse**, and this codebase prepares on every call.
   *
   * That is deliberate rather than careless — a query written next to the function that needs it is easier to
   * read than a statement hoisted to a shared place, and most of these run once per page. But the pages that
   * loop do it hundreds of times: `requestsFor` computes progress per request, and progress asks for the items,
   * so a board with five hundred clients parses the same two statements a thousand times per render.
   *
   * Measured before changing anything: twenty thousand `prepare`-then-read calls take 168 ms, and the same
   * twenty thousand against a statement prepared once take 29 ms. **Re-parsing is 5.8 times the work.**
   *
   * So the instance gets its own cache. Not a change to the three hundred call sites — one seam, at the one place
   * that knows a connection exists. The cache is keyed by SQL text, and the set of distinct SQL strings in this
   * product is fixed by the source code, so it cannot grow without bound.
   *
   * What makes it safe: SQLite's `prepare_v2` re-prepares a statement whose schema has changed underneath it, so
   * a cached statement cannot go stale after a migration. And statements that outlive their usefulness are freed
   * when the connection closes.
   */
  const statements = new Map();
  const prepareFresh = db.prepare.bind(db);
  db.prepare = (sql) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = prepareFresh(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  db.exec('PRAGMA foreign_keys = ON');

  // **Wait for a lock rather than failing on it.** SQLite's default busy timeout is zero, so a second
  // connection touching the same file is refused in about a millisecond — and every operator tool opens its
  // own: `reset-password`, `check-container`, `backup`, this file's own migration script. The moment a partner
  // phones "I am locked out" is exactly the moment somebody runs the reset tool against a live server, and
  // that is not the moment to be told the database is busy. Five seconds is long enough for any write this
  // product makes and short enough that a genuinely stuck process still reports rather than hanging.
  db.exec('PRAGMA busy_timeout = 5000');

  // **Write-ahead logging, and it belongs with the backup tool rather than before it.** In the default
  // rollback journal, a reader blocks a writer; in WAL they do not, which is what makes a second process
  // reading a live database practical at all.
  //
  // The reason this is a pair rather than two unrelated changes: **WAL moves committed data out of the main
  // file and into a `-wal` sidecar.** Until this, `cp -r data` while the server was stopped was a perfectly
  // good backup; with it, a copy of `data/*.db` alone can silently miss everything since the last checkpoint.
  // So the documented way to take a backup becomes `VACUUM INTO` — which reads through the WAL correctly and
  // has existed since SQLite 3.27 — and `tools/backup.mjs` is that, wrapped in something an operator can run.
  //
  // `synchronous` is deliberately left at SQLite's default. WAL mode's own documentation says NORMAL is safe
  // against corruption and may lose recent commits on a power cut; this product's claim is about client
  // documents, and trading durability for write speed in an accounting tool is not a trade worth making
  // quietly. The default is FULL and it stays there.
  //
  // One honest limit, for the operator: WAL needs shared memory, so it does not work on a network filesystem.
  // A database on an NFS or SMB mount will refuse to open in this mode — see docs/operations.md, which says
  // what to do about it.
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  db.exec(SCHEMA);
  const changes = migrate(db);
  db.migratedKeys = changes.keys;
  db.migratedColumns = changes.columns;
  db.migratedTenancy = changes.tenancy;
  db.migratedSession = changes.session;
  db.migratedWrappings = changes.wrappings;
  db.migratedInvites = changes.invites;
  db.migratedUploads = changes.uploads;

  // Dead rows swept at open. Expired sessions and half-finished sign-ins are already removed on sight
  // as they are touched, but "on sight" never comes for the ones nobody touches — the laptop that
  // signed in once and never came back — so a long-lived install accumulated them forever. Two
  // tables, both purely live state. `access_token` is deliberately *not* swept: an expired link is
  // history ("created ..., expires ..."), and this project's rule is that a record does not lose a
  // row. `invite` stays for the same reason — the members page reports expired ones.
  const cut = new Date().toISOString();
  db.prepare('DELETE FROM session WHERE expires_at <= ?').run(cut);
  db.prepare('DELETE FROM login_challenge WHERE expires_at <= ?').run(cut);

  return db;
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
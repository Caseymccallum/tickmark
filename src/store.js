/**
 * The queries version one needs, and no more.
 *
 * Two habits are established here rather than later, when they would be a refactor:
 * every write that belongs to a request also writes an `event` row in the same
 * transaction, and every function that reads returns *plain objects* rather than
 * database rows, so that a caller never has to know the schema.
 */
import { newId, now } from './db.js';
import { hashToken } from './crypto.js';
// For `endAllSessions`, which lives beside the rest of the session SQL. Removing a member ends their
// sessions, and a session that outlives the membership is a signed-in stranger.
import { endAllSessions } from './auth.js';

/** Run `fn` in a transaction, rolling back on any throw. */
export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// --- invitations ------------------------------------------------------------------------

/**
 * An invitation, addressed to nobody in particular.
 *
 * There is no email on it on purpose: the link is the invitation, and anyone holding it can accept.
 * That is the honest description of what this is — the page says so — and it is the same property a
 * client link has, for the same reason: a person who needs an account should not have to be found in a
 * directory first.
 */
export function createInvite(db, { practiceId, createdBy, keyId, sealedKey, tokenHash, expiresAt, at = now() }) {
  const id = newId();
  db.prepare(
    `INSERT INTO invite (id, practice_id, created_by, key_id, token_hash, sealed_key, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, practiceId, createdBy, keyId, tokenHash, sealedKey, expiresAt, at);
  return id;
}

/**
 * What state an invitation is in, by the digest of its token.
 *
 * Returns a state rather than a row or null, because the three ways an invitation fails deserve three
 * different sentences: an expired link should tell someone to ask for another one, and a used link
 * should say that it worked and cannot work twice — neither should look like a wrong address.
 */
export function inviteByToken(db, token, at = new Date()) {
  if (typeof token !== 'string' || token.length === 0) return { state: 'unknown' };
  const row = db
    .prepare(
      `SELECT i.id, i.key_id, i.sealed_key, i.expires_at, i.used_at,
              p.name AS practice_name, p.id AS practice_id,
              k.public_key
         FROM invite i
         JOIN practice p ON p.id = i.practice_id
         JOIN practice_key k ON k.id = i.key_id
        WHERE i.token_hash = ?`,
    )
    .get(hashToken(token));

  if (!row) return { state: 'unknown' };
  if (row.used_at) return { state: 'used' };
  if (row.expires_at <= at.toISOString()) return { state: 'expired' };
  return { state: 'open', invite: row };
}

/**
 * Accept an invitation: a person, in the practice, holding their own copy of the key.
 *
 * All three happen in one transaction, because two of them without the third is a member who cannot
 * open anything, and a person created by a link that was then rejected is a person who cannot sign in.
 *
 * The invitation is re-checked inside the transaction. A check before it would leave a window where two
 * requests could both see an open invitation and both accept it — the same reason a used link is a
 * state and not a deletion.
 *
 * **A removed member of this practice comes back through here.** Their row already exists — a removal
 * keeps it, because the history of who did what points at it — and the email column is `UNIQUE`, so
 * without this path somebody who left could never be invited again at all. Restoring the row rather than
 * inserting a second one keeps every request, file and key they ever touched pointing at the same
 * person, which is the whole reason the row was kept. Their sessions do not come back, and their new
 * key copy is the one the invitation carries.
 */
export function claimInvite(db, { token, email, passwordHash, wrappedPrivateKey, at = now() }) {
  return inTransaction(db, () => {
    const found = inviteByToken(db, token, new Date(at));
    if (found.state !== 'open') return { state: found.state };

    const { invite } = found;
    const existing = practitionerByEmail(db, email);
    if (existing && !(existing.removed_at !== null && existing.practice_id === invite.practice_id)) {
      return { state: 'email-taken' };
    }

    const practitionerId = existing
      ? existing.id
      : createPractitioner(db, { practiceId: invite.practice_id, email, passwordHash, at });

    if (existing) {
      // Back, with a new password and no memory of the removal date. Losing that date is a named limit
      // rather than an oversight: a membership history would need its own table, and docs/members.md
      // says so rather than this half-building one.
      db.prepare('UPDATE practitioner SET password_hash = ?, removed_at = NULL WHERE id = ?').run(passwordHash, practitionerId);
    }

    addKeyWrapping(db, { keyId: invite.key_id, practitionerId, wrappedPrivateKey, at });
    db.prepare('UPDATE invite SET used_at = ?, used_by = ? WHERE id = ?').run(at, practitionerId, invite.id);

    return { state: existing ? 'rejoined' : 'joined', practitionerId, practiceId: invite.practice_id };
  });
}

/** Invitations for a practice, newest first, with who accepted them. For the members page. */
export function invitesOf(db, practiceId) {
  return db
    .prepare(
      `SELECT i.id, i.expires_at, i.used_at, i.created_at,
              creator.email AS created_by_email,
              taker.email   AS used_by_email
         FROM invite i
         JOIN practitioner creator ON creator.id = i.created_by
         LEFT JOIN practitioner taker ON taker.id = i.used_by
        WHERE i.practice_id = ?
        ORDER BY i.created_at DESC, i.rowid DESC`,
    )
    .all(practiceId);
}

export function recordEvent(db, { requestId, kind, detail = null, at = now() }) {
  db.prepare('INSERT INTO event (id, request_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(newId(), requestId, kind, detail, at);
}

export function createPractice(db, { name, at = now() }) {
  const id = newId();
  db.prepare('INSERT INTO practice (id, name, created_at) VALUES (?, ?, ?)').run(id, name, at);
  return id;
}

/**
 * A person, inside a practice.
 *
 * `practiceId` is required rather than optional so that a practitioner cannot be created without a
 * firm to belong to by forgetting an argument — the insert fails loudly instead of writing a row that
 * belongs to nobody.
 */
export function createPractitioner(db, { practiceId, email, passwordHash, at = now() }) {
  const id = newId();
  db.prepare(
    'INSERT INTO practitioner (id, practice_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, practiceId, email, passwordHash, at);
  return id;
}

/**
 * A client of a practice.
 *
 * `createdBy` is recorded **beside** the practice and not instead of it. The practice is who owns the
 * record; the person is provenance, for the audit trail a firm eventually wants and for the question
 * "who asked this client for this?" that a two-partner firm will one day ask. Same for requests and
 * for keys.
 */
export function createClient(db, { practiceId, createdBy, name, email = null, at = now() }) {
  const id = newId();
  db.prepare(
    'INSERT INTO client (id, practice_id, practitioner_id, name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, practiceId, createdBy, name, email, at);
  return id;
}

/**
 * A client, by name, for this practice only.
 *
 * Scoped by practice even though names are only unique within a practice: the second
 * half of that sentence is an assumption about the data, and the scope is a fact about
 * the query. Assumptions break; facts do not.
 */
export function findOrCreateClient(db, { practiceId, createdBy, name, email = null, at = now() }) {
  const existing = db
    .prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE')
    .get(practiceId, name);
  if (existing) return existing.id;
  return createClient(db, { practiceId, createdBy, name, email, at });
}

/** A titled list of documents owed by one client, with its items, created atomically. */
export function createRequest(db, { practiceId, createdBy, clientId, title, dueAt = null, items = [], at = now() }) {
  return inTransaction(db, () => {
    const id = newId();
    db.prepare(
      `INSERT INTO request (id, practice_id, practitioner_id, client_id, title, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, practiceId, createdBy, clientId, title, dueAt, at);
    recordEvent(db, { requestId: id, kind: 'request.created', at });
    // Inside the transaction on purpose: a request that exists with none of its items
    // is a state the practice would have to notice and repair.
    for (const label of items) addItem(db, { requestId: id, label, at });
    return id;
  });
}

export function addItem(db, { requestId, label, note = null, at = now() }) {
  const id = newId();
  const position = db.prepare('SELECT COUNT(*) AS n FROM request_item WHERE request_id = ?').get(requestId).n;
  db.prepare(
    `INSERT INTO request_item (id, request_id, label, note, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, requestId, label, note, position, at);
  return id;
}

/**
 * Issue a link. `tokenHash` is what gets stored — the caller has the token and keeps
 * it; this function is deliberately incapable of persisting it.
 */
export function issueToken(db, { requestId, tokenHash, expiresAt, at = now() }) {
  return inTransaction(db, () => {
    const id = newId();
    db.prepare(
      `INSERT INTO access_token (id, request_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, requestId, tokenHash, expiresAt, at);
    recordEvent(db, { requestId, kind: 'link.issued', at });
    return id;
  });
}

/**
 * Record an arriving file. `sha256` is the digest of the *ciphertext*, which is all the
 * server ever holds.
 *
 * `id` may be supplied so that the caller can name the file on disk after the row that
 * describes it. Left to itself it generates one, and a caller that writes bytes under an
 * id of its own would end up with two identifiers for one file — which is exactly the kind
 * of quiet mismatch that makes an operator's backup script wrong.
 */
export function recordUpload(db, { id = newId(), requestId, requestItemId, filename, mime = null, sizeBytes, sha256, storagePath, clientNote = null, keyId = null, at = now() }) {
  return inTransaction(db, () => {
    db.prepare(
      `INSERT INTO upload (id, request_item_id, filename, mime, size_bytes, sha256, storage_path, client_note, key_id, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, requestItemId, filename, mime, sizeBytes, sha256, storagePath, clientNote, keyId, at);

    // New material has not been looked at, so a check that was made against the old set no longer
    // stands. Doing this here rather than in the route means no caller can forget it — and a request
    // that kept saying "checked" after a file arrived would be exactly the lie this column exists to
    // prevent. A client's stated reason goes the same way: they said they could not send it, and then
    // they did.
    const cleared = db
      .prepare('UPDATE request_item SET reviewed_at = NULL, client_says = NULL, client_says_at = NULL WHERE id = ? AND (reviewed_at IS NOT NULL OR client_says IS NOT NULL)')
      .run(requestItemId).changes;

    recordEvent(db, { requestId, kind: 'upload.received', detail: filename, at });
    if (cleared > 0) {
      recordEvent(db, {
        requestId,
        kind: 'item.check-cleared',
        detail: 'new file arrived, so what was checked before needs looking at again',
        at,
      });
    }
    return id;
  });
}

/**
 * How many envelopes are sealed to each of a practice's keys.
 *
 * This is what makes rotating a key an honest operation rather than a hopeful one. An old key cannot be
 * thrown away while anything is still sealed to it, and before this column existed there was no way to
 * know whether that was true — the answer was "keep every key forever, and hope".
 *
 * Returned as a map keyed by key id, with `null` for the uploads that predate the column. The nulls are
 * not an edge case to be tidied away: they are the files a re-encryption pass will have to try every key
 * against, and reporting them as zero would be the one kind of wrong answer this feature must not give.
 */
export function filesPerKey(db, practiceId) {
  const counts = new Map();
  const rows = db
    .prepare(
      `SELECT u.key_id, COUNT(*) AS n
         FROM upload u
         JOIN request_item i ON i.id = u.request_item_id
         JOIN request r ON r.id = i.request_id
        WHERE r.practice_id = ?
        GROUP BY u.key_id`,
    )
    .all(practiceId);

  for (const row of rows) counts.set(row.key_id ?? null, row.n);
  return counts;
}

/**
 * Retire a key: destroy its wrapped copies, and keep the record that it existed.
 *
 * "Delete" would be the wrong word and a worse operation. This project's rule is that a record must not
 * lose a row — a withdrawn item still says it was once asked for, a closed request still exists — and a
 * key that vanishes takes with it the only evidence of what it opened. So the wrapped copies go, which is
 * what actually matters, and the row stays as a tombstone: the public key, the date it was made, the date
 * it was retired. The keys page then reads as a history rather than as a snapshot.
 *
 * Three refusals, all of them load-bearing:
 *
 * - **The current key cannot be retired.** New files are sealed to it, so a practice without it cannot
 *   receive anything.
 * - **A key holding files cannot be retired.** That is the whole reason re-encryption exists; refusing
 *   here is what stops the promise "no file becomes unopenable" from depending on the practice's memory.
 * - **A key already retired cannot be retired again**, so the date means what it says.
 *
 * Returns `{ ok: false, why }` rather than throwing: the caller is a page that has to say which of those
 * three applies, and the sentence differs each time.
 */
export function retirePracticeKey(db, practiceId, keyId, at = now()) {
  return inTransaction(db, () => {
    const key = db
      .prepare('SELECT id, deleted_at FROM practice_key WHERE id = ? AND practice_id = ?')
      .get(keyId, practiceId);
    if (!key) return { ok: false, why: 'not-found' };
    if (key.deleted_at) return { ok: false, why: 'already' };

    const current = db
      .prepare(`SELECT id FROM practice_key WHERE practice_id = ? AND deleted_at IS NULL
                 ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(practiceId);
    if (!current || current.id === keyId) return { ok: false, why: 'current' };

    const held = db.prepare('SELECT COUNT(*) AS n FROM upload WHERE key_id = ?').get(keyId).n;
    if (held > 0) return { ok: false, why: 'holds-files', held };

    // The material goes first. If this succeeded and the row update failed, the key would be unusable but
    // not marked retired, which is the safe direction to be wrong in — the opposite order could leave a
    // wrapped private key in the database under a row that says the key was destroyed.
    const copies = db.prepare('DELETE FROM key_wrapping WHERE key_id = ?').run(keyId).changes;
    db.prepare('UPDATE practice_key SET deleted_at = ? WHERE id = ?').run(at, keyId);
    return { ok: true, copies, at };
  });
}

/**
 * Every envelope sealed to a key, for a re-encryption pass to work through.
 *
 * `key_id IS NULL` is not included: those files are not known to be sealed to this key, and a pass that
 * guessed would be a pass that silently re-sealed something twice from the wrong key. The pass tries
 * each key against them separately, because only the AES-GCM tag can say which key opens a file.
 */
export function uploadsSealedTo(db, keyId, practiceId = null) {
  return db
    .prepare(
      `SELECT u.id, u.storage_path, u.filename, u.request_item_id, r.id AS request_id
         FROM upload u
         JOIN request_item i ON i.id = u.request_item_id
         JOIN request r ON r.id = i.request_id
        WHERE u.key_id = ? ${practiceId ? 'AND r.practice_id = ?' : ''}
        ORDER BY u.uploaded_at, u.id`,
    )
    .all(...(practiceId ? [keyId, practiceId] : [keyId]));
}

/**
 * Swap an upload's stored bytes for a new envelope, and record which key now opens it.
 *
 * This is the one operation in the product that rewrites a stored document, so the order matters more than
 * anywhere else here:
 *
 * 1. **The new bytes are written to a path of their own** — never over the file the row currently points
 *    at. Writing in place would mean a crash between the write and the row update leaves a row describing
 *    bytes it does not have: a document nobody can open, and a record that says it is fine.
 * 2. **The row moves in a transaction**, so the path, the size, the digest and the key it is sealed to
 *    change together or not at all.
 * 3. **The old file is unlinked by the caller**, once the row no longer points at it.
 *
 * A crash between 1 and 2 leaves an unreferenced file and a perfectly good document — the safe direction.
 * The cost is that an interrupted pass can leave an orphan in the blob directory, which is worth knowing
 * and is not worth a cleanup mechanism for a case this rare.
 *
 * The key must belong to the practice that owns the file, and must be a *different* key from the one
 * already recorded. Re-sealing to the same key is not a change, and accepting it would let a caller mark a
 * file as moved without moving it.
 */
export function replaceUpload(db, practiceId, { uploadId, keyId, storagePath, sizeBytes, sha256, at = now() }) {
  return inTransaction(db, () => {
    const row = db
      .prepare(
        `SELECT u.id, u.filename, u.storage_path, u.key_id, r.id AS request_id
           FROM upload u
           JOIN request_item i ON i.id = u.request_item_id
           JOIN request r ON r.id = i.request_id
          WHERE u.id = ? AND r.practice_id = ?`,
      )
      .get(uploadId, practiceId);
    if (!row) return { ok: false, why: 'not-found' };

    const key = db
      .prepare('SELECT id FROM practice_key WHERE id = ? AND practice_id = ? AND deleted_at IS NULL')
      .get(keyId, practiceId);
    if (!key) return { ok: false, why: 'no-such-key' };
    if (row.key_id === keyId) return { ok: false, why: 'already' };

    db.prepare('UPDATE upload SET storage_path = ?, size_bytes = ?, sha256 = ?, key_id = ? WHERE id = ?').run(
      storagePath,
      sizeBytes,
      sha256,
      keyId,
      uploadId,
    );

    recordEvent(db, {
      requestId: row.request_id,
      kind: 'upload.re-encrypted',
      detail: `${row.filename} — moved to a newer key`,
      at,
    });

    return { ok: true, filename: row.filename, previousPath: row.storage_path, requestId: row.request_id };
  });
}

/**
 * The product's central read: every item, how many files answer it, and when the last
 * one arrived.
 *
 * This is what the practice looks at, and what "what is outstanding?" means in a
 * query. An item with no files is outstanding. The count is aggregated rather than
 * joined field-by-field because an item may be answered by more than one file, and a
 * plain join would silently return an item twice.
 */
export function itemStatus(db, requestId) {
  return db.prepare(
    `SELECT i.id, i.label, i.note, i.position,
            i.withdrawn_at, i.attention_at, i.attention_note, i.reviewed_at,
            i.client_says, i.client_says_at,
            COUNT(u.id)        AS file_count,
            MAX(u.uploaded_at) AS last_upload_at
       FROM request_item i
       LEFT JOIN upload u ON u.request_item_id = i.id
      WHERE i.request_id = ?
      GROUP BY i.id
      ORDER BY i.position, i.created_at`,
  ).all(requestId).map((row) => ({
    id: row.id,
    label: row.label,
    note: row.note,
    position: row.position,
    withdrawn: Boolean(row.withdrawn_at),
    received: row.file_count > 0,
    files: row.file_count,
    lastUploadAt: row.last_upload_at,
    // The distinction this product exists to make. `received` means bytes are here; `checked` means
    // somebody has looked at them. They are different columns because they are different facts.
    checked: Boolean(row.reviewed_at),
    reviewedAt: row.reviewed_at,
    needsAttention: Boolean(row.attention_at),
    attentionNote: row.attention_note,
    clientSays: row.client_says,
    clientSaysAt: row.client_says_at,
  }));
}

/**
 * Where a request actually is, computed rather than stored.
 *
 * Stored state drifts: a flag set on arrival and never cleared is how a system ends up saying
 * "ready" about a file nobody has opened. This is derived from the items every time it is asked for,
 * so it cannot disagree with them.
 *
 * The order is the order of the practice's next action:
 *
 * - **ready** — everything asked for has arrived and been looked at. Work can start.
 * - **to-check** — something arrived that nobody has looked at. Do this before chasing anything,
 *   because chasing a client about a document that is already sitting there is the mistake this
 *   state exists to prevent.
 * - **waiting** — nothing to look at, and at least one thing still outstanding.
 */
export function requestProgress(db, requestId) {
  const items = itemStatus(db, requestId).filter((item) => !item.withdrawn);

  const counts = {
    items: items.length,
    received: items.filter((item) => item.received).length,
    checked: items.filter((item) => item.received && item.checked).length,
    outstanding: items.filter((item) => !item.received).length,
    toCheck: items.filter((item) => item.received && !item.checked).length,
    needsAttention: items.filter((item) => item.needsAttention).length,
    clientSaid: items.filter((item) => item.clientSays).length,
  };

  const state = counts.items === 0
    ? 'ready'
    : counts.toCheck > 0
      ? 'to-check'
      : counts.received < counts.items
        ? 'waiting'
        : 'ready';

  return { ...counts, state };
}

export function history(db, requestId) {
  return db.prepare('SELECT kind, detail, at FROM event WHERE request_id = ? ORDER BY at, rowid').all(requestId);
}

export function practitionerByEmail(db, email) {
  return db
    .prepare('SELECT id, email, password_hash, practice_id, removed_at FROM practitioner WHERE email = ?')
    .get(email);
}

/** The firm behind an id. Null if there is no such practice. */
export function practiceFor(db, practiceId) {
  const row = db.prepare('SELECT id, name, created_at, cadence_days FROM practice WHERE id = ?').get(practiceId);
  if (!row) return null;
  // The "null reads as 0" mapping happens here and nowhere else. Null means "written before the column
  // existed", and every practice like that had no cadence — so every caller gets a number, and no caller
  // has to remember which column is nullable for which reason.
  return { ...row, cadenceDays: row.cadence_days ?? 0 };
}

/**
 * Rename a practice.
 *
 * Until this existed every practice was called `My practice`, because a sign-up form asks for an email
 * and a password and nothing knows what the firm is called. A placeholder that cannot be changed is a
 * label nobody chose, on the page a new member sees first.
 *
 * The name is not used in any URL or lookup — it is a display string — so changing it breaks nothing.
 */
export function renamePractice(db, practiceId, name) {
  const row = db.prepare('SELECT id FROM practice WHERE id = ?').get(practiceId);
  if (!row) return false;
  db.prepare('UPDATE practice SET name = ? WHERE id = ?').run(name, practiceId);
  return true;
}

/**
 * How often the batch chase may write to the same client. 0 means no limit.
 *
 * Stored per practice rather than fixed, and that is the point of the feature rather than a detail of it:
 * `docs/product-needs.md` refuses to invent a threshold, because how often it is acceptable to chase a
 * client is a firm's judgement about its own clients. The software's job is to remember the number the
 * firm chose and to say out loud when it is holding somebody back.
 */
export function setCadence(db, practiceId, days) {
  const row = db.prepare('SELECT id FROM practice WHERE id = ?').get(practiceId);
  if (!row) return false;
  db.prepare('UPDATE practice SET cadence_days = ? WHERE id = ?').run(days, practiceId);
  return true;
}

/**
 * Everyone in a practice, oldest first, so the person who created it is first.
 *
 * **Removed members are not here.** They are still rows — the history of who did what points at them —
 * but they are not people the firm works with, and listing them beside current members would make a
 * table that answers two questions at once. `removedMembersOf` is the other question.
 *
 * `password_hash` is deliberately not selected: nothing that displays a member list needs it, and a
 * function that returns secrets is a function that will one day print them.
 */
export function membersOf(db, practiceId) {
  return db
    .prepare(
      'SELECT id, email, created_at FROM practitioner WHERE practice_id = ? AND removed_at IS NULL ORDER BY created_at, id',
    )
    .all(practiceId);
}

/** People who were removed from this practice, most recently removed first. For the members page. */
export function removedMembersOf(db, practiceId) {
  return db
    .prepare(
      `SELECT id, email, created_at, removed_at FROM practitioner
        WHERE practice_id = ? AND removed_at IS NOT NULL
        ORDER BY removed_at DESC, id`,
    )
    .all(practiceId);
}

/**
 * One person, if they are in this practice — checked so that a removal addressed to somebody else's
 * member is a "no such member" rather than an act.
 */
export function memberIn(db, practiceId, practitionerId) {
  return (
    db
      .prepare('SELECT id, email, created_at, removed_at FROM practitioner WHERE id = ? AND practice_id = ?')
      .get(practitionerId, practiceId) ?? null
  );
}

/**
 * Remove a member.
 *
 * Three writes, and the order matters less than the fact that all three happen together: their key
 * copies go, their sessions go, and the row is marked. What that achieves is exactly this much — **it
 * changes what happens next.** `docs/members.md` and `docs/encryption.md` both say the same thing in
 * different places, and the page that calls this says it too, because a firm that believes this is
 * revocation of the past has been told something false by the software.
 *
 * The row is **not deleted**. Every client, request, upload and key records which practitioner made it,
 * so a deletion would leave history pointing at nobody — and an invitation restores this same row, which
 * is how somebody who left is able to come back.
 *
 * Two refusals, both returned as states rather than thrown:
 *
 * - **Not a current member of this practice** (`not-found`, or `already-removed` for a second attempt at
 *   the same person).
 * - **The last member** (`last-member`). A practice with nobody in it is a firm locked out of its own
 *   records: no one could be invited to it, and nothing could ever open its files.
 */
export function removeMember(db, practiceId, practitionerId, { at = now() } = {}) {
  return inTransaction(db, () => {
    const member = memberIn(db, practiceId, practitionerId);
    if (!member) return { state: 'not-found' };
    if (member.removed_at !== null) return { state: 'already-removed' };

    const others = db
      .prepare('SELECT COUNT(*) AS n FROM practitioner WHERE practice_id = ? AND removed_at IS NULL AND id <> ?')
      .get(practiceId, practitionerId).n;
    if (others === 0) return { state: 'last-member' };

    const copies = db.prepare('DELETE FROM key_wrapping WHERE practitioner_id = ?').run(practitionerId).changes;
    const sessions = endAllSessions(db, practitionerId);
    db.prepare('UPDATE practitioner SET removed_at = ? WHERE id = ?').run(at, practitionerId);

    return { state: 'removed', email: member.email, copies, sessions };
  });
}

/**
 * A practice's keys, newest first, each with **the asking member's** wrapped copy.
 *
 * The key belongs to the practice; the wrapped copy belongs to a person. A member who has just been
 * invited has a copy of a key they did not create, and a member who has never been sent a copy of the
 * newest key sees the key without one — which is a state worth being able to see rather than hiding,
 * because it means they cannot open anything encrypted to it.
 *
 * **Retired keys are not here.** This is the list of keys a practice can use: to decrypt with, to
 * re-seal to, to change a passphrase on. A retired key can do none of those, and including it would mean
 * every caller filtering it out separately. The keys page asks a different question and calls
 * `allPracticeKeys` for it.
 */
export function practiceKeys(db, practiceId, practitionerId) {
  return allPracticeKeys(db, practiceId, practitionerId).filter((key) => key.deletedAt === null);
}

/**
 * Every key a practice has ever had, retired ones included, which is what the keys page needs.
 *
 * A retired key comes back with no wrapped copy — because there is none, there is nothing left to unwrap —
 * and with the date it was retired. That is the whole point of keeping the row.
 */
export function allPracticeKeys(db, practiceId, practitionerId) {
  return db
    .prepare(
      `SELECT k.id, k.public_key, k.created_at, k.deleted_at, w.wrapped_private_key
         FROM practice_key k
         LEFT JOIN key_wrapping w ON w.key_id = k.id AND w.practitioner_id = ?
        WHERE k.practice_id = ?
        ORDER BY k.created_at DESC, k.rowid DESC`,
    )
    .all(practitionerId, practiceId)
    .map((row) => ({
      id: row.id,
      publicKey: JSON.parse(row.public_key),
      wrappedPrivateKey: row.wrapped_private_key ?? null,
      createdAt: row.created_at,
      deletedAt: row.deleted_at ?? null,
    }));
}

export function currentPracticeKey(db, practiceId, practitionerId) {
  return practiceKeys(db, practiceId, practitionerId)[0] ?? null;
}

/**
 * Add a key. Rotation is this and nothing else — no key is removed, because removing one would
 * orphan every file encrypted to it.
 *
 * The wrapping happened in the browser, as it always does. If the server wrapped it, the server
 * could unwrap it, and the claim that a self-hosted Tickmark cannot read a client's documents would
 * be false in exactly the situation where it matters: when the host is compromised.
 *
 * Two records are written, and the duplication is deliberate: `practice_key.wrapped_private_key` keeps
 * the copy the previous release reads, and `key_wrapping` gets the copy that belongs to this member.
 * The column is the older idea of "the practice's copy"; the table is the true one, and it is what every
 * read goes through. `createdBy` records which member added the key — in a firm with two partners, "who
 * rotated this, and when" is a question someone will ask.
 */
export function addPracticeKey(db, practiceId, { publicKey, wrappedPrivateKey, createdBy, at = now() }) {
  const id = newId();
  return inTransaction(db, () => {
    db.prepare(
      `INSERT INTO practice_key (id, practice_id, practitioner_id, public_key, wrapped_private_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, practiceId, createdBy, JSON.stringify(publicKey), wrappedPrivateKey, at);
    addKeyWrapping(db, { keyId: id, practitionerId: createdBy, wrappedPrivateKey, at });
    return id;
  });
}

/**
 * Which members hold a sealed copy of a key.
 *
 * For the members page, so that "can this person open the files we have?" is answered by looking rather
 * than by assuming — a member created before the wrapping existed, or one whose copy failed to attach,
 * would otherwise look exactly like a member who is fine.
 */
export function wrappingHoldersOf(db, keyId) {
  return db
    .prepare('SELECT practitioner_id FROM key_wrapping WHERE key_id = ?')
    .all(keyId)
    .map((row) => row.practitioner_id);
}

/** Give one member a sealed copy of a key. What an invitation produces. */
export function addKeyWrapping(db, { keyId, practitionerId, wrappedPrivateKey, at = now() }) {
  const existing = db
    .prepare('SELECT id FROM key_wrapping WHERE key_id = ? AND practitioner_id = ?')
    .get(keyId, practitionerId);
  if (existing) {
    db.prepare('UPDATE key_wrapping SET wrapped_private_key = ? WHERE id = ?').run(wrappedPrivateKey, existing.id);
    return existing.id;
  }
  const id = newId();
  db.prepare(
    'INSERT INTO key_wrapping (id, key_id, practitioner_id, wrapped_private_key, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, keyId, practitionerId, wrappedPrivateKey, at);
  return id;
}

/**
 * Re-wrap one key under a new passphrase, **for one member**.
 *
 * Changing a passphrase does not rotate anything: the same key comes back, sealed differently. That is
 * why it is cheap, and why it is worth having as a separate act from rotation. It is also why the change
 * is per person: a member changing their passphrase leaves their colleague's copy exactly as it was,
 * which is the point of holding one copy each.
 */
export function replaceWrappedKey(db, practiceId, practitionerId, keyId, wrappedPrivateKey) {
  const row = db
    .prepare(
      `SELECT w.id, k.practitioner_id AS created_by
         FROM key_wrapping w JOIN practice_key k ON k.id = w.key_id
        WHERE w.key_id = ? AND w.practitioner_id = ? AND k.practice_id = ?`,
    )
    .get(keyId, practitionerId, practiceId);
  if (!row) return false;

  return inTransaction(db, () => {
    db.prepare('UPDATE key_wrapping SET wrapped_private_key = ? WHERE id = ?').run(wrappedPrivateKey, row.id);

    // The older column is kept for the previous release to read, and it must not go stale. It is the
    // *creator's* copy, so it is updated when the creator re-wraps and left alone when a colleague does:
    // a stale copy there would mean the old passphrase still opened the key for anyone reading that
    // column, which is exactly what changing a passphrase is supposed to prevent.
    if (row.created_by === practitionerId) {
      db.prepare('UPDATE practice_key SET wrapped_private_key = ? WHERE id = ?').run(wrappedPrivateKey, keyId);
    }
    return true;
  });
}

export function clientsOf(db, practiceId) {
  return db
    .prepare('SELECT id, name, email FROM client WHERE practice_id = ? ORDER BY name')
    .all(practiceId);
}

/**
 * The practice's dashboard: every request, who it is for, and how much of it has arrived.
 *
 * One query rather than a loop, because the shape of the screen is known and the
 * alternative is a query per row. `includeClosed` exists because a practice's list grows all
 * season and a list that never empties stops being read — so closed requests are a second view
 * rather than a deletion.
 */
export function requestsFor(db, practiceId, { includeClosed = false } = {}) {
  return db
    .prepare(
      `SELECT r.id, r.title, r.due_at, r.closed_at, r.created_at,
              c.name AS client_name, c.email AS client_email,
              (SELECT MAX(e.at) FROM event e WHERE e.request_id = r.id) AS last_activity_at
         FROM request r JOIN client c ON c.id = r.client_id
        WHERE r.practice_id = ?
          ${includeClosed ? '' : 'AND r.closed_at IS NULL'}
        ORDER BY r.created_at DESC`,
    )
    .all(practiceId)
    .map((row) => ({
      ...row,
      // The same function the request page uses, rather than a second SQL copy of the same rule. It
      // costs one small query per row; the alternative is two implementations of "is this ready?" that
      // can disagree, and the list and the page disagreeing about a client's state is the kind of thing
      // that destroys trust in the whole board.
      progress: requestProgress(db, row.id),
    }));
}

export function closedCount(db, practiceId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM request WHERE practice_id = ? AND closed_at IS NOT NULL')
    .get(practiceId).n;
}

/**
 * Close a request: everything has arrived, or the practice has given up on the rest.
 *
 * Closing is a *status*, not a record: it can be reversed, and both acts go in the event log. The
 * client's link is untouched — revoking is a separate act, and closing a file is not the same as
 * telling a client to stop sending.
 */
export function closeRequest(db, practiceId, requestId, at = now()) {
  const row = db
    .prepare('SELECT id, closed_at FROM request WHERE id = ? AND practice_id = ?')
    .get(requestId, practiceId);
  if (!row || row.closed_at) return false;
  db.prepare('UPDATE request SET closed_at = ? WHERE id = ?').run(at, requestId);
  recordEvent(db, { requestId, kind: 'request.closed', at });
  return true;
}

export function reopenRequest(db, practiceId, requestId, at = now()) {
  const row = db
    .prepare('SELECT id, closed_at FROM request WHERE id = ? AND practice_id = ?')
    .get(requestId, practiceId);
  if (!row || !row.closed_at) return false;
  db.prepare('UPDATE request SET closed_at = NULL WHERE id = ?').run(requestId);
  recordEvent(db, { requestId, kind: 'request.reopened', at });
  return true;
}

/**
 * One request, **scoped to the practice that owns it**.
 *
 * Authorization is in the query rather than in a check beside the query, because a check
 * beside the query is a check somebody eventually forgets. A request belonging to
 * another practice is indistinguishable from one that does not exist, which is also the
 * right answer to give.
 */
export function requestFor(db, practiceId, requestId) {
  const row = db
    .prepare(
      `SELECT r.id, r.title, r.due_at, r.closed_at, r.created_at,
              c.id AS client_id, c.name AS client_name, c.email AS client_email
         FROM request r JOIN client c ON c.id = r.client_id
        WHERE r.id = ? AND r.practice_id = ?`,
    )
    .get(requestId, practiceId);
  return row ?? null;
}

export function itemsOf(db, requestId) {
  // Delegates to `itemStatus` rather than carrying its own query and its own shape. Two functions that
  // both describe an item are two functions that can disagree about whether something has been checked —
  // and the request page, the reminder and the list all read items, so they must read the same thing.
  return itemStatus(db, requestId);
}

/**
 * An item, scoped to its request **and to the practice that owns the request**.
 *
 * Every mutation below goes through this, so there is one place that can be wrong about who is
 * allowed to change an item, rather than four.
 */
export function itemIn(db, practiceId, requestId, itemId) {
  return (
    db
      .prepare(
        `SELECT i.id, i.label, i.withdrawn_at, i.attention_at, i.attention_note,
                i.reviewed_at, i.client_says, i.client_says_at
           FROM request_item i JOIN request r ON r.id = i.request_id
          WHERE i.id = ? AND i.request_id = ? AND r.practice_id = ?`,
      )
      .get(itemId, requestId, practiceId) ?? null
  );
}

/**
 * Add items to a request that already exists.
 *
 * A label already on the request is skipped rather than added twice: a checklist with the same
 * document in it twice is a checklist a client sends twice or ignores. One event for the act rather
 * than one per label, because the practice did one thing.
 */
export function addItems(db, { requestId, labels, at = now() }) {
  return inTransaction(db, () => {
    const seen = new Set(
      db
        .prepare('SELECT label FROM request_item WHERE request_id = ?')
        .all(requestId)
        .map((row) => row.label.toLowerCase()),
    );

    const addedLabels = [];
    const ids = [];
    for (const label of labels) {
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      addedLabels.push(label);
      ids.push(addItem(db, { requestId, label, at }));
    }

    if (ids.length > 0) {
      recordEvent(db, {
        requestId,
        kind: 'items.added',
        detail: ids.length === 1 ? addedLabels[0] : `${ids.length} items`,
        at,
      });
    }
    return ids;
  });
}

/**
 * Stop asking for an item, without losing that it was asked for.
 *
 * Withdrawing is reversible, like closing a request and for the same reason: a status that cannot be
 * undone is a trap for whoever sets it by mistake.
 */
export function setItemWithdrawn(db, practiceId, requestId, itemId, withdrawn, at = now()) {
  const item = itemIn(db, practiceId, requestId, itemId);
  if (!item || Boolean(item.withdrawn_at) === withdrawn) return false;
  db.prepare('UPDATE request_item SET withdrawn_at = ? WHERE id = ?').run(withdrawn ? at : null, itemId);
  recordEvent(db, { requestId, kind: withdrawn ? 'item.withdrawn' : 'item.restored', detail: item.label, at });
  return true;
}

/**
 * Say that what arrived is not usable.
 *
 * The note is for the client — "the scan is unreadable", "this is the 2024 statement" — and the item
 * stays outstanding, so the next reminder asks for it again and the client's page says what was
 * wrong with the last attempt.
 */
export function setItemAttention(db, practiceId, requestId, itemId, { note = null } = {}, at = now()) {
  const item = itemIn(db, practiceId, requestId, itemId);
  if (!item) return false;
  const trimmed = typeof note === 'string' && note.trim().length > 0 ? note.trim().slice(0, 500) : null;
  db.prepare('UPDATE request_item SET attention_at = ?, attention_note = ? WHERE id = ?').run(at, trimmed, itemId);
  recordEvent(db, {
    requestId,
    kind: 'item.needs-attention',
    detail: trimmed ? `${item.label}: ${trimmed}` : item.label,
    at,
  });
  return true;
}

export function clearItemAttention(db, practiceId, requestId, itemId, at = now()) {
  const item = itemIn(db, practiceId, requestId, itemId);
  if (!item || !item.attention_at) return false;
  db.prepare('UPDATE request_item SET attention_at = NULL, attention_note = NULL WHERE id = ?').run(itemId);
  recordEvent(db, { requestId, kind: 'item.attention-cleared', detail: item.label, at });
  return true;
}

/**
 * Mark an item as checked, or as needing another look.
 *
 * This is the practice saying "I have looked at what arrived". It is deliberately separate from the
 * file arriving, because that difference is the point of the product: a packet can be complete and
 * still not ready for a preparer, and the two states need different words.
 *
 * Checking an item with nothing in it is refused. There is nothing to have looked at, and allowing it
 * would let a request report itself ready while the client had sent nothing at all.
 */
export function setItemReviewed(db, practiceId, requestId, itemId, reviewed, at = now()) {
  const item = itemIn(db, practiceId, requestId, itemId);
  if (!item) return false;

  if (reviewed) {
    const has = db.prepare('SELECT COUNT(*) AS n FROM upload WHERE request_item_id = ?').get(itemId).n > 0;
    if (!has) return false;
  }
  if (Boolean(item.reviewed_at) === Boolean(reviewed)) return false;

  db.prepare('UPDATE request_item SET reviewed_at = ? WHERE id = ?').run(reviewed ? at : null, itemId);
  recordEvent(db, {
    requestId,
    kind: reviewed ? 'item.checked' : 'item.check-undone',
    detail: item.label,
    at,
  });
  return true;
}

/**
 * What the client said about an item, or that they have nothing to say.
 *
 * "I don't have this" and "I'll send it later" are different sentences to receive and both are better
 * than silence — which is the state a client is otherwise stuck in when they cannot produce a file.
 * The item stays outstanding either way: whether to stop asking is the practice's decision, not the
 * client's, and the product's job is to make sure they can see what was said rather than guess.
 */
export function setClientSays(db, practiceId, requestId, itemId, says, at = now()) {
  const item = itemIn(db, practiceId, requestId, itemId);
  if (!item) return false;

  const trimmed = typeof says === 'string' && says.trim().length > 0 ? says.trim().slice(0, 500) : null;
  if (trimmed === (item.client_says ?? null)) return false;

  db.prepare('UPDATE request_item SET client_says = ?, client_says_at = ? WHERE id = ?').run(
    trimmed,
    trimmed ? at : null,
    itemId,
  );
  recordEvent(db, {
    requestId,
    kind: trimmed ? 'item.client-said' : 'item.client-said-cleared',
    detail: trimmed ? `${item.label}: ${trimmed}` : item.label,
    at,
  });
  return true;
}

export function uploadsOf(db, requestId) {
  return db
    .prepare(
      `SELECT u.id, u.request_item_id, u.filename, u.size_bytes, u.sha256, u.client_note, u.uploaded_at
         FROM upload u JOIN request_item i ON i.id = u.request_item_id
        WHERE i.request_id = ? ORDER BY u.uploaded_at`,
    )
    .all(requestId);
}

/**
 * The request a link token opens — or why it does not.
 *
 * The token is looked up by its digest, so this is the only place the plain token and the
 * stored row meet. It returns a state rather than a boolean because the three failures
 * deserve three different sentences: a link that expired should tell the client to ask
 * for a new one, and should not pretend that the request never existed.
 */
export function tokenLookup(db, token, at = new Date()) {
  if (typeof token !== 'string' || token.length === 0) return { state: 'unknown' };
  const row = db
    .prepare(
      `SELECT t.id AS token_id, t.expires_at, t.revoked_at,
              r.id, r.title, r.due_at, r.practice_id,
              c.name AS client_name,
              k.id AS practice_key_id, k.public_key AS practice_public_key
         FROM access_token t
         JOIN request r ON r.id = t.request_id
         JOIN client c ON c.id = r.client_id
         -- The newest key, by a join rather than a subquery in the select list, so that "which key is
         -- current" is written once. It was two correlated subqueries when the id was added here, and a
         -- second copy of an ordering rule is a second thing that can be changed alone.
         LEFT JOIN practice_key k ON k.id = (
           SELECT k2.id FROM practice_key k2
            WHERE k2.practice_id = r.practice_id
            ORDER BY k2.created_at DESC, k2.rowid DESC LIMIT 1)
        WHERE t.token_hash = ?`,
    )
    .get(hashToken(token));

  if (!row) return { state: 'unknown' };
  if (row.revoked_at) return { state: 'revoked' };
  if (row.expires_at <= at.toISOString()) return { state: 'expired' };
  return { state: 'open', tokenId: row.token_id, request: row };
}

/**
 * An item, **scoped to the request it must belong to**.
 *
 * A valid link to request A must not be able to deliver a file to an item of request B,
 * and the way to make that impossible is to make the query unable to find it.
 */
export function itemInRequest(db, requestId, itemId) {
  return (
    db
      .prepare(
        'SELECT id, label, note, withdrawn_at, attention_at, reviewed_at, client_says FROM request_item WHERE id = ? AND request_id = ?',
      )
      .get(itemId, requestId) ?? null
  );
}

export function tokensFor(db, requestId) {
  return db
    .prepare(
      `SELECT id, expires_at, created_at, revoked_at
         FROM access_token WHERE request_id = ? ORDER BY created_at DESC`,
    )
    .all(requestId);
}

/** Revoke a link. Scoped by practice, so one practice cannot revoke another's. */
export function revokeToken(db, practiceId, tokenId, at = now()) {
  const row = db
    .prepare(
      `SELECT t.id, t.request_id, t.revoked_at
         FROM access_token t JOIN request r ON r.id = t.request_id
        WHERE t.id = ? AND r.practice_id = ?`,
    )
    .get(tokenId, practiceId);
  if (!row || row.revoked_at) return false;
  db.prepare('UPDATE access_token SET revoked_at = ? WHERE id = ?').run(at, tokenId);
  recordEvent(db, { requestId: row.request_id, kind: 'link.revoked', at });
  return true;
}

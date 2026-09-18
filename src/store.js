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
 */
export function claimInvite(db, { token, email, passwordHash, wrappedPrivateKey, at = now() }) {
  return inTransaction(db, () => {
    const found = inviteByToken(db, token, new Date(at));
    if (found.state !== 'open') return { state: found.state };

    const { invite } = found;
    const practitionerId = createPractitioner(db, {
      practiceId: invite.practice_id,
      email,
      passwordHash,
      at,
    });
    addKeyWrapping(db, {
      keyId: invite.key_id,
      practitionerId,
      wrappedPrivateKey,
      at,
    });
    db.prepare('UPDATE invite SET used_at = ?, used_by = ? WHERE id = ?').run(at, practitionerId, invite.id);

    return { state: 'joined', practitionerId, practiceId: invite.practice_id };
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
export function recordUpload(db, { id = newId(), requestId, requestItemId, filename, mime = null, sizeBytes, sha256, storagePath, clientNote = null, at = now() }) {
  return inTransaction(db, () => {
    db.prepare(
      `INSERT INTO upload (id, request_item_id, filename, mime, size_bytes, sha256, storage_path, client_note, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, requestItemId, filename, mime, sizeBytes, sha256, storagePath, clientNote, at);
    recordEvent(db, { requestId, kind: 'upload.received', detail: filename, at });
    return id;
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
    received: row.file_count > 0,
    files: row.file_count,
    lastUploadAt: row.last_upload_at,
  }));
}

export function history(db, requestId) {
  return db.prepare('SELECT kind, detail, at FROM event WHERE request_id = ? ORDER BY at, rowid').all(requestId);
}

export function practitionerByEmail(db, email) {
  return db
    .prepare('SELECT id, email, password_hash, practice_id FROM practitioner WHERE email = ?')
    .get(email);
}

/** The firm behind an id. Null if there is no such practice. */
export function practiceFor(db, practiceId) {
  return db.prepare('SELECT id, name, created_at FROM practice WHERE id = ?').get(practiceId) ?? null;
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
 * Everyone in a practice, oldest first, so the person who created it is first.
 *
 * `password_hash` is deliberately not selected: nothing that displays a member list needs it, and a
 * function that returns secrets is a function that will one day print them.
 */
export function membersOf(db, practiceId) {
  return db
    .prepare('SELECT id, email, created_at FROM practitioner WHERE practice_id = ? ORDER BY created_at, id')
    .all(practiceId);
}

/**
 * A practice's keys, newest first, each with **the asking member's** wrapped copy.
 *
 * The key belongs to the practice; the wrapped copy belongs to a person. A member who has just been
 * invited has a copy of a key they did not create, and a member who has never been sent a copy of the
 * newest key sees the key without one — which is a state worth being able to see rather than hiding,
 * because it means they cannot open anything encrypted to it.
 */
export function practiceKeys(db, practiceId, practitionerId) {
  return db
    .prepare(
      `SELECT k.id, k.public_key, k.created_at, w.wrapped_private_key
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
              c.name AS client_name,
              (SELECT COUNT(*) FROM request_item i
                WHERE i.request_id = r.id AND i.withdrawn_at IS NULL) AS item_count,
              (SELECT COUNT(DISTINCT u.request_item_id) FROM upload u
                 JOIN request_item i2 ON i2.id = u.request_item_id
                WHERE i2.request_id = r.id AND i2.withdrawn_at IS NULL) AS received_count
         FROM request r JOIN client c ON c.id = r.client_id
        WHERE r.practice_id = ?
          ${includeClosed ? '' : 'AND r.closed_at IS NULL'}
        ORDER BY r.created_at DESC`,
    )
    .all(practiceId)
    .map((row) => ({ ...row, outstanding_count: row.item_count - row.received_count }));
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
  return db
    .prepare(
      `SELECT id, label, note, position, withdrawn_at, attention_at, attention_note
         FROM request_item WHERE request_id = ? ORDER BY position, created_at`,
    )
    .all(requestId)
    .map((row) => ({
      id: row.id,
      label: row.label,
      note: row.note,
      withdrawn: row.withdrawn_at !== null,
      needsAttention: row.attention_at !== null,
      attentionNote: row.attention_note,
    }));
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
        `SELECT i.id, i.label, i.withdrawn_at, i.attention_at
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
              (SELECT k.public_key FROM practice_key k
                WHERE k.practice_id = r.practice_id
                ORDER BY k.created_at DESC, k.rowid DESC LIMIT 1) AS practice_public_key
         FROM access_token t
         JOIN request r ON r.id = t.request_id
         JOIN client c ON c.id = r.client_id
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
      .prepare('SELECT id, label, note, withdrawn_at FROM request_item WHERE id = ? AND request_id = ?')
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

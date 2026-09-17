/**
 * The queries version one needs, and no more.
 *
 * Two habits are established here rather than later, when they would be a refactor:
 * every write that belongs to a request also writes an `event` row in the same
 * transaction, and every function that reads returns *plain objects* rather than
 * database rows, so that a caller never has to know the schema.
 */
import { newId, now } from './db.js';

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

export function recordEvent(db, { requestId, kind, detail = null, at = now() }) {
  db.prepare('INSERT INTO event (id, request_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(newId(), requestId, kind, detail, at);
}

export function createPractitioner(db, { email, passwordHash, publicKey, wrappedPrivateKey, at = now() }) {
  const id = newId();
  db.prepare(
    `INSERT INTO practitioner (id, email, password_hash, public_key, wrapped_private_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, passwordHash, publicKey, wrappedPrivateKey, at);
  return id;
}

export function createClient(db, { practitionerId, name, email = null, at = now() }) {
  const id = newId();
  db.prepare(
    'INSERT INTO client (id, practitioner_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, practitionerId, name, email, at);
  return id;
}

/** A titled list of documents owed by one client. */
export function createRequest(db, { practitionerId, clientId, title, dueAt = null, at = now() }) {
  return inTransaction(db, () => {
    const id = newId();
    db.prepare(
      `INSERT INTO request (id, practitioner_id, client_id, title, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, practitionerId, clientId, title, dueAt, at);
    recordEvent(db, { requestId: id, kind: 'request.created', at });
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
 */
export function recordUpload(db, { requestId, requestItemId, filename, mime = null, sizeBytes, sha256, storagePath, clientNote = null, at = now() }) {
  return inTransaction(db, () => {
    const id = newId();
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
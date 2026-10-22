/** Tenant-local accounting for accepted ciphertext and bytes currently being written. */
export function storageUsage(db, { maxRows = 100_000 } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new RangeError('storage accounting row cap must be a positive integer');
  const saved = db.prepare('SELECT size_bytes AS bytes FROM upload LIMIT ?').all(maxRows + 1);
  const pending = db.prepare('SELECT reserved_bytes AS bytes FROM upload_reservation LIMIT ?').all(maxRows + 1);
  if (saved.length > maxRows || pending.length > maxRows) {
    throw new RangeError(`tenant storage accounting exceeds its ${maxRows} row safety cap`);
  }
  const savedBytes = saved.reduce((sum, row) => sum + Number(row.bytes), 0);
  const pendingBytes = pending.reduce((sum, row) => sum + Number(row.bytes), 0);
  if (!Number.isSafeInteger(savedBytes) || !Number.isSafeInteger(pendingBytes)) {
    throw new RangeError('tenant storage byte total exceeds the safe integer range');
  }
  return {
    logicalBytes: savedBytes + pendingBytes,
    documentBytes: savedBytes,
    reservedBytes: pendingBytes,
    documents: saved.length,
    activeUploads: pending.length,
  };
}

export function startStorageReservation(db, uploadId, at = new Date().toISOString()) {
  db.prepare('INSERT INTO upload_reservation (id, reserved_bytes, created_at) VALUES (?, 0, ?)').run(uploadId, at);
}

/** Called synchronously before each chunk reaches disk; BEGIN IMMEDIATE serializes concurrent writers. */
export function reserveStorageBytes(db, uploadId, bytes, quotaBytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError('reservation increment must be positive bytes');
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = storageUsage(db);
    const reservation = db.prepare('SELECT reserved_bytes FROM upload_reservation WHERE id = ?').get(uploadId);
    if (!reservation) throw new Error('upload reservation is missing');
    if (Number.isFinite(quotaBytes) && current.logicalBytes + bytes > quotaBytes) {
      db.exec('ROLLBACK');
      return { allowed: false, usedBytes: current.logicalBytes, quotaBytes };
    }
    db.prepare('UPDATE upload_reservation SET reserved_bytes = reserved_bytes + ? WHERE id = ?').run(bytes, uploadId);
    db.exec('COMMIT');
    return { allowed: true, usedBytes: current.logicalBytes + bytes, quotaBytes };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function releaseStorageReservation(db, uploadId) {
  db.prepare('DELETE FROM upload_reservation WHERE id = ?').run(uploadId);
}

/** Convert a reservation to a committed upload in the same transaction as the document row. */
export function settleStorageReservation(db, uploadId) {
  db.prepare('DELETE FROM upload_reservation WHERE id = ?').run(uploadId);
}
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function declaredUploadBytes(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new RangeError('invalid content length');
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) throw new RangeError('invalid content length');
  return bytes;
}


/** Apparent bytes inside a tenant blob tree, including staging and orphan files, without following links. */
export function measureTenantBlobTree(root, { maxFiles = 100_000 } = {}) {
  let files = 0;
  let bytes = 0;
  let skippedSymlinks = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files += 1;
        if (files > maxFiles) throw new RangeError(`blob tree exceeds the ${maxFiles} file scan limit`);
        bytes += lstatSync(path).size;
      }
    }
  };
  if (!existsSync(root)) return { files, bytes, skippedSymlinks };
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink()) return { files, bytes, skippedSymlinks: 1 };
  if (!rootInfo.isDirectory()) throw new Error('tenant blob root must be a directory');
  walk(root);
  return { files, bytes, skippedSymlinks };
}

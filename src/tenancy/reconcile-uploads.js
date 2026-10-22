import { lstat, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

/** Find and optionally remove aged, unreferenced ciphertext/staging files in one tenant only. */
export async function reconcileTenantUploads({
  db,
  blobDir,
  dryRun = true,
  at = new Date(),
  minAgeMs = DAY,
  staleReservationMs = DAY,
  maxFiles = 100_000,
  log = () => {},
} = {}) {
  if (!db || !blobDir) throw new TypeError('a tenant database and blob directory are required');
  const root = resolve(blobDir);
  const referenced = new Set();
  for (const row of db.prepare('SELECT id, request_id, storage_path FROM upload').all()) {
    const path = resolve(row.storage_path);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    referenced.add(rel.split(sep).join('/'));
  }

  const reservations = new Map(
    db.prepare('SELECT id, reserved_bytes, created_at FROM upload_reservation').all().map((row) => [row.id, row]),
  );
  const files = [];
  let symlinks = 0;
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('tenant blob root must be a real directory');
  } catch (error) {
    if (error.code === 'ENOENT') return { dryRun, candidates: [], deleted: [], symlinks, staleReservations: 0 };
    throw error;
  }
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(path);
      if (files.length > maxFiles) throw new RangeError(`tenant blob tree exceeds the ${maxFiles} file reconciliation limit`);
    }
  };
  try {
    await walk(root);
  } catch (error) {
    if (error.code === 'ENOENT') return { dryRun, candidates: [], deleted: [], symlinks, staleReservations: 0 };
    throw error;
  }

  const nowMs = at.getTime();
  const candidates = [];
  const fileRows = [];
  const recentlyModifiedIds = new Set();
  for (const path of files) {
    const info = await lstat(path);
    const name = basename(path);
    const id = name.replace(/\.(?:incoming|bin)$/, '');
    if (name.endsWith('.incoming') || name.endsWith('.bin')) {
      if (nowMs - info.mtimeMs < minAgeMs) recentlyModifiedIds.add(id);
    }
    fileRows.push({ path, info });
  }
  const staleIds = new Set();
  for (const [id, reservation] of reservations) {
    if (nowMs - Date.parse(reservation.created_at) >= staleReservationMs && !recentlyModifiedIds.has(id)) staleIds.add(id);
  }

  for (const { path, info } of fileRows) {
    const rel = relative(root, path).split(sep).join('/');
    if (referenced.has(rel)) continue;
    const name = basename(path);
    const incoming = name.endsWith('.incoming');
    const blob = name.endsWith('.bin');
    if (!incoming && !blob) continue;
    const id = name.replace(/\.(?:incoming|bin)$/, '');
    if (reservations.has(id) && !staleIds.has(id)) continue;
    if (info.isSymbolicLink() || !info.isFile() || nowMs - info.mtimeMs < minAgeMs) continue;
    candidates.push({ path, relativePath: rel, bytes: info.size, id });
  }

  if (!dryRun) {
    for (const candidate of candidates) await unlink(candidate.path);
    for (const id of staleIds) db.prepare('DELETE FROM upload_reservation WHERE id = ?').run(id);
    for (const candidate of candidates) {
      log('info', 'storage.orphan-removed', { bytes: candidate.bytes, fileKind: candidate.relativePath.endsWith('.incoming') ? 'staging' : 'ciphertext' });
    }
  }
  return {
    dryRun,
    candidates,
    deleted: dryRun ? [] : candidates,
    candidateBytes: candidates.reduce((sum, row) => sum + row.bytes, 0),
    staleReservations: staleIds.size,
    removedReservations: dryRun ? 0 : staleIds.size,
    symlinks,
    filesScanned: files.length,
  };
}

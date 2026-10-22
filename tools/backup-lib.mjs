/**
 * Taking and checking a backup, as functions rather than a command.
 *
 * Two callers now: `tools/backup.mjs`, which backs up the one installation on this machine, and
 * `tools/backup-all.mjs`, which walks a tenants root (and the registry that names them). Both need the same order
 * and the same check, and the thing this file exists to prevent is a *second implementation* of either.
 *
 * ### Why `VACUUM INTO` rather than `cp -r`
 *
 * Until the WAL release, copying the directory of a stopped server was a complete backup and the documentation
 * said so. WAL changed that: recent commits live in a `-wal` sidecar, so a copy of `data/*.db` on its own can
 * silently miss everything since the last checkpoint, and the copy looks fine. `VACUUM INTO` takes a
 * transactionally consistent snapshot of a **live** database — it reads through the write-ahead log, so nothing
 * committed is missed and a client uploading during the copy cannot produce a torn one.
 *
 * ### The order matters, and it is a rule rather than a preference
 *
 * **The database snapshot is taken first, then the files.** Every row in that snapshot points at a blob written
 * before the snapshot existed, so every row has a file to find. Copying the files first would leave a window where
 * a document exists on disk but its row is not yet in the snapshot — an orphan, which is harmless — while the
 * reverse leaves **a row pointing at a file that is not there**, which is a document a practice believes it has.
 *
 * The cost of this order is that files written *during* the copy may also be captured without a row. Those are
 * orphans in the backup, and verification counts them rather than ignoring them.
 *
 * ### Verified rather than trusted
 *
 * `verifyBackup` re-reads the manifest and then does the only check that matters: it opens the copy's database and
 * confirms that **every upload row's file is present in the copy**. A backup that opens is not the same as a
 * backup that has the documents in it, and the difference is invisible until the day somebody needs it. A registry
 * backup holds no documents by definition, so for one the check is that the tables a restore needs are readable.
 *
 * ### The contract
 *
 * Failures **throw**, with a message written for a person, rather than printing and exiting: the
 * single-installation tool turns that into one line and an exit code, and the fleet tool catches it per tenant so
 * that one broken practice does not stop the other forty-nine.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, lstat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/db.js';

/** What each kind of backup contains, and therefore what verifying one means. */
const KINDS = {
  practice: { documents: true },
  registry: { documents: false },
};

/** sha256 of a file, streamed so a large blob never has to fit in memory. */
function digestOf(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Every file under a directory, as paths relative to it, with forward slashes. */
export function filesUnder(root, { maxFiles = 100_000 } = {}) {
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing to follow a symbolic link inside ${root}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        found.push(relative(root, path).split(sep).join('/'));
        if (found.length > maxFiles) throw new RangeError(`directory exceeds the ${maxFiles} file scan limit`);
      }
    }
  };
  walk(root);
  return found;
}

/**
 * The database, alone, into an empty directory. The one thing both kinds of backup do first.
 *
 * A target with anything in it is refused rather than overwritten: a backup is something somebody took on purpose,
 * and a tool that silently replaces it is a tool that can destroy the copy taken before an upgrade.
 */
async function snapshotDatabase(source, to, { say }) {
  if (!existsSync(source)) {
    throw new Error(`There is no database at ${source}. Point --data at the directory that holds ${basename(source)}.`);
  }
  if (existsSync(to) && readdirSync(to).length > 0) {
    throw new Error(`${to} already has something in it. Backups are never overwritten — choose a new directory.`);
  }
  mkdirSync(to, { recursive: true });

  const target = join(to, basename(source));
  // This is a read-only snapshot connection. Running the application's opener here would execute
  // schema DDL/migrations and could conflict with an export's transactionally held writer lock.
  const db = new DatabaseSync(source);
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  say(`database   ${basename(source)}, ${(readFileSync(target).length / 1024 / 1024).toFixed(1)} MB`);
  return { file: basename(source), path: target };
}

/** What a practice's backup counts, for the manifest and for a person reading the tool's output. */
function practiceCounts(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    practices: count('practice'),
    people: count('practitioner'),
    clients: count('client'),
    requests: count('request'),
    uploads: count('upload'),
  };
}

/**
 * Take a practice's backup: its database, its documents, and a manifest that describes both.
 *
 * The manifest is written **last**, so it only ever exists for a copy that finished. An interrupted backup
 * therefore leaves a directory with no manifest, which verification refuses, rather than a manifest describing
 * something that is not there.
 */
export async function takeBackup(dataDir, to, { say = () => {}, fileFilter = () => true, includeBlobIntegrity = false } = {}) {
  const { file, path } = await snapshotDatabase(join(dataDir, 'tickmark.db'), to, { say });

  const db = openDatabase(path);
  const counts = practiceCounts(db);
  db.close();
  say(`contents   ${counts.practices} practices, ${counts.requests} requests, ${counts.uploads} files`);

  // The documents, after the rows that point at them. See the note at the top of this file for why that order is
  // the one that cannot lose a document.
  const blobs = join(dataDir, 'blobs');
  const blobFiles = filesUnder(blobs).filter(fileFilter);
  let bytes = 0;
  const blobIntegrity = [];
  for (const name of blobFiles) {
    const source = join(blobs, name);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing non-regular blob file ${name}`);
    const copy = join(to, 'blobs', name);
    mkdirSync(dirname(copy), { recursive: true });
    await copyFile(source, copy);
    bytes += info.size;
    if (includeBlobIntegrity) blobIntegrity.push({ path: name, bytes: info.size, sha256: await digestOf(source) });
  }
  say(`documents  ${blobFiles.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  const manifest = {
    format: 'tickmark-practice-backup',
    version: 2,
    kind: 'practice',
    at: new Date().toISOString(),
    from: dataDir,
    database: { file, bytes: readFileSync(path).length, sha256: await digestOf(path) },
    blobs: { files: blobFiles.length, bytes, ...(includeBlobIntegrity ? { integrity: blobIntegrity } : {}) },
    counts,
  };
  writeFileSync(join(to, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** What a registry's backup counts: exactly the rows a restore needs in order to name every practice. */
function registryCounts(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { accounts: count('account'), tenants: count('tenant'), hosts: count('tenant_host') };
}

/**
 * The file at the root of a fleet backup that says which practices it holds.
 *
 * Named differently from the per-practice `manifest.json` on purpose: a directory containing this is a *fleet*, and
 * one containing `manifest.json` is a single practice. Two names means a tool never has to guess which it is
 * looking at, and an operator can tell from `ls`.
 */
export const FLEET_FILE = 'fleet.json';

/**
 * Write it, last. Nothing else in the fleet tooling reads a directory that has no `fleet.json`, which is exactly
 * what makes an interrupted run safe rather than convincing.
 */
export async function writeFleetManifest(to, fleet) {
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, FLEET_FILE), `${JSON.stringify(fleet, null, 2)}\n`);
  return fleet;
}

/**
 * Verify every practice a fleet backup claims, and the registry with it.
 *
 * **It does not stop at the first failure.** Fifty practices where one is broken must say which one, and a tool that
 * throws on the first problem makes an operator re-run the whole check to find the second. Failures are collected
 * and returned; the caller decides what to print and what exit code to use.
 */
export async function verifyFleetBackup(to, { say = () => {} } = {}) {
  const file = join(to, FLEET_FILE);
  if (!existsSync(file)) throw new Error(`${to} has no ${FLEET_FILE}, so it is not a finished fleet backup.`);
  const fleet = JSON.parse(readFileSync(file, 'utf8'));

  const failures = [];
  if (fleet.format && fleet.format !== 'tickmark-hosted-backup') {
    failures.push({ id: 'fleet', label: 'fleet manifest', problems: [`unsupported fleet format: ${fleet.format}`] });
  }
  if (fleet.version !== undefined && fleet.version !== 2) {
    failures.push({ id: 'fleet', label: 'fleet manifest', problems: [`unsupported fleet version: ${fleet.version}`] });
  }

  const ids = new Set();
  for (const entry of fleet.practices ?? []) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry.id ?? '') || ids.has(entry.id)) {
      failures.push({ id: 'fleet', label: 'fleet manifest', problems: ['practice entries must have unique UUID ids'] });
      break;
    }
    ids.add(entry.id);
  }
  for (const entry of fleet.practices ?? []) {
    const label = entry.name ?? entry.slug ?? entry.id;
    say(`\n${label}  ${entry.id}`);
    try {
      await verifyBackup(join(to, entry.id), { say });
    } catch (error) {
      failures.push({ id: entry.id, label, problems: error.problems ?? [error.message] });
      say('  FAILED — see the list at the end.');
    }
  }

  // The registry, when the take side managed to include it. A fleet backup without one is reported by the take tool
  // as a failure, so verification treats a missing registry entry as a problem rather than as "nothing to check".
  if (fleet.registry) {
    say('\nregistry');
    try {
      const registry = await verifyBackup(join(to, 'registry'), { say });
      if (fleet.format === 'tickmark-hosted-backup') {
        const practiceIds = new Set((fleet.practices ?? []).map((entry) => entry.id));
        const missing = (registry.tenantIds ?? []).filter((id) => !practiceIds.has(id));
        if (missing.length) throw new Error(`registry names ${missing.length} practice directories absent from this backup: ${missing.slice(0, 5).join(', ')}`);
        for (const field of ['tenantIds', 'deletionTombstones', 'retentionHolds']) {
          if (JSON.stringify(fleet[field] ?? []) !== JSON.stringify(registry[field] ?? [])) {
            throw new Error(`fleet ${field} differ from the registry recovery metadata`);
          }
        }
      }
    } catch (error) {
      failures.push({ id: 'registry', label: 'registry', problems: error.problems ?? [error.message] });
      say('  FAILED — see the list at the end.');
    }
  } else {
    failures.push({ id: 'registry', label: 'registry', problems: ['this backup has no registry in it'] });
  }

  return { ...fleet, failures };
}

/**
 * Take the registry's backup: its database, and nothing else.
 *
 * The registry holds no documents and no plaintext — accounts, host names and subscription state — but without it
 * every practice on the machine is a directory nobody can sign in to, so a fleet backup that skipped it would be a
 * backup of the data rather than of the product.
 */
export async function takeDatabaseBackup(file, to, { say = () => {} } = {}) {
  const { file: name, path } = await snapshotDatabase(file, to, { say });

  const db = openDatabase(path);
  const counts = registryCounts(db);
  const tenantIds = db.prepare('SELECT id FROM tenant ORDER BY id').all().map((row) => row.id);
  const deletionTombstones = db.prepare(
    `SELECT tenant_id, slug_digest, state, requested_at, delete_after, completed_at, retention_hold_until
       FROM tenant_deletion ORDER BY tenant_id`,
  ).all();
  const retentionHolds = db.prepare(
    `SELECT id AS tenant_id, retention_hold_until FROM tenant
      WHERE retention_hold_until IS NOT NULL ORDER BY id`,
  ).all();
  db.close();
  say(`contents   ${counts.accounts} accounts, ${counts.tenants} tenants, ${counts.hosts} host names`);

  const manifest = {
    format: 'tickmark-practice-backup',
    version: 2,
    kind: 'registry',
    at: new Date().toISOString(),
    from: file,
    database: { file: name, bytes: readFileSync(path).length, sha256: await digestOf(path) },
    blobs: { files: 0, bytes: 0 },
    counts,
    tenantIds,
    deletionTombstones,
    retentionHolds,
  };
  writeFileSync(join(to, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Check a backup, and check the thing that matters.
 *
 * Throws with everything that is wrong, joined with a bullet each, so a caller can print one line per problem. A
 * manifest with no `kind` is a practice backup taken before the registry could be backed up at all, which is why
 * that is the default.
 */
export async function verifyBackup(to, { say = () => {} } = {}) {
  const manifestFile = join(to, 'manifest.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`${to} has no manifest.json, so it is not a finished backup. Nothing is verified.`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const kind = KINDS[manifest.kind ?? 'practice'];
  const problems = [];
  if (!kind) problems.push(`unsupported backup kind: ${String(manifest.kind)}`);
  if (manifest.format && manifest.format !== 'tickmark-practice-backup') problems.push(`unsupported backup format: ${manifest.format}`);
  if (manifest.version !== undefined && manifest.version !== 2) problems.push(`unsupported backup version: ${manifest.version}`);

  const database = join(to, manifest.database.file);
  if (!existsSync(database)) {
    problems.push(`the database is missing: ${database}`);
  } else if ((await digestOf(database)) !== manifest.database.sha256) {
    problems.push('the database has changed since the backup was taken');
  } else {
    say(`database   intact (${(manifest.database.bytes / 1024 / 1024).toFixed(1)} MB, taken ${manifest.at})`);
  }

  if (problems.length === 0 && kind.documents) {
    const db = openDatabase(database);
    const rows = db.prepare('SELECT storage_path, filename FROM upload').all();
    const present = new Set(filesUnder(join(to, 'blobs')));
    const missing = [];
    for (const row of rows) {
      // The stored path is absolute and belongs to the machine it was taken on, so what is compared is the last
      // two segments — the request id and the upload id — which are exactly what the copy preserves.
      const parts = String(row.storage_path).split(/[\\/]/).slice(-2).join('/');
      if (!present.has(parts)) missing.push(`${row.filename} (${parts})`);
    }
    const named = rows.length;
    db.close();

    if (missing.length > 0) {
      problems.push(
        `${missing.length} of ${named} documents are not in this backup. The rows that name them are, so a ` +
          `restore would look complete and be missing files. First few: ${missing.slice(0, 5).join(', ')}`,
      );
    } else {
      say(`documents  every one of the ${named} rows has its file present`);
    }

    const integrity = manifest.blobs?.integrity;
    if (integrity) {
      if (integrity.length !== manifest.blobs.files) {
        problems.push('the blob integrity manifest does not list every copied file');
      } else {
        for (const entry of integrity) {
          const file = join(to, 'blobs', entry.path);
          if (!present.has(entry.path) || (await digestOf(file)) !== entry.sha256 || (await lstat(file)).size !== entry.bytes) {
            problems.push(`blob integrity check failed: ${entry.path}`);
          }
        }
        if (problems.length === 0) say(`integrity  sha256 verified for all ${integrity.length} copied blob files`);
      }
    }

    const orphans = present.size - named;
    if (orphans > 0) {
      say(`note       ${orphans} file${orphans === 1 ? '' : 's'} with no row — written during the backup, and`);
      say('           harmless: a restore carries them and nothing reads them.');
    }
  }

  if (problems.length === 0 && !kind.documents) {
    // A registry has no documents to check, so the check is that what a restore *needs* is readable.
    const db = openDatabase(database);
    try {
      const counts = registryCounts(db);
      say(`contents   ${counts.accounts} accounts, ${counts.tenants} tenants, ${counts.hosts} host names, all readable`);
      const tenantIds = db.prepare('SELECT id FROM tenant ORDER BY id').all().map((row) => row.id);
      const deletionTombstones = db.prepare(
        `SELECT tenant_id, slug_digest, state, requested_at, delete_after, completed_at, retention_hold_until
           FROM tenant_deletion ORDER BY tenant_id`,
      ).all();
      const retentionHolds = db.prepare(
        `SELECT id AS tenant_id, retention_hold_until FROM tenant
          WHERE retention_hold_until IS NOT NULL ORDER BY id`,
      ).all();
      if (JSON.stringify(tenantIds) !== JSON.stringify(manifest.tenantIds ?? [])) problems.push('registry tenant list differs from its backup manifest');
      if (JSON.stringify(deletionTombstones) !== JSON.stringify(manifest.deletionTombstones ?? [])) problems.push('deletion tombstone list differs from its backup manifest');
      if (JSON.stringify(retentionHolds) !== JSON.stringify(manifest.retentionHolds ?? [])) problems.push('retention hold list differs from its backup manifest');
    } catch (error) {
      problems.push(`the copy does not hold a registry a restore could use: ${error.message}`);
    }
    db.close();
  }

  if (problems.length > 0) {
    const error = new Error(problems.join('\n  - '));
    error.problems = problems;
    throw error;
  }
  return manifest;
}

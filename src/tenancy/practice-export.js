import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { openDatabase } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { takeBackup } from '../../tools/backup-lib.mjs';
import { UNVERIFIABLE_PASSWORD_HASH } from './registry.js';

const FORMAT = 'tickmark-practice-export';
const VERSION = 1;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function safeBundlePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function referencedBlobNames(db, blobDir) {
  const root = resolve(blobDir);
  const paths = new Set();
  for (const row of db.prepare('SELECT id, request_id, storage_path FROM upload').all()) {
    const resolvedPath = resolve(row.storage_path);
    const rel = relative(root, resolvedPath);
    const name = rel.split(sep).join('/');
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || !safeBundlePath(name)) {
      throw new Error(`upload ${row.id} has a storage path outside its practice blob directory`);
    }
    paths.add(name);
  }
  return paths;
}

/** Create a portable, ciphertext-preserving owner export from a consistent tenant snapshot. */
export async function createPracticeExport({
  registry,
  tenantId,
  tenantsRoot,
  to,
  email,
  password,
  confirmTenantId,
  at = new Date(),
} = {}) {
  if (!registry || !tenantId || !tenantsRoot || !to) throw new TypeError('registry, tenant, source root and destination are required');
  if (confirmTenantId !== tenantId) throw new Error('explicit confirmation must exactly match the tenant id');
  const tenant = registry.prepare('SELECT * FROM tenant WHERE id = ?').get(tenantId);
  if (!tenant || tenant.lifecycle_state === 'deleted' || tenant.lifecycle_state === 'deleting') throw new Error('practice is not available for export');
  const account = registry.prepare('SELECT id, email, password_hash FROM account WHERE id = ?').get(tenant.owner_id);
  if (!account || account.email !== String(email).toLowerCase() || !(await verifyPassword(password, account.password_hash))) {
    throw new Error('the practice owner could not be verified');
  }

  const source = resolve(tenantsRoot, tenantId);
  const tenantsInfo = await lstat(resolve(tenantsRoot));
  if (!tenantsInfo.isDirectory() || tenantsInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');
  const tenantRelative = relative(resolve(tenantsRoot), source);
  if (!tenantRelative || tenantRelative === '..' || tenantRelative.startsWith(`..${sep}`) || isAbsolute(tenantRelative)) {
    throw new Error('tenant directory escaped the configured tenants root');
  }
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('tenant root must be a real directory');
  const target = resolve(to);
  if (target === source || target.startsWith(`${source}${sep}`) || source.startsWith(`${target}${sep}`)) {
    throw new Error('export destination must be outside the tenant directory');
  }
  try {
    await lstat(target);
    throw new Error('export destination already exists; choose a new empty path');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const db = openDatabase(join(source, 'tickmark.db'));
  let locked = false;
  let registrySnapshot = false;
  try {
    // Keep a stable view of identity metadata while copying. A read transaction does not block
    // registry writers, but it keeps the exported member list internally consistent.
    registry.exec('BEGIN');
    registrySnapshot = true;
    const members = registry.prepare(
      `SELECT a.id AS account_id, a.email, m.created_at AS joined_at
         FROM tenant_member m JOIN account a ON a.id = m.account_id
        WHERE m.tenant_id = ? ORDER BY a.email`,
    ).all(tenantId).map((member) => {
      const practitioner = db.prepare('SELECT id, role, created_at, removed_at FROM practitioner WHERE email = ?').get(member.email);
      return {
        accountId: member.account_id,
        email: member.email,
        joinedAt: member.joined_at,
        practitionerId: practitioner?.id ?? null,
        role: practitioner?.role ?? (member.account_id === tenant.owner_id ? 'owner' : null),
        practitionerCreatedAt: practitioner?.created_at ?? null,
        removedAt: practitioner?.removed_at ?? null,
      };
    });
    // Reserve SQLite's writer lock while the database snapshot and files are copied. New app writes
    // cannot commit during this interval; file-first operations can only add harmless unreferenced data.
    db.exec('BEGIN IMMEDIATE');
    locked = true;
    const blobNames = referencedBlobNames(db, join(source, 'blobs'));
    const backup = await takeBackup(source, target, {
      fileFilter: (name) => blobNames.has(name),
    });
    if (backup.blobs.files !== blobNames.size) throw new Error('a referenced ciphertext file was missing during export');
    db.exec('COMMIT');
    locked = false;
    registry.exec('COMMIT');
    registrySnapshot = false;

    const exportedDbPath = join(target, 'tickmark.db');
    const exportedDb = openDatabase(exportedDbPath);
    exportedDb.exec('BEGIN IMMEDIATE');
    try {
      exportedDb.prepare(
        `UPDATE practitioner SET password_hash = ?, totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL`,
      ).run(UNVERIFIABLE_PASSWORD_HASH);
      for (const table of ['session', 'login_challenge', 'recovery_code', 'password_reset', 'signup_token', 'access_token', 'invite', 'connection']) {
        exportedDb.prepare(`DELETE FROM ${table}`).run();
      }
      exportedDb.prepare('DELETE FROM upload_reservation').run();
      exportedDb.exec('COMMIT');
    } catch (error) {
      exportedDb.exec('ROLLBACK');
      throw error;
    } finally {
      exportedDb.close();
    }

    const practiceInfo = {
      format: FORMAT,
      formatVersion: VERSION,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, practiceId: tenant.practice_id, createdAt: tenant.created_at },
      members,
      notes: [
        'Documents remain in their existing encrypted envelope format; the export contains no plaintext documents.',
        'Password hashes, TOTP secrets, sessions, recovery codes, live client links, invitations, OAuth tokens and billing identifiers are omitted or disabled.',
        'Restore creates a new owner password. Each member must be provisioned again; wrapped practice keys are preserved.',
      ],
    };
    const practiceInfoPath = join(target, 'practice.json');
    await writeFile(practiceInfoPath, `${JSON.stringify(practiceInfo, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

    const files = [];
    const walk = async (directory, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (rel === 'manifest.json') continue;
        if (entry.isSymbolicLink()) throw new Error(`export bundle contains a symbolic link at ${rel}`);
        if (entry.isDirectory()) await walk(path, rel);
        else if (entry.isFile()) {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error(`export bundle contains a non-regular file at ${rel}`);
          files.push({ path: rel, bytes: info.size, sha256: await digestFile(path) });
        }
      }
    };
    await walk(target);
    const databaseFile = files.find((file) => file.path === 'tickmark.db');
    const manifest = {
      format: FORMAT,
      formatVersion: VERSION,
      createdAt: at.toISOString(),
      tenantId,
      dataModel: 'tickmark-practice-v1',
      snapshot: 'SQLite writer lock held across database snapshot and referenced blob copy',
      database: { file: 'tickmark.db', bytes: databaseFile.bytes, sha256: databaseFile.sha256 },
      blobs: { files: blobNames.size, bytes: files.filter((file) => file.path.startsWith('blobs/')).reduce((n, file) => n + file.bytes, 0) },
      files,
      excluded: ['platform registry', 'password hashes', 'TOTP secrets', 'sessions', 'recovery codes', 'client-link tokens', 'invitations', 'OAuth credentials', 'Stripe identifiers', 'plaintext documents'],
    };
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    return manifest;
  } catch (error) {
    if (locked) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    if (registrySnapshot) {
      try { registry.exec('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    db.close();
  }
}

/** Verify every bundle file and that every upload row maps to its matching ciphertext digest. */
export async function verifyPracticeExport(root) {
  const base = resolve(root);
  const manifestPath = join(base, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('export manifest must be a regular file');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== FORMAT || manifest.formatVersion !== VERSION || !Array.isArray(manifest.files)) {
    throw new Error('unsupported or incomplete Tickmark export format');
  }
  const declared = new Map();
  const actual = new Set();
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`export bundle contains a symbolic link at ${rel}`);
      if (entry.isDirectory()) await walk(path, rel);
      else if (entry.isFile() && rel !== 'manifest.json') actual.add(rel);
      else if (!entry.isFile()) throw new Error(`export bundle contains a non-regular file at ${rel}`);
    }
  };
  await walk(base);
  for (const file of manifest.files) {
    if (!safeBundlePath(file.path) || declared.has(file.path)) throw new Error('export manifest contains an unsafe or duplicate path');
    const path = join(base, ...file.path.split('/'));
    const rel = relative(base, resolve(path));
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('export file escaped its bundle directory');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || await digestFile(path) !== file.sha256) {
      throw new Error(`export integrity check failed for ${file.path}`);
    }
    declared.set(file.path, file);
  }
  if (actual.size !== declared.size || [...actual].some((path) => !declared.has(path))) {
    throw new Error('export bundle contains files outside its integrity manifest');
  }
  const databaseEntry = declared.get('tickmark.db');
  if (!databaseEntry) throw new Error('export database is missing from its manifest');
  const db = openDatabase(join(base, 'tickmark.db'));
  try {
    for (const row of db.prepare('SELECT id, request_id, storage_path, size_bytes, sha256 FROM upload').all()) {
      const rel = `blobs/${row.request_id}/${row.id}.bin`;
      const file = declared.get(rel);
      if (!file || file.bytes !== row.size_bytes || file.sha256 !== row.sha256) {
        throw new Error(`export does not match upload ${row.id}`);
      }
      if (!String(row.storage_path).replaceAll('\\', '/').endsWith(`/${row.request_id}/${row.id}.bin`)) {
        throw new Error(`upload ${row.id} has an unexpected stored path`);
      }
    }
    return manifest;
  } finally {
    db.close();
  }
}

/** Restore an export into a new self-hosted data directory with a newly chosen owner password. */
export async function restorePracticeExport({ from, to, ownerEmail, ownerPassword, confirmTenantId } = {}) {
  const manifest = await verifyPracticeExport(from);
  if (confirmTenantId !== manifest.tenantId) throw new Error('explicit confirmation must exactly match the export tenant id');
  const target = resolve(to);
  try {
    await lstat(target);
    throw new Error('restore destination already exists; choose a new empty path');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const info = JSON.parse(await readFile(join(from, 'practice.json'), 'utf8'));
  const owner = info.members.find((member) => member.email === String(ownerEmail).toLowerCase() && member.role === 'owner' && !member.removedAt);
  if (!owner) throw new Error('the requested email is not an active exported practice owner');
  if (typeof ownerPassword !== 'string' || ownerPassword.length < 12) throw new Error('new owner password must be at least 12 characters');

  await mkdir(join(target, 'blobs'), { recursive: true });
  for (const file of manifest.files) {
    const source = join(resolve(from), ...file.path.split('/'));
    const destination = join(target, ...file.path.split('/'));
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true });
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`refusing unsafe export file ${file.path}`);
    await copyFile(source, destination);
  }

  const db = openDatabase(join(target, 'tickmark.db'));
  try {
    const updatePath = db.prepare('UPDATE upload SET storage_path = ? WHERE id = ? AND request_id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT id, request_id FROM upload').all()) {
        updatePath.run(join(target, 'blobs', row.request_id, `${row.id}.bin`), row.id, row.request_id);
      }
      const passwordHash = await hashPassword(ownerPassword);
      const changed = db.prepare(
        `UPDATE practitioner SET password_hash = ?, totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL
          WHERE email = ? AND (role = 'owner' OR role IS NULL) AND removed_at IS NULL`,
      ).run(passwordHash, String(ownerEmail).toLowerCase()).changes;
      if (changed !== 1) throw new Error('restored owner practitioner was not found');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  return { tenantId: manifest.tenantId, destination: target, documents: manifest.blobs.files, bytes: manifest.blobs.bytes };
}

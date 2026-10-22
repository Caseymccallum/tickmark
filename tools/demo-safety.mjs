import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const PREFIX = 'tickmark-demo-';
const MARKER = '.tickmark-demo.json';
const LOCK = '.tickmark-demo.lock';

function refuseLinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const item = join(root, entry.name);
    const info = lstatSync(item);
    if (info.isSymbolicLink()) throw new Error(`Refusing reset: linked file or directory found at ${item}.`);
    if (info.isDirectory()) refuseLinks(item);
  }
}

/** Create a new, unique demo folder directly under the operating system's temporary directory. */
export function createDemoDirectory() {
  return mkdtempSync(join(tmpdir(), PREFIX));
}

/** Create a caller-named new path only when it is a direct, prefixed child of the real temp directory. */
export function createDemoDirectoryAt(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Choose the exact Tickmark demo directory.');
  const target = resolve(path);
  const parent = resolve(tmpdir());
  if (dirname(target) !== parent || !basename(target).startsWith(PREFIX)) {
    throw new Error(`Refusing unsafe demo path. A demo must be a direct child of ${parent} named ${PREFIX}<random>.`);
  }
  if (realpathSync(parent) !== parent) throw new Error('Refusing demo path: the operating system temporary directory resolves through a link.');
  mkdirSync(target, { recursive: false });
  return validateDemoDirectory(target);
}

/** Validate a demo directory before seeding or deleting it; caller paths never get recursive deletion authority. */
export function validateDemoDirectory(path, { requireMarker = false } = {}) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Choose the exact Tickmark demo directory.');
  const target = resolve(path);
  const parent = resolve(tmpdir());
  if (realpathSync(parent) !== parent) throw new Error('Refusing demo path: the operating system temporary directory resolves through a link.');
  if (dirname(target) !== parent || !basename(target).startsWith(PREFIX)) {
    throw new Error(`Refusing unsafe demo path. A demo must be a direct child of ${parent} named ${PREFIX}<random>.`);
  }
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refusing a demo path that is not a real directory.');
  if (realpathSync(target) !== target) throw new Error('Refusing a demo path that resolves through a link.');
  if (requireMarker) {
    const markerPath = join(target, MARKER);
    if (!existsSync(markerPath)) throw new Error('Refusing reset: the Tickmark demo marker is missing or unsafe.');
    const markerInfo = lstatSync(markerPath);
    if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) throw new Error('Refusing reset: the Tickmark demo marker is missing or unsafe.');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.type !== 'tickmark-local-demo' || marker.id !== basename(target).slice(PREFIX.length)) {
      throw new Error('Refusing reset: the demo marker does not match this directory.');
    }
  }
  return target;
}

export function markDemoDirectory(path) {
  const target = validateDemoDirectory(path);
  const id = basename(target).slice(PREFIX.length);
  writeFileSync(join(target, MARKER), `${JSON.stringify({ type: 'tickmark-local-demo', id, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return target;
}

export function acquireDemoLock(path) {
  const target = validateDemoDirectory(path, { requireMarker: true });
  const lockPath = join(target, LOCK);
  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
  return lockPath;
}

export function releaseDemoLock(path) {
  const target = validateDemoDirectory(path, { requireMarker: true });
  const lockPath = join(target, LOCK);
  if (!existsSync(lockPath)) return;
  const info = lstatSync(lockPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing to remove an unsafe demo lock.');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.pid !== process.pid) throw new Error('Refusing to remove a demo lock owned by another process.');
  unlinkSync(lockPath);
}

export function removeDemoDirectory(path) {
  const target = validateDemoDirectory(path, { requireMarker: true });
  // Re-check the containing directory immediately before removal. The unique, direct-child path is never
  // inferred from the current working directory and no wildcard is involved.
  if (realpathSync(dirname(target)) !== resolve(tmpdir())) throw new Error('Refusing reset: temporary directory changed.');
  const lockPath = join(target, LOCK);
  if (existsSync(lockPath)) {
    const lockInfo = lstatSync(lockPath);
    if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) throw new Error('Refusing reset: the demo lock is unsafe.');
    let pid;
    try { pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid; } catch { throw new Error('Refusing reset: the demo lock cannot be verified.'); }
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Refusing reset: the demo lock has no valid process id.');
    try {
      process.kill(pid, 0);
      throw new Error('Refusing reset: this demo is still running. Stop it before resetting its data.');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      // A crashed demo can leave its lock behind; an absent process is checked before this exact lock is removed.
      unlinkSync(lockPath);
    }
  }
  refuseLinks(target);
  rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
}

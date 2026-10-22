#!/usr/bin/env node
/**
 * Make and protect one complete hosted recovery point with Restic.
 *
 * Run only while the hosted application and its maintenance CLIs are stopped. Each SQLite file is individually
 * snapshotted with the existing backup-all tooling; quiescence makes those snapshots one cross-file point in time.
 * Restic encrypts and authenticates the temporary recovery set before sending it to the operator's repository.
 */
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: process.env.TICKMARK_DATA ?? 'data' },
    staging: { type: 'string', default: process.env.TICKMARK_BACKUP_STAGING ?? tmpdir() },
    status: { type: 'string' },
    'max-age-hours': { type: 'string', default: '26' },
    'retention-days': { type: 'string', default: '35' },
    'restic-bin': { type: 'string', default: process.env.RESTIC_BIN ?? 'restic' },
    'check-status': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const dataDir = resolve(values.data);
const stageRoot = resolve(values.staging);
const statusFile = resolve(values.status ?? join(dataDir, 'hosted-backup-status.json'));
const lockFile = join(dataDir, '.hosted-operations.lock');
const retentionDays = Number(values['retention-days']);
const maxAgeHours = Number(values['max-age-hours']);
const started = Date.now();
const resticPrefix = JSON.parse(process.env.RESTIC_BIN_ARGS ?? '[]');
if (!Array.isArray(resticPrefix) || resticPrefix.some((part) => typeof part !== 'string')) throw new Error('RESTIC_BIN_ARGS must be a JSON array of strings');

const emit = (level, event, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === 'error' ? console.error : console.log)(line);
};

function requiredEnvironment() {
  if (!process.env.RESTIC_REPOSITORY) throw new Error('RESTIC_REPOSITORY is required');
  if (!process.env.RESTIC_PASSWORD_FILE) throw new Error('RESTIC_PASSWORD_FILE is required');
}

function run(command, args, { cwd, env = process.env, capture = false, restic = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, restic ? [...resticPrefix, ...args] : args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (capture) stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`${command} could not start (${error.code ?? 'spawn error'})`)));
    child.on('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`${command} failed (exit ${code ?? signal ?? 'unknown'})`));
      resolveRun({ stdout, stderr });
    });
  });
}

async function writeStatus(status) {
  await mkdir(resolve(statusFile, '..'), { recursive: true });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statusFile);
}

async function acquireLock() {
  await mkdir(dataDir, { recursive: true });
  const handle = await open(lockFile, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('another hosted backup holds the lock; inspect it before retrying');
    throw error;
  });
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  return async () => {
    await handle.close();
    await rm(lockFile, { force: true });
  };
}

async function ensureApplicationStopped() {
  const port = Number(process.env.TICKMARK_PORT ?? process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TICKMARK_PORT must be a valid TCP port');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    if (response.ok || response.status > 0) throw new Error(`the application answered on port ${port}; stop it before backing up`);
  } catch (error) {
    if (error.message.includes('stop it before backing up')) throw error;
    if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'AbortError'].includes(error.cause?.code ?? error.name)) {
      throw new Error(`could not confirm the application is stopped on port ${port}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function checkStatus() {
  const state = JSON.parse(await readFile(statusFile, 'utf8'));
  if (state.state !== 'success' || !state.completedAt) throw new Error('the last hosted backup did not complete successfully');
  const ageMs = Date.now() - Date.parse(state.completedAt);
  if (!Number.isFinite(ageMs) || ageMs > maxAgeHours * 3600000) throw new Error(`the last verified off-site backup is older than ${maxAgeHours} hours`);
  emit('info', 'backup.age', { ageHours: Math.round(ageMs / 360000) / 10, completedAt: state.completedAt });
}

async function checkPasswordFile() {
  const path = resolve(process.env.RESTIC_PASSWORD_FILE);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('RESTIC_PASSWORD_FILE must name a non-empty regular file');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Restic password file permissions must be 0600 or stricter');
}

async function treeBytes(root) {
  let count = 0;
  let bytes = 0;
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing to estimate a data tree containing a symbolic link`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        count += 1;
        if (count > 100_000) throw new Error('hosted data tree exceeds the 100000-file backup preflight limit');
        bytes += (await lstat(path)).size;
      }
    }
  };
  await walk(root);
  return bytes;
}

async function checkStagingCapacity() {
  const expected = await treeBytes(dataDir);
  const available = await statfs(stageRoot);
  const free = Number(available.bavail) * Number(available.bsize);
  const required = Math.ceil(expected * 1.1) + 256 * 1024 * 1024;
  if (free < required) throw new Error(`backup staging space is low (${free} free bytes; ${required} required for a verified copy)`);
  emit('info', 'backup.capacity', { sourceBytes: expected, stagingFreeBytes: free, stagingRequiredBytes: required });
}

function resticEnvironment() {
  const env = { ...process.env, RESTIC_PASSWORD_FILE: resolve(process.env.RESTIC_PASSWORD_FILE) };
  const repo = process.env.RESTIC_REPOSITORY;
  if (!isAbsolute(repo) && !/^[a-z][a-z0-9+.-]*:/i.test(repo)) env.RESTIC_REPOSITORY = resolve(repo);
  return env;
}

if (values['check-status']) {
  try { await checkStatus(); } catch (error) { emit('error', 'backup.stale', { reason: error.message }); process.exitCode = 1; }
} else {
  let releaseLock;
  let lockHeld = false;
  let staging;
  let completed = false;
  let failure = null;
  try {
    requiredEnvironment();
    if (!Number.isInteger(retentionDays) || retentionDays < 2 || retentionDays > 365) throw new Error('retention days must be 2–365');
    await checkPasswordFile();
    releaseLock = await acquireLock();
    lockHeld = true;
    await ensureApplicationStopped();
    await mkdir(stageRoot, { recursive: true, mode: 0o700 });
    await checkStagingCapacity();
    staging = await mkdtemp(join(stageRoot, 'tickmark-hosted-'));
    await chmod(staging, 0o700);

    const node = process.execPath;
    const backupTool = fileURLToPath(new URL('./backup-all.mjs', import.meta.url));
    await run(node, [backupTool, '--data', dataDir, '--to', staging, '--quiet']);
    let fleetText;
    try { fleetText = await readFile(join(staging, 'fleet.json'), 'utf8'); }
    catch { throw new Error('the local backup tool did not produce a fleet manifest'); }
    const fleet = JSON.parse(fleetText);
    if (fleet.failed?.length || !fleet.registry || fleet.practices?.length !== fleet.verified) {
      throw new Error('the local fleet snapshot is incomplete; it was not sent off-site');
    }

    const restic = values['restic-bin'];
    const resticEnv = resticEnvironment();
    const tags = ['--tag', 'tickmark-hosted'];
    await run(restic, ['backup', '--host', 'tickmark', ...tags, '.'], { cwd: staging, env: resticEnv, restic: true });
    const holdRows = [ ...(fleet.retentionHolds ?? []), ...(fleet.deletionTombstones ?? []) ]
      .map((row) => row.retention_hold_until)
      .filter(Boolean);
    let held = false;
    for (const until of holdRows) {
      const date = Date.parse(until);
      if (!Number.isFinite(date)) throw new Error('retention hold metadata is invalid; automatic backup expiry is disabled');
      if (date > Date.now()) held = true;
    }
    if (held) {
      emit('warn', 'backup.retention-held', { reason: 'at least one active retention hold exists; snapshots were not expired' });
    } else {
      await run(restic, ['forget', ...tags, '--keep-within', `${retentionDays}d`, '--prune'], { env: resticEnv, restic: true });
    }
    await run(restic, ['check'], { env: resticEnv, restic: true });
    const snapshotsResult = await run(restic, ['snapshots', '--json', ...tags], { capture: true, env: resticEnv, restic: true });
    const snapshots = JSON.parse(snapshotsResult.stdout);
    const latest = snapshots.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
    if (!latest || Date.parse(latest.time) < started - 60_000) throw new Error('Restic did not report the new hosted snapshot');

    const completedAt = new Date().toISOString();
    const state = {
      format: 'tickmark-hosted-backup-status',
      version: 1,
      state: 'success',
      completedAt,
      durationMs: Date.now() - started,
      snapshotId: latest.short_id ?? latest.id,
      practices: fleet.practices.length,
      documents: fleet.documents,
      bytes: fleet.bytes,
      retentionDays,
      retentionDeferred: held,
    };
    await writeStatus(state);
    emit('info', 'backup.completed', state);
    completed = true;
  } catch (error) {
    failure = error;
    if (lockHeld) {
      try {
        await writeStatus({ format: 'tickmark-hosted-backup-status', version: 1, state: 'failed', failedAt: new Date().toISOString(), durationMs: Date.now() - started, reason: error.message });
      } catch { /* the process exit and structured stderr remain the signal if the status volume is unavailable */ }
    }
    emit('error', 'backup.failed', { durationMs: Date.now() - started, reason: error.message });
  } finally {
    if (staging) {
      try {
        await rm(staging, { recursive: true, force: true });
      } catch (error) {
        completed = false;
        failure ??= new Error(`private plaintext backup staging could not be removed (${error.code ?? 'filesystem error'})`);
        if (lockHeld) {
          try {
            await writeStatus({ format: 'tickmark-hosted-backup-status', version: 1, state: 'failed', failedAt: new Date().toISOString(), durationMs: Date.now() - started, reason: failure.message });
          } catch { /* stderr and a nonzero exit remain the signal if the status volume is unavailable */ }
        }
        emit('error', 'backup.staging-cleanup.failed', { reason: failure.message });
      }
    }
    if (releaseLock) await releaseLock().catch(() => {});
  }
  if (!completed || failure) process.exitCode = 1;
}

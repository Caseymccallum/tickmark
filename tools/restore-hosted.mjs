#!/usr/bin/env node
/** Restore a complete hosted recovery set into a new data directory, then replay the newest deletion ledger. */
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { openRegistry } from '../src/tenancy/registry.js';
import { applyBackupDeletionTombstones } from '../src/tenancy/restore-tombstones.js';

const { values } = parseArgs({ options: {
  snapshot: { type: 'string', default: 'latest' },
  to: { type: 'string' },
  staging: { type: 'string' },
  'restic-bin': { type: 'string', default: process.env.RESTIC_BIN ?? 'restic' },
} });
if (!values.to || !process.env.RESTIC_REPOSITORY || !process.env.RESTIC_PASSWORD_FILE) {
  throw new Error('--to <new-data-directory>, RESTIC_REPOSITORY, and RESTIC_PASSWORD_FILE are required');
}
const target = resolve(values.to);
const targetParent = dirname(target);
const started = Date.now();
const resticPrefix = JSON.parse(process.env.RESTIC_BIN_ARGS ?? '[]');
if (!Array.isArray(resticPrefix) || resticPrefix.some((part) => typeof part !== 'string')) throw new Error('RESTIC_BIN_ARGS must be a JSON array of strings');
const run = (args, { cwd, capture = false } = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(values['restic-bin'], [...resticPrefix, ...args], { cwd, env: resticEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (chunk) => { if (capture) stdout += chunk; });
  child.on('error', (error) => reject(new Error(`Restic could not start (${error.code ?? 'spawn error'})`)));
  child.on('close', (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`Restic command failed (exit ${code ?? 'unknown'})`)));
});

function resticEnvironment() {
  const env = { ...process.env, RESTIC_PASSWORD_FILE: resolve(process.env.RESTIC_PASSWORD_FILE) };
  const repository = process.env.RESTIC_REPOSITORY;
  if (!isAbsolute(repository) && !/^[a-z][a-z0-9+.-]*:/i.test(repository)) env.RESTIC_REPOSITORY = resolve(repository);
  return env;
}

async function findFleetRoot(root) {
  let matches = [];
  async function walk(directory, depth) {
    if (depth > 12) throw new Error('Restic restore has unexpected nesting; refusing to guess the recovery-set root');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('restored backup contains a symbolic link; refusing to follow it');
      if (entry.isFile() && entry.name === 'fleet.json') matches.push(directory);
      if (entry.isDirectory()) await walk(path, depth + 1);
    }
  }
  await walk(root, 0);
  if (matches.length !== 1) throw new Error(`expected exactly one fleet.json in the restored snapshot, found ${matches.length}`);
  return matches[0];
}

function validateFleet(fleet) {
  if (fleet.format !== 'tickmark-hosted-backup' || fleet.version !== 2 || !Array.isArray(fleet.practices) || !fleet.registry || !Array.isArray(fleet.deletionTombstones)) {
    throw new Error('snapshot has no supported complete hosted fleet manifest');
  }
  for (const entry of fleet.practices) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry.id ?? '')) throw new Error('fleet manifest has an unsafe practice id');
  }
}

async function snapshotList() {
  const snapshots = JSON.parse(await run(['snapshots', '--json', '--tag', 'tickmark-hosted'], { capture: true }));
  if (!Array.isArray(snapshots) || snapshots.length === 0 || snapshots.some((snapshot) => !Number.isFinite(Date.parse(snapshot.time)))) {
    throw new Error('the Restic repository has no valid hosted Tickmark snapshot list');
  }
  return snapshots.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

async function main() {
  await mkdir(targetParent, { recursive: true });
  const parentInfo = await lstat(targetParent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('restore target parent must be a real directory');
  try { await lstat(target); throw new Error('restore target already exists; choose a new empty data directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const snapshots = await snapshotList();
  const latest = snapshots.at(-1);
  const selected = values.snapshot === 'latest' ? latest : snapshots.find((item) => item.id === values.snapshot || item.short_id === values.snapshot);
  if (!selected) throw new Error('requested Restic snapshot was not found in the hosted Tickmark set');
  const latestLedger = validateLatestLedger(await run(['dump', latest.id, 'fleet.json'], { capture: true }));

  const stageBase = resolve(values.staging ?? targetParent);
  await mkdir(stageBase, { recursive: true, mode: 0o700 });
  const stageInfo = await lstat(stageBase);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw new Error('restore staging path must be a real directory');
  if (stageInfo.dev !== parentInfo.dev) throw new Error('restore staging and target must be on the same filesystem for atomic promotion');
  const stagingRoot = await mkdtemp(join(stageBase, 'tickmark-restore-'));
  await chmodDirectory(stagingRoot);
  const restoredSnapshot = join(stagingRoot, 'snapshot');
  await mkdir(restoredSnapshot);
  let completion;
  try {
    await run(['restore', selected.id, '--target', restoredSnapshot]);
    const recoveryRoot = await findFleetRoot(restoredSnapshot);
    const selectedFleet = JSON.parse(await readFile(join(recoveryRoot, 'fleet.json'), 'utf8'));
    validateFleet(selectedFleet);

    const verifyTool = fileURLToPath(new URL('./backup-all.mjs', import.meta.url));
    await nodeRun(verifyTool, ['--verify', recoveryRoot, '--quiet']);

    const registrySource = join(recoveryRoot, 'registry', 'saas.db');
    if (!(await lstat(registrySource)).isFile()) throw new Error('restored registry database is missing');
    const targetStage = join(stagingRoot, 'data');
    const tenantsTarget = join(targetStage, 'tenants');
    await mkdir(tenantsTarget, { recursive: true, mode: 0o700 });
    await cp(registrySource, join(targetStage, 'saas.db'));
    for (const entry of selectedFleet.practices) {
      await cp(join(recoveryRoot, entry.id), join(tenantsTarget, entry.id), { recursive: true, errorOnExist: true, force: false });
    }

    const registry = openRegistry(join(targetStage, 'saas.db'));
    let outcomes;
    try {
      outcomes = await applyBackupDeletionTombstones(registry, {
        tenantsRoot: tenantsTarget,
        tombstones: latestLedger.deletionTombstones,
      });
    } finally {
      registry.close();
    }
    await rename(targetStage, target);
    const completedAt = new Date().toISOString();
    completion = {
      event: 'restore.completed',
      snapshotId: selected.short_id ?? selected.id,
      snapshotAt: selected.time,
      recoveryPointAgeMs: Date.parse(completedAt) - Date.parse(selected.time),
      restoreDurationMs: Date.now() - started,
      practicesInSnapshot: selectedFleet.practices.length,
      deletionTombstonesReplayed: outcomes.length,
      target,
      serviceStarted: false,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify(completion));
}

function validateLatestLedger(json) {
  const fleet = JSON.parse(json);
  validateFleet(fleet);
  return fleet;
}

async function chmodDirectory(path) {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o700);
}

function nodeRun(tool, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [tool, ...args], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', (error) => reject(new Error(`local backup verifier could not start (${error.code ?? 'spawn error'})`)));
    child.on('close', (code) => code === 0 ? resolveRun() : reject(new Error(`restored hosted backup failed local integrity verification (exit ${code ?? 'unknown'})`)));
  });
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ event: 'restore.failed', durationMs: Date.now() - started, reason: error.message }));
  process.exitCode = 1;
}

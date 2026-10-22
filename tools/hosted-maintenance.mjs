#!/usr/bin/env node
/** Serialize hosted maintenance and provide an auditable dry-run/apply summary. */
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  data: { type: 'string', default: process.env.TICKMARK_DATA ?? 'data' },
  port: { type: 'string', default: process.env.PORT ?? '3000' },
  'batch-size': { type: 'string', default: '100' },
  apply: { type: 'boolean', default: false },
} });
const dataDir = resolve(values.data);
const tenantsRoot = join(dataDir, 'tenants');
const lockFile = join(dataDir, '.hosted-operations.lock');
const statusFile = join(dataDir, 'hosted-maintenance-status.json');
const port = Number(values.port);
const batchSize = Number(values['batch-size']);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a valid TCP port');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('--batch-size must be 1–1000');

const emit = (level, event, fields = {}) => {
  (level === 'error' ? console.error : console.log)(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
};

async function applicationIsStopped() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    return false;
  } catch (error) {
    const code = error.cause?.code ?? error.name;
    if (['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'AbortError'].includes(code)) return true;
    throw new Error('could not confirm the hosted application is stopped');
  } finally {
    clearTimeout(timeout);
  }
}

async function acquireLock() {
  await mkdir(dataDir, { recursive: true });
  const handle = await open(lockFile, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('another hosted operation holds the lock; inspect it before retrying');
    throw error;
  });
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), operation: 'maintenance' })}\n`);
  return async () => { await handle.close(); await rm(lockFile, { force: true }); };
}

function run(tool, args) {
  const path = fileURLToPath(new URL(tool, import.meta.url));
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [path, ...args], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', (error) => reject(new Error(`maintenance command could not start (${error.code ?? 'spawn error'})`)));
    child.on('close', (code) => code === 0 ? resolveRun() : reject(new Error(`maintenance command failed (exit ${code ?? 'unknown'})`)));
  });
}

async function tenantIds() {
  const rootInfo = await lstat(tenantsRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');
  const entries = await readdir(tenantsRoot, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry.name)) continue;
    try {
      const dbInfo = await lstat(join(tenantsRoot, entry.name, 'tickmark.db'));
      if (dbInfo.isFile() && !dbInfo.isSymbolicLink()) found.push(entry.name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return found.sort();
}

async function runTasks() {
  const outcomes = [];
  const modeArgs = values.apply ? ['--apply'] : [];
  const common = ['--data', dataDir];
  const tasks = [
    ['pending-payment-retention', 'reap-pending-tenants.mjs', [...common, '--batch-size', String(batchSize), ...modeArgs]],
    ['tenant-deletion-finalization', 'finalize-deletions.mjs', [...common, '--batch-size', String(batchSize), ...modeArgs]],
  ];
  for (const [name, tool, args] of tasks) {
    try { await run(`./${tool}`, args); outcomes.push({ name, state: 'ok' }); }
    catch (error) { outcomes.push({ name, state: 'failed', reason: error.message }); }
  }

  let ids = [];
  try { ids = await tenantIds(); } catch (error) { outcomes.push({ name: 'tenant-scan', state: 'failed', reason: error.message }); }
  let reconciled = 0;
  for (const tenant of ids) {
    try {
      await run('./reconcile-uploads.mjs', [...common, '--tenant', tenant, '--older-than-hours', '24', ...modeArgs]);
      reconciled += 1;
    } catch (error) { outcomes.push({ name: 'upload-reconciliation', tenant, state: 'failed', reason: error.message }); }
  }
  let nearQuota = 0;
  for (const tenant of ids) {
    try {
      const path = fileURLToPath(new URL('./storage-report.mjs', import.meta.url));
      const child = spawn(process.execPath, [path, ...common, '--tenant', tenant], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      const code = await new Promise((resolveRun, reject) => {
        child.on('error', (error) => reject(new Error(`storage report could not start (${error.code ?? 'spawn error'})`)));
        child.on('close', resolveRun);
      });
      if (code !== 0) throw new Error(`storage report failed (exit ${code})`);
      const report = JSON.parse(output);
      if (report.logical.quotaPercent >= 80) nearQuota += 1;
    } catch (error) { outcomes.push({ name: 'quota-report', tenant, state: 'failed', reason: error.message }); }
  }
  return { outcomes, tenants: ids.length, reconciled, nearQuota };
}

let releaseLock;
let result;
try {
  if (!(await applicationIsStopped())) throw new Error(`the application answered on port ${port}; stop it before maintenance`);
  releaseLock = await acquireLock();
  result = await runTasks();
} catch (error) {
  result = { outcomes: [{ name: 'hosted-maintenance', state: 'failed', reason: error.message }], tenants: 0, reconciled: 0, nearQuota: 0 };
} finally {
  if (releaseLock) await releaseLock().catch(() => {});
}

const failed = result.outcomes.filter((outcome) => outcome.state === 'failed');
const state = {
  format: 'tickmark-hosted-maintenance-status',
  version: 1,
  state: failed.length ? 'failed' : 'success',
  completedAt: new Date().toISOString(),
  mode: values.apply ? 'apply' : 'dry-run',
  tenants: result.tenants,
  reconciled: result.reconciled,
  nearQuota: result.nearQuota,
  outcomes: result.outcomes,
};
await mkdir(dataDir, { recursive: true });
const temporary = `${statusFile}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, statusFile);
emit(failed.length ? 'error' : 'info', failed.length ? 'maintenance.failed' : 'maintenance.completed', {
  mode: state.mode, tenants: state.tenants, reconciled: state.reconciled, nearQuota: state.nearQuota, failures: failed.length,
});
if (failed.length) process.exitCode = 1;

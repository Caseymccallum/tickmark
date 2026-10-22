#!/usr/bin/env node
/** Read-only report of the Restic snapshots that contain a hosted tenant. */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { tenant: { type: 'string' }, 'restic-bin': { type: 'string', default: process.env.RESTIC_BIN ?? 'restic' }, 'retention-days': { type: 'string', default: '35' } } });
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const resticPrefix = JSON.parse(process.env.RESTIC_BIN_ARGS ?? '[]');
if (!Array.isArray(resticPrefix) || resticPrefix.some((part) => typeof part !== 'string')) throw new Error('RESTIC_BIN_ARGS must be a JSON array of strings');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(values['restic-bin'], [...resticPrefix, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => reject(new Error(`Restic could not start (${error.code ?? 'spawn error'})`)));
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`Restic command failed (exit ${code ?? 'unknown'})`)));
  });
}

if (!uuid.test(values.tenant ?? '')) throw new Error('--tenant must be a UUID');
if (!process.env.RESTIC_REPOSITORY || !process.env.RESTIC_PASSWORD_FILE) throw new Error('RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE are required');
const keepDays = Number(values['retention-days']);
if (!Number.isInteger(keepDays) || keepDays < 2 || keepDays > 365) throw new Error('--retention-days must be 2–365');

const snapshots = JSON.parse(await run(['snapshots', '--json', '--tag', 'tickmark-hosted']));
const matches = [];
for (const snapshot of snapshots) {
  let fleet;
  try {
    fleet = JSON.parse(await run(['dump', snapshot.id, 'fleet.json']));
  } catch {
    throw new Error(`could not read the fleet manifest from snapshot ${snapshot.short_id ?? snapshot.id}; report is incomplete`);
  }
  if (fleet.format !== 'tickmark-hosted-backup' || fleet.version !== 2 || !Array.isArray(fleet.practices)) {
    throw new Error(`snapshot ${snapshot.short_id ?? snapshot.id} has an unsupported fleet manifest`);
  }
  const holds = [ ...(fleet.retentionHolds ?? []), ...(fleet.deletionTombstones ?? []) ]
    .filter((row) => row.tenant_id === values.tenant && row.retention_hold_until)
    .map((row) => Date.parse(row.retention_hold_until));
  const held = holds.some((until) => !Number.isFinite(until) || until > Date.now());
  const containsTenant = fleet.practices.some((entry) => entry.id === values.tenant);
  if (containsTenant || held) {
    matches.push({ id: snapshot.short_id ?? snapshot.id, time: snapshot.time, containsTenant, held });
  }
}

const relevant = matches.filter((entry) => entry.containsTenant).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
const threshold = Date.now() - keepDays * 86400000;
console.log(JSON.stringify({
  tenant: values.tenant,
  retentionDays: keepDays,
  activeRetentionHold: matches.some((entry) => entry.held),
  earliestContainingSnapshot: relevant[0] ?? null,
  latestContainingSnapshot: relevant.at(-1) ?? null,
  snapshots: relevant.map((entry) => ({ ...entry, outsideNormalRetentionWindow: Date.parse(entry.time) < threshold })),
  deletionPolicy: 'Shared snapshots are expired by the fleet policy only after the retention window; this report never deletes a snapshot.',
}, null, 2));

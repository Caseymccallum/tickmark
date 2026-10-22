#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openRegistry } from '../src/tenancy/registry.js';
import { completeTenantDeletion } from '../src/tenancy/offboarding.js';
import { requireFreshHostedBackup } from '../src/tenancy/backup-status.js';

const { values } = parseArgs({ options: {
  data: { type: 'string', default: process.env.TICKMARK_DATA ?? 'data' },
  tenants: { type: 'string' },
  registry: { type: 'string' },
  'batch-size': { type: 'string', default: '100' },
  'max-backup-age-hours': { type: 'string', default: '26' },
  apply: { type: 'boolean', default: false },
} });
const dataDir = resolve(values.data);
const tenantsRoot = resolve(values.tenants ?? join(dataDir, 'tenants'));
const registryFile = resolve(values.registry ?? join(dataDir, 'saas.db'));
const limit = Number(values['batch-size']);
const maxBackupAgeHours = Number(values['max-backup-age-hours']);
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--batch-size must be 1–1000');
if (!Number.isFinite(maxBackupAgeHours) || maxBackupAgeHours < 1 || maxBackupAgeHours > 168) throw new Error('--max-backup-age-hours must be 1–168');
const tenantsInfo = lstatSync(tenantsRoot);
if (!tenantsInfo.isDirectory() || tenantsInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');

const registry = openRegistry(registryFile);
let failed = 0;
try {
  const now = new Date();
  const candidates = registry.prepare(
    `SELECT tenant_id, state, delete_after, retention_hold_until FROM tenant_deletion
      WHERE state IN ('requested', 'deleting') ORDER BY delete_after, tenant_id LIMIT ?`,
  ).all(limit);
  // Validate the whole batch before any deletion; partial metadata failure must never remove one practice while
  // leaving an operator unsure whether the remaining rows are protected by a hold.
  for (const row of candidates) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(row.tenant_id ?? '') || !Number.isFinite(Date.parse(row.delete_after ?? ''))) {
      throw new Error('deletion retention metadata is incomplete; no tenant data was removed');
    }
    if (row.retention_hold_until && !Number.isFinite(Date.parse(row.retention_hold_until))) {
      throw new Error('retention hold metadata is invalid; no tenant data was removed');
    }
  }
  const due = candidates.filter((row) => Date.parse(row.delete_after) <= now.getTime());
  const held = due.filter((row) => row.retention_hold_until && Date.parse(row.retention_hold_until) > now.getTime());
  const eligible = due.filter((row) => !held.includes(row));
  if (!values.apply) {
    console.log(JSON.stringify({ event: 'maintenance.deletions.dry-run', candidates: candidates.length, due: due.length, held: held.length, eligible: eligible.length, batchLimit: limit }));
  } else {
    if (eligible.length) await requireFreshHostedBackup(join(dataDir, 'hosted-backup-status.json'), { maxAgeHours: maxBackupAgeHours, now: now.getTime() });
    for (const row of eligible) {
      try {
        const result = await completeTenantDeletion(registry, {
          tenantId: row.tenant_id,
          tenantsRoot,
          confirmTenantId: row.tenant_id,
          at: now,
        });
        if (!['deleted', 'already-deleted'].includes(result.state)) failed += 1;
      } catch {
        failed += 1;
      }
    }
    console.log(JSON.stringify({ event: failed ? 'maintenance.deletions.failed' : 'maintenance.deletions.completed', eligible: eligible.length, failed, held: held.length, batchLimit: limit }));
  }
} finally {
  registry.close();
}
if (failed) process.exitCode = 1;

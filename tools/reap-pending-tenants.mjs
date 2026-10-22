#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { lstatSync } from 'node:fs';

import { openDatabase } from '../src/db.js';
import { openRegistry } from '../src/tenancy/registry.js';
import { pendingPaymentRetentionCandidates, requestTenantDeletion, suspendTenantDatabase } from '../src/tenancy/offboarding.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'data' },
    tenants: { type: 'string' },
    registry: { type: 'string' },
    'older-than-days': { type: 'string', default: process.env.TICKMARK_PENDING_RETENTION_DAYS ?? '30' },
    'grace-days': { type: 'string', default: process.env.TICKMARK_DELETION_GRACE_DAYS ?? '30' },
    'batch-size': { type: 'string', default: '100' },
    apply: { type: 'boolean', default: false },
  },
});
const dataDir = resolve(values.data);
const tenantsRoot = resolve(values.tenants ?? join(dataDir, 'tenants'));
const tenantsInfo = lstatSync(tenantsRoot);
if (!tenantsInfo.isDirectory() || tenantsInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');
const ageDays = Number(values['older-than-days']);
const graceDays = Number(values['grace-days']);
const batchSize = Number(values['batch-size']);
if (!Number.isSafeInteger(ageDays) || ageDays < 1 || ageDays > 3650 || !Number.isSafeInteger(graceDays) || graceDays < 0 || graceDays > 3650) {
  throw new Error('retention age and deletion grace must be between 0 and 3650 days; age must be positive');
}
const registry = openRegistry(resolve(values.registry ?? join(dataDir, 'saas.db')));
try {
  const at = new Date();
  const olderThan = new Date(at.getTime() - ageDays * 86400000).toISOString();
  const candidates = pendingPaymentRetentionCandidates(registry, { olderThan, limit: batchSize });
  console.log(`${values.apply ? 'APPLY' : 'DRY RUN'}: ${candidates.length} pending-payment tenant(s) older than ${ageDays} days (bounded batch ${batchSize}); scheduled deletion keeps a further ${graceDays}-day recovery period.`);
  for (const row of candidates) {
    console.log(`${row.id} ${row.slug} created ${row.created_at}`);
    if (!values.apply) continue;
    const requested = requestTenantDeletion(registry, {
      tenantId: row.id,
      ownerAccountId: row.owner_id,
      retentionDays: graceDays,
      at,
    });
    if (requested.state !== 'requested') throw new Error(`could not schedule pending tenant ${row.id}: ${requested.state}`);
    const tenantRoot = join(tenantsRoot, row.id);
    const tenantInfo = lstatSync(tenantRoot);
    if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink()) throw new Error(`tenant path must be a real directory: ${row.id}`);
    const db = openDatabase(join(tenantRoot, 'tickmark.db'));
    try { suspendTenantDatabase(db, at.toISOString()); } finally { db.close(); }
    registry.prepare("UPDATE hosted_invite SET state = 'revoked' WHERE tenant_id = ? AND state IN ('pending', 'accepting')").run(row.id);
  }
  if (!values.apply && candidates.length) console.log('Repeat with --apply to schedule these tenants; this does not delete practice data immediately.');
} finally {
  registry.close();
}

#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openDatabase } from '../src/db.js';
import { storageUsage, measureTenantBlobTree } from '../src/storage.js';
import { openRegistry } from '../src/tenancy/registry.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'data' },
    tenants: { type: 'string' },
    registry: { type: 'string' },
    tenant: { type: 'string' },
    'max-files': { type: 'string', default: '100000' },
  },
});
if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(values.tenant ?? '')) throw new Error('--tenant must be a UUID');
const dataDir = resolve(values.data);
const tenantsRoot = resolve(values.tenants ?? join(dataDir, 'tenants'));
const tenantsInfo = lstatSync(tenantsRoot);
if (!tenantsInfo.isDirectory() || tenantsInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');
const registry = openRegistry(resolve(values.registry ?? join(dataDir, 'saas.db')));
try {
  const tenant = registry.prepare('SELECT id, name, storage_quota_bytes, lifecycle_state FROM tenant WHERE id = ?').get(values.tenant);
  if (!tenant) throw new Error('practice is not in the registry');
  const tenantInfo = lstatSync(join(tenantsRoot, tenant.id));
  if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink()) throw new Error('tenant path must be a real directory');
  const blobDir = join(tenantsRoot, tenant.id, 'blobs');
  const db = openDatabase(join(tenantsRoot, tenant.id, 'tickmark.db'));
  try {
    const logical = storageUsage(db);
    const physical = measureTenantBlobTree(blobDir, { maxFiles: Number(values['max-files']) });
    const fs = await statfs(tenantsRoot);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const percent = ((logical.logicalBytes / tenant.storage_quota_bytes) * 100).toFixed(1);
    console.log(JSON.stringify({
      tenantId: tenant.id,
      practice: tenant.name,
      lifecycleState: tenant.lifecycle_state,
      logical: { ...logical, quotaBytes: tenant.storage_quota_bytes, quotaPercent: Number(percent) },
      blobTreeApparent: { files: physical.files, bytes: physical.bytes, skippedSymlinks: physical.skippedSymlinks },
      filesystem: { freeBytes, minFreeBytes: Number(process.env.TICKMARK_MIN_FREE_BYTES ?? 512 * 1024 * 1024) },
      exclusions: ['SQLite databases and WAL sidecars', 'logs', 'backup destinations', 'filesystem allocation overhead'],
    }, null, 2));
  } finally {
    db.close();
  }
} finally {
  registry.close();
}

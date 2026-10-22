#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { parseArgs } from 'node:util';

import { openDatabase } from '../src/db.js';
import { reconcileTenantUploads } from '../src/tenancy/reconcile-uploads.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'data' },
    tenants: { type: 'string' },
    tenant: { type: 'string' },
    'older-than-hours': { type: 'string', default: '24' },
    'max-files': { type: 'string', default: '100000' },
    apply: { type: 'boolean', default: false },
  },
});
const tenantId = values.tenant ?? '';
if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenantId)) throw new Error('--tenant must be a UUID');
const tenantsRoot = resolve(values.tenants ?? join(values.data, 'tenants'));
const tenantRoot = resolve(tenantsRoot, tenantId);
const rel = relative(tenantsRoot, tenantRoot);
if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('tenant directory escaped the configured tenants root');
const tenantsInfo = lstatSync(tenantsRoot);
if (!tenantsInfo.isDirectory() || tenantsInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');
const tenantInfo = lstatSync(tenantRoot);
if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink()) throw new Error('tenant path must be a real directory');
const db = openDatabase(join(tenantRoot, 'tickmark.db'));
try {
  const hours = Number(values['older-than-hours']);
  const maxFiles = Number(values['max-files']);
  if (!Number.isFinite(hours) || hours < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('age must be at least one hour and max-files must be a positive integer');
  }
  const report = await reconcileTenantUploads({
    db,
    blobDir: join(tenantRoot, 'blobs'),
    dryRun: !values.apply,
    minAgeMs: hours * 60 * 60 * 1000,
    staleReservationMs: hours * 60 * 60 * 1000,
    maxFiles,
    log: (level, event, fields) => console.log(JSON.stringify({ level, event, tenantId, ...fields })),
  });
  console.log(`${report.dryRun ? 'DRY RUN' : 'APPLIED'}: scanned ${report.filesScanned ?? 0} files; ${report.candidates.length} aged orphan(s), ${report.candidateBytes ?? 0} bytes; ${report.staleReservations} stale reservation(s); ${report.symlinks} symlink(s) skipped.`);
  for (const candidate of report.candidates) console.log(`${candidate.relativePath} (${candidate.bytes} bytes)`);
  if (!values.apply && report.candidates.length) console.log('Review this report, then repeat with --apply to remove only these aged, unreferenced files.');
} finally {
  db.close();
}

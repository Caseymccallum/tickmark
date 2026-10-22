#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openDatabase } from '../src/db.js';
import { openRegistry } from '../src/tenancy/registry.js';
import { completeTenantDeletion, requestTenantDeletion, setTenantRetentionHold, suspendTenantDatabase, verifyTenantOwner } from '../src/tenancy/offboarding.js';
import { createPracticeExport } from '../src/tenancy/practice-export.js';
import { requireFreshHostedBackup } from '../src/tenancy/backup-status.js';

const { values } = parseArgs({
  options: {
    action: { type: 'string', default: 'request' },
    data: { type: 'string', default: 'data' },
    tenants: { type: 'string' },
    registry: { type: 'string' },
    tenant: { type: 'string' },
    email: { type: 'string' },
    'password-file': { type: 'string' },
    to: { type: 'string' },
    confirm: { type: 'string' },
    'confirm-no-export': { type: 'string' },
    'retention-days': { type: 'string', default: '30' },
    'hold-until': { type: 'string' },
    reason: { type: 'string' },
  },
});
const dataDir = resolve(values.data);
const tenantsRoot = resolve(values.tenants ?? join(dataDir, 'tenants'));
const tenantsInfo = lstatSync(tenantsRoot);
if (!tenantsInfo.isDirectory() || tenantsInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');
const registry = openRegistry(resolve(values.registry ?? join(dataDir, 'saas.db')));
try {
  if (!values.tenant || values.confirm !== values.tenant) throw new Error('--tenant and --confirm must contain the same tenant UUID');
  if (values.action === 'hold') {
    if (!values['hold-until'] || !values.reason) throw new Error('hold action requires --hold-until and --reason');
    if (!setTenantRetentionHold(registry, { tenantId: values.tenant, until: values['hold-until'], reason: values.reason })) {
      throw new Error('practice is not in the registry');
    }
    console.log(`A retention hold was recorded for practice ${values.tenant} until ${new Date(values['hold-until']).toISOString()}.`);
  } else if (values.action === 'purge') {
    await requireFreshHostedBackup(join(dataDir, 'hosted-backup-status.json'));
    const result = await completeTenantDeletion(registry, {
      tenantId: values.tenant,
      tenantsRoot,
      confirmTenantId: values.confirm,
    });
    console.log(JSON.stringify(result));
    if (result.state !== 'deleted' && result.state !== 'already-deleted') process.exitCode = 1;
  } else if (values.action !== 'request') throw new Error('--action must be request, purge or hold');
  else {
  if (!values.email || !values['password-file']) throw new Error('request action requires --email and --password-file');
  const tenantInfo = lstatSync(join(tenantsRoot, values.tenant));
  if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink()) throw new Error('tenant path must be a real directory');
  if (!values.to && values['confirm-no-export'] !== values.tenant) {
    throw new Error('request an export with --to, or explicitly pass --confirm-no-export <tenant-id>');
  }

  const password = (await readFile(values['password-file'], 'utf8')).split(/\r?\n/)[0];
  const { tenant, owner } = await verifyTenantOwner(registry, {
    tenantId: values.tenant,
    email: values.email,
    password,
    confirmTenantId: values.confirm,
  });
  let exportDigest = null;
  if (values.to) {
    const manifest = await createPracticeExport({
      registry,
      tenantId: values.tenant,
      tenantsRoot,
      to: values.to,
      email: values.email,
      password,
      confirmTenantId: values.confirm,
    });
    exportDigest = createHash('sha256').update(await readFile(resolve(values.to, 'manifest.json'))).digest('hex');
    console.log(`Verified encrypted export created: ${manifest.blobs.files} documents; manifest sha256 ${exportDigest}.`);
  }

  const result = requestTenantDeletion(registry, {
    tenantId: tenant.id,
    ownerAccountId: owner.id,
    retentionDays: Number(values['retention-days']),
    exportManifestSha256: exportDigest,
  });
  if (result.state !== 'requested') throw new Error(`deletion request was not accepted: ${result.state}`);

  // Remove local sessions and outstanding bearer links. The registry lifecycle state already blocks
  // tenant routes while the practice directory is retained for its recovery window.
  const tenantDb = openDatabase(join(tenantsRoot, tenant.id, 'tickmark.db'));
  try {
    suspendTenantDatabase(tenantDb);
  } finally {
    tenantDb.close();
  }
  registry.prepare("UPDATE hosted_invite SET state = 'revoked' WHERE tenant_id = ? AND state IN ('pending', 'accepting')")
    .run(tenant.id);
  console.log(`Practice ${tenant.id} is suspended. Deletion is scheduled no earlier than ${result.deleteAfter}.`);
  if (values.to) console.log(`Keep the verified export at ${resolve(values.to)}; restore requires the owner's encryption passphrase or recovery key.`);
  }
} finally {
  registry.close();
}

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createPracticeExport } from '../src/tenancy/practice-export.js';
import { openRegistry } from '../src/tenancy/registry.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'data' },
    tenants: { type: 'string' },
    registry: { type: 'string' },
    tenant: { type: 'string' },
    email: { type: 'string' },
    'password-file': { type: 'string' },
    'totp-code-file': { type: 'string' },
    to: { type: 'string' },
    confirm: { type: 'string' },
  },
});
if (!values.tenant || !values.email || !values['password-file'] || !values.to || !values.confirm) {
  throw new Error('usage: node tools/export-tenant.mjs --tenant <id> --email <owner> --password-file <path> --to <new-directory> --confirm <tenant-id> [--data data]');
}
const dataDir = resolve(values.data);
const tenantsRoot = resolve(values.tenants ?? join(dataDir, 'tenants'));
const registry = openRegistry(resolve(values.registry ?? join(dataDir, 'saas.db')));
try {
  const password = (await readFile(values['password-file'], 'utf8')).split(/\r?\n/)[0];
  const secondFactorCode = values['totp-code-file']
    ? (await readFile(values['totp-code-file'], 'utf8')).split(/\r?\n/)[0]
    : null;
  const manifest = await createPracticeExport({
    registry,
    tenantId: values.tenant,
    tenantsRoot,
    to: values.to,
    email: values.email,
    password,
    secondFactorCode,
    confirmTenantId: values.confirm,
  });
  console.log(`Exported practice ${manifest.tenantId}: ${manifest.blobs.files} encrypted documents, ${manifest.blobs.bytes} bytes.`);
  console.log(`Integrity manifest: ${resolve(values.to, 'manifest.json')}`);
  console.log('Verify with: node tools/verify-tenant-export.mjs --from <export-directory>');
} finally {
  registry.close();
}

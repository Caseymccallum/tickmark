#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

import { openRegistry, setTenantStorageQuota } from '../src/tenancy/registry.js';

const { values } = parseArgs({ options: {
  data: { type: 'string', default: 'data' },
  registry: { type: 'string' },
  tenant: { type: 'string' },
  bytes: { type: 'string' },
} });
if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(values.tenant ?? '')) throw new Error('--tenant must be a UUID');
if (!/^\d+$/.test(values.bytes ?? '')) throw new Error('--bytes must be a positive integer');
const bytes = Number(values.bytes);
if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('--bytes must be a positive safe integer');

const registry = openRegistry(resolve(values.registry ?? join(values.data, 'saas.db')));
try {
  if (!setTenantStorageQuota(registry, values.tenant, bytes)) throw new Error('practice is not in the registry');
  console.log(`Storage quota for practice ${values.tenant} set to ${bytes} bytes.`);
} finally {
  registry.close();
}

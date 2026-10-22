#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openRegistry } from '../src/tenancy/registry.js';
import { applyBackupDeletionTombstones } from '../src/tenancy/restore-tombstones.js';

const { values } = parseArgs({ options: { data: { type: 'string' }, fleet: { type: 'string' }, confirm: { type: 'string' } } });
if (!values.data || !values.fleet || resolve(values.confirm ?? '') !== resolve(values.data)) {
  throw new Error('--data <restored-data-dir>, --fleet <latest-trusted-fleet.json>, and --confirm <same-data-dir> are required');
}
const dataDir = resolve(values.data);
const fleet = JSON.parse(await readFile(resolve(values.fleet), 'utf8'));
if (fleet.format !== 'tickmark-hosted-backup' || fleet.version !== 2 || !Array.isArray(fleet.deletionTombstones)) {
  throw new Error('the fleet file has no supported, complete deletion ledger');
}
const registry = openRegistry(join(dataDir, 'saas.db'));
try {
  const outcomes = await applyBackupDeletionTombstones(registry, {
    tenantsRoot: join(dataDir, 'tenants'),
    tombstones: fleet.deletionTombstones,
  });
  const deleted = outcomes.filter((outcome) => outcome.state === 'deleted' || outcome.state === 'already-deleted').length;
  const held = outcomes.filter((outcome) => outcome.state === 'retention-hold').length;
  console.log(JSON.stringify({ event: 'restore.tombstones-applied', records: outcomes.length, deleted, held }));
} finally {
  registry.close();
}

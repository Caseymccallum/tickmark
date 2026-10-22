#!/usr/bin/env node
/** Privacy-minimal health snapshot for a small hosted operator's monitor. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { collectHostedStatus } from '../src/tenancy/operational-status.js';

const { values } = parseArgs({ options: {
  data: { type: 'string', default: process.env.TICKMARK_DATA ?? 'data' },
  'health-url': { type: 'string', default: `http://127.0.0.1:${process.env.PORT ?? 3000}/healthz` },
  'max-backup-age-hours': { type: 'string', default: '26' },
  'max-maintenance-age-hours': { type: 'string', default: '30' },
  'min-free-bytes': { type: 'string', default: process.env.TICKMARK_MIN_FREE_BYTES ?? String(512 * 1024 * 1024) },
} });
const maxAgeHours = Number(values['max-backup-age-hours']);
const maxMaintenanceAgeHours = Number(values['max-maintenance-age-hours']);
const minFreeBytes = Number(values['min-free-bytes']);
if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1 || !Number.isFinite(maxMaintenanceAgeHours) || maxMaintenanceAgeHours < 1 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) {
  throw new Error('backup age and minimum free-space limits must be valid positive values');
}

const result = await collectHostedStatus({
  dataDir: resolve(values.data),
  healthUrl: values['health-url'],
  maxAgeHours,
  maxMaintenanceAgeHours,
  minFreeBytes,
});
console.log(JSON.stringify(result));
if (!result.healthy) process.exitCode = 1;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireFreshHostedBackup } from '../src/tenancy/backup-status.js';

test('irreversible tenant purge requires a recent successful off-site backup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tickmark-backup-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'status.json');
  const now = Date.parse('2026-10-22T12:00:00.000Z');
  const good = { format: 'tickmark-hosted-backup-status', version: 1, state: 'success', completedAt: '2026-10-22T11:00:00.000Z' };

  await writeFile(file, JSON.stringify(good));
  assert.equal((await requireFreshHostedBackup(file, { now })).state, 'success');

  await writeFile(file, JSON.stringify({ ...good, completedAt: '2026-10-21T00:00:00.000Z' }));
  await assert.rejects(() => requireFreshHostedBackup(file, { now }), /stale/);
  await writeFile(file, JSON.stringify({ ...good, state: 'failed' }));
  await assert.rejects(() => requireFreshHostedBackup(file, { now }), /missing, failed, or stale/);
  await writeFile(file, JSON.stringify({ ...good, completedAt: '2026-10-22T13:00:00.000Z' }));
  await assert.rejects(() => requireFreshHostedBackup(file, { now }), /missing, failed, or stale/);
  await rm(file);
  await assert.rejects(() => requireFreshHostedBackup(file, { now }), /no readable/);
});

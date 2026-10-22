import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHostedStatus } from '../src/tenancy/operational-status.js';

test('hosted status reports service, storage, and backup age without tenant data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-status-'));
  const data = join(root, 'data');
  mkdirSync(data);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, practices: 2 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(join(data, 'hosted-backup-status.json'), JSON.stringify({
    format: 'tickmark-hosted-backup-status', version: 1, state: 'success', completedAt: new Date().toISOString(),
  }));
  writeFileSync(join(data, 'hosted-maintenance-status.json'), JSON.stringify({
    format: 'tickmark-hosted-maintenance-status', version: 1, state: 'success', completedAt: new Date().toISOString(),
  }));
  const body = await collectHostedStatus({ dataDir: data, healthUrl: `http://127.0.0.1:${port}/healthz`, minFreeBytes: 1 });
  assert.equal(body.healthy, true);
  assert.equal(body.checks.service, true);
  assert.equal(body.checks.database, true);
  assert.equal(body.checks.backupRecent, true);
  assert.equal(body.checks.maintenanceRecent, true);
  assert.equal(JSON.stringify(body).includes('practice'), false, 'does not expose tenant names or identifiers');

  writeFileSync(join(data, 'hosted-backup-status.json'), JSON.stringify({ format: 'tickmark-hosted-backup-status', version: 1, state: 'failed' }));
  const stale = await collectHostedStatus({ dataDir: data, healthUrl: `http://127.0.0.1:${port}/healthz`, minFreeBytes: 1 });
  assert.equal(stale.healthy, false);
  assert.equal(stale.checks.backupRecent, false);

  writeFileSync(join(data, 'hosted-backup-status.json'), JSON.stringify({
    format: 'tickmark-hosted-backup-status', version: 1, state: 'success', completedAt: new Date().toISOString(),
  }));
  writeFileSync(join(data, 'hosted-maintenance-status.json'), JSON.stringify({ format: 'tickmark-hosted-maintenance-status', version: 1, state: 'failed' }));
  const maintenanceFailure = await collectHostedStatus({ dataDir: data, healthUrl: `http://127.0.0.1:${port}/healthz`, minFreeBytes: 1 });
  assert.equal(maintenanceFailure.healthy, false);
  assert.equal(maintenanceFailure.checks.maintenanceRecent, false);
});

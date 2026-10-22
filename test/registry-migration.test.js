import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRegistry } from '../src/tenancy/registry.js';

test('the hosted invite migration preserves existing accounts and memberships', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-registry-legacy-'));
  const file = join(directory, 'saas.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tenant (
      id TEXT PRIMARY KEY, practice_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'standard', owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tenant_member (tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, account_id));
    CREATE TABLE tenant_host (host TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    CREATE TABLE link_index (token_prefix TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE saas_session (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO account VALUES ('acct-1', 'owner@example.test', 'existing-password-hash', '2025-01-01T00:00:00.000Z');
    INSERT INTO tenant (id, practice_id, slug, name, owner_id, created_at)
      VALUES ('tenant-1', 'practice-1', 'firm', 'Firm', 'acct-1', '2025-01-01T00:00:00.000Z');
    INSERT INTO tenant_member VALUES ('tenant-1', 'acct-1', '2025-01-01T00:00:00.000Z');
  `);
  legacy.close();

  let upgraded = null;
  t.after(() => {
    upgraded?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  upgraded = openRegistry(file);

  assert.equal(upgraded.prepare('SELECT email FROM account WHERE id = ?').get('acct-1').email, 'owner@example.test');
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM tenant_member WHERE tenant_id = ?').get('tenant-1').n, 1);
  assert.equal(upgraded.prepare('SELECT status FROM tenant WHERE id = ?').get('tenant-1').status, 'active');
  assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hosted_invite'").get());
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM hosted_invite').get().n, 0);
  assert.equal(upgraded.prepare('SELECT stripe_event_created FROM tenant WHERE id = ?').get('tenant-1').stripe_event_created, 0);
  assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stripe_event'").get());
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM stripe_event').get().n, 0);
});

/**
 * The import tool: a self-hosted practice becomes a tenant.
 *
 * Runs the real tool as a child process against a real single-tenant file, then proves the
 * registry knows the practice, the imported file holds it, and the blobs moved with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db.js';
import { createClient, createPractice, createPractitioner, createRequest } from '../src/store.js';
import { hashPassword, verifyPassword } from '../src/crypto.js';
import { countTenants, openRegistry, tenantForSlug } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';

const TOOL = fileURLToPath(new URL('../tools/import-tenant.mjs', import.meta.url));

test('an imported practice is a tenant, with its data, its blobs and its credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-import-'));
  let registry = null;
  let pool = null;
  try {
    // The self-hosted shape: one db, one practice, one member, one client, one request, blobs beside.
    const dataDir = join(directory, 'data');
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'tickmark.db');
    const blobsDir = join(dataDir, 'blobs');
    mkdirSync(blobsDir, { recursive: true });
    writeFileSync(join(blobsDir, 'envelope.bin'), 'ciphertext-that-is-not-ours-to-read');

    const db = openDatabase(dbPath);
    const practiceId = createPractice(db, { name: 'Old Firm' });
    const password = 'a long enough password';
    const practitionerId = createPractitioner(db, {
      practiceId,
      email: 'sam@oldfirm.example',
      passwordHash: await hashPassword(password),
    });
    const clientId = createClient(db, { practiceId, createdBy: practitionerId, name: 'Northwind Ltd' });
    createRequest(db, { practiceId, createdBy: practitionerId, clientId, title: '2025 return' });
    db.close();

    const registryFile = join(directory, 'saas.db');
    const tenantsRoot = join(directory, 'tenants');

    // The tool, exactly as an operator would run it.
    const output = execFileSync(process.execPath, [
      TOOL,
      '--db', dbPath,
      '--blobs', blobsDir,
      '--registry', registryFile,
      '--tenants-root', tenantsRoot,
      '--slug', 'oldfirm',
      '--host', 'oldfirm.example',
    ], { encoding: 'utf8' });
    assert.match(output, /imported "Old Firm"/);

    // The registry knows the practice by its own id, under the requested slug and host.
    const registry = openRegistry(registryFile);
    assert.equal(countTenants(registry), 1);
    const tenant = tenantForSlug(registry, 'oldfirm');
    assert.ok(tenant, 'the slug resolves');
    assert.ok(existsSync(join(tenantsRoot, tenant.id, 'tickmark.db')), 'the practice file is in the tenants root');
    assert.ok(existsSync(join(tenantsRoot, tenant.id, 'blobs', 'envelope.bin')), 'the blobs moved with it');

    // And the proof the tool itself makes: the file the pool opens holds the original practice.
    const pool = createPool({ root: tenantsRoot });
    const reopened = pool.get(tenant.id);
    const row = reopened.prepare('SELECT id, name FROM practice').get();
    assert.equal(row.id, practiceId, 'the imported file holds the original practice');
    assert.equal(row.name, 'Old Firm');

    // The account the tool made carries the practice's own credentials, so the first sign-in
    // after import is the same email and password the practice has always used.
    const account = registry.prepare('SELECT email, password_hash FROM account').get();
    assert.equal(account.email, 'sam@oldfirm.example');
    assert.equal(await verifyPassword(password, account.password_hash), true, 'the password survived the import');
  } finally {
    try {
      pool?.closeAll();
      registry?.close();
    } catch {
      // Cleanup never outranks the test's own result.
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`tickmark test cleanup: ${directory} not removed — ${error.code ?? error.message}`);
    }
  }
});

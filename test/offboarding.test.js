import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { confirmTwoFactor, createSession, setPendingSecret } from '../src/auth.js';
import { openRegistry, createAccount, createTenant } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';
import { codeAt, counterAt, generateRecoveryCodes, generateSecret } from '../src/totp.js';
import { createClient, createRequest, issueToken } from '../src/store.js';
import {
  completeTenantDeletion,
  pendingPaymentRetentionCandidates,
  requestTenantDeletion,
  setTenantRetentionHold,
  suspendTenantDatabase,
  verifyTenantOwner,
} from '../src/tenancy/offboarding.js';

test('owner-authorised offboarding revokes access, enforces retention and holds, then deletes idempotently', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-offboard-'));
  const tenantsRoot = join(root, 'tenants');
  const registry = openRegistry(join(root, 'saas.db'));
  const pool = createPool({ root: tenantsRoot });
  const password = 'synthetic owner password long enough';
  const ownerId = await createAccount(registry, { email: 'owner@offboard.example', password });
  const tenant = createTenant(registry, pool, { ownerAccountId: ownerId, email: 'owner@offboard.example', name: 'Offboard practice' });
  const otherTenant = createTenant(registry, pool, { ownerAccountId: ownerId, email: 'owner@offboard.example', name: 'Unaffected practice' });
  registry.prepare("UPDATE tenant SET status = 'pending_payment', created_at = ? WHERE id = ?")
    .run('2026-09-01T00:00:00.000Z', otherTenant.id);
  const tenantRoot = join(tenantsRoot, tenant.id);
  const db = pool.get(tenant.id);
  const practitioner = db.prepare('SELECT id FROM practitioner WHERE email = ?').get('owner@offboard.example');
  createSession(db, practitioner.id, new Date('2026-10-22T00:00:00.000Z'));
  const clientId = createClient(db, { practiceId: tenant.practiceId, createdBy: practitioner.id, name: 'Synthetic client' });
  const requestId = createRequest(db, { practiceId: tenant.practiceId, createdBy: practitioner.id, clientId, title: 'Synthetic request' });
  const linkId = issueToken(db, { requestId, tokenHash: 'synthetic-token-digest', expiresAt: '2027-01-01T00:00:00.000Z' });
  // The access rows are handled by the same revocation statement even if this tenant has no links yet.
  t.after(() => { pool.closeAll(); registry.close(); rmSync(root, { recursive: true, force: true }); });

  assert.deepEqual(requestTenantDeletion(registry, { tenantId: tenant.id, ownerAccountId: 'someone-else', retentionDays: 0 }), { state: 'not-owner' });
  assert.equal((await verifyTenantOwner(registry, {
    tenantId: tenant.id, email: 'owner@offboard.example', password, confirmTenantId: tenant.id, tenantDb: db,
  })).tenant.id, tenant.id);
  await assert.rejects(() => verifyTenantOwner(registry, {
    tenantId: tenant.id, email: 'owner@offboard.example', password: 'wrong password', confirmTenantId: tenant.id, tenantDb: db,
  }), /could not be verified/);
  const when = new Date('2026-10-22T00:00:00.000Z');
  const secret = generateSecret();
  setPendingSecret(db, practitioner.id, secret);
  confirmTwoFactor(db, practitioner.id, generateRecoveryCodes(), when);
  await assert.rejects(() => verifyTenantOwner(registry, {
    tenantId: tenant.id, email: 'owner@offboard.example', password, confirmTenantId: tenant.id, tenantDb: db,
  }), /second factor/);
  const ownerCode = codeAt(secret, counterAt(when));
  assert.equal((await verifyTenantOwner(registry, {
    tenantId: tenant.id, email: 'owner@offboard.example', password, confirmTenantId: tenant.id,
    tenantDb: db, secondFactorCode: ownerCode, at: when,
  })).tenant.id, tenant.id);
  await assert.rejects(() => verifyTenantOwner(registry, {
    tenantId: tenant.id, email: 'owner@offboard.example', password, confirmTenantId: tenant.id,
    tenantDb: db, secondFactorCode: ownerCode, at: when,
  }), /second factor/);
  const stalePayments = pendingPaymentRetentionCandidates(registry, { olderThan: '2026-10-01T00:00:00.000Z', limit: 1 });
  assert.deepEqual(stalePayments.map((row) => row.id), [otherTenant.id], 'only an aged pending-payment tenant is a candidate');
  assert.throws(() => pendingPaymentRetentionCandidates(registry, { olderThan: when.toISOString(), limit: 1001 }), /batch size/);
  const requested = requestTenantDeletion(registry, { tenantId: tenant.id, ownerAccountId: ownerId, retentionDays: 1, at: when });
  assert.equal(requested.state, 'requested');
  assert.equal(registry.prepare('SELECT lifecycle_state FROM tenant WHERE id = ?').get(tenant.id).lifecycle_state, 'deletion_requested');
  assert.equal(suspendTenantDatabase(db, when.toISOString()).sessions, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get().n, 0);
  assert.ok(db.prepare('SELECT revoked_at FROM access_token WHERE id = ?').get(linkId).revoked_at, 'existing client link is revoked');
  assert.equal(existsSync(tenantRoot), true, 'the retained data remains available for recovery until purge');
  pool.drop(tenant.id);

  assert.equal((await completeTenantDeletion(registry, {
    tenantId: tenant.id, tenantsRoot, confirmTenantId: tenant.id, at: when,
  })).state, 'retention-period');
  const holdUntil = '2026-10-25T00:00:00.000Z';
  assert.equal(setTenantRetentionHold(registry, { tenantId: tenant.id, until: holdUntil, reason: 'synthetic contract hold' }), true);
  assert.equal((await completeTenantDeletion(registry, {
    tenantId: tenant.id, tenantsRoot, confirmTenantId: tenant.id, at: new Date('2026-10-24T00:00:00.000Z'),
  })).state, 'retention-hold');

  // A symlink inside the tenant directory cannot redirect recursive deletion outside the tenant root.
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'must remain');
  mkdirSync(join(tenantRoot, 'synthetic'), { recursive: true });
  // Symlink creation can be restricted on Windows hosts; the finalizer's lstat path remains covered elsewhere.
  try { await (await import('node:fs/promises')).symlink(outside, join(tenantRoot, 'synthetic', 'escape')); } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  }

  // Model a crash after isolation under .retired but before the recursive erase begins.
  const retiredRoot = join(tenantsRoot, '.retired');
  const retiredTenant = join(retiredRoot, tenant.id);
  mkdirSync(retiredRoot, { recursive: true });
  renameSync(tenantRoot, retiredTenant);

  const completed = await completeTenantDeletion(registry, {
    tenantId: tenant.id, tenantsRoot, confirmTenantId: tenant.id, at: new Date('2026-10-26T00:00:00.000Z'),
  });
  assert.equal(completed.state, 'deleted');
  assert.equal(existsSync(tenantRoot), false);
  assert.equal(existsSync(outside), true);
  assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM tenant WHERE id = ?').get(tenant.id).n, 0);
  assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM tenant WHERE id = ?').get(otherTenant.id).n, 1, 'a second tenant remains registered');
  assert.equal(registry.prepare('SELECT COUNT(*) AS n FROM account WHERE id = ?').get(ownerId).n, 1, 'the shared owner account remains for its other tenant');
  assert.equal(registry.prepare('SELECT state FROM tenant_deletion WHERE tenant_id = ?').get(tenant.id).state, 'deleted');
  assert.equal((await completeTenantDeletion(registry, {
    tenantId: tenant.id, tenantsRoot, confirmTenantId: tenant.id, at: new Date('2026-10-27T00:00:00.000Z'),
  })).state, 'already-deleted');
});

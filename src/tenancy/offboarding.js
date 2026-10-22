import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { verifyPassword } from '../crypto.js';
import { now } from '../db.js';
import { consumeTwoFactorProof } from '../auth.js';

const DAY = 86400000;
const slugDigest = (slug) => createHash('sha256').update(String(slug).toLowerCase()).digest('hex');

export async function verifyTenantOwner(registry, {
  tenantId, email, password, confirmTenantId, tenantDb, secondFactorCode, at = new Date(),
}) {
  if (confirmTenantId !== tenantId) throw new Error('explicit confirmation must exactly match the tenant id');
  const tenant = registry.prepare('SELECT id, owner_id, name, slug, lifecycle_state FROM tenant WHERE id = ?').get(tenantId);
  const owner = tenant && registry.prepare('SELECT id, email, password_hash FROM account WHERE id = ?').get(tenant.owner_id);
  if (!owner || owner.email !== String(email).toLowerCase() || !(await verifyPassword(password, owner.password_hash))) {
    throw new Error('the practice owner could not be verified');
  }
  if (!tenantDb) throw new Error('the practice owner could not be verified');
  const practitioner = tenantDb.prepare(
    "SELECT id FROM practitioner WHERE email = ? AND (role = 'owner' OR role IS NULL) AND removed_at IS NULL",
  ).get(owner.email);
  if (!practitioner) throw new Error('the practice owner could not be verified');
  if (!consumeTwoFactorProof(tenantDb, practitioner.id, secondFactorCode, at)) {
    throw new Error('the practice owner second factor could not be verified');
  }
  return { tenant, owner };
}

export function requestTenantDeletion(registry, {
  tenantId,
  ownerAccountId,
  retentionDays = 30,
  exportManifestSha256 = null,
  at = new Date(),
} = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
    throw new RangeError('deletion retention must be between 0 and 3650 days');
  }
  const tenant = registry.prepare('SELECT id, owner_id, slug, lifecycle_state, retention_hold_until, retention_hold_reason FROM tenant WHERE id = ?').get(tenantId);
  if (!tenant || tenant.owner_id !== ownerAccountId) return { state: 'not-owner' };
  if (tenant.lifecycle_state !== 'active') return { state: 'already-requested' };
  const requestedAt = at.toISOString();
  const deleteAfter = new Date(at.getTime() + retentionDays * DAY).toISOString();
  registry.exec('BEGIN IMMEDIATE');
  try {
    registry.prepare(
      `INSERT INTO tenant_deletion
        (tenant_id, slug_digest, state, requested_at, delete_after, export_manifest_sha256, retention_hold_until, retention_hold_reason)
       VALUES (?, ?, 'requested', ?, ?, ?, ?, ?)`,
    ).run(tenantId, slugDigest(tenant.slug), requestedAt, deleteAfter, exportManifestSha256, tenant.retention_hold_until, tenant.retention_hold_reason);
    registry.prepare(
      `UPDATE tenant SET lifecycle_state = 'deletion_requested', deletion_requested_at = ?, deletion_after = ?
        WHERE id = ? AND lifecycle_state = 'active'`,
    ).run(requestedAt, deleteAfter, tenantId);
    registry.exec('COMMIT');
  } catch (error) {
    registry.exec('ROLLBACK');
    throw error;
  }
  return { state: 'requested', requestedAt, deleteAfter };
}

export function setTenantRetentionHold(registry, { tenantId, until, reason }) {
  const parsed = Date.parse(until);
  if (!Number.isFinite(parsed) || !String(reason ?? '').trim() || String(reason).length > 500) {
    throw new TypeError('a valid hold expiry and a reason of 1–500 characters are required');
  }
  const current = registry.prepare('SELECT id FROM tenant WHERE id = ?').get(tenantId);
  if (!current) return false;
  registry.exec('BEGIN IMMEDIATE');
  try {
    registry.prepare('UPDATE tenant SET retention_hold_until = ?, retention_hold_reason = ? WHERE id = ?')
      .run(new Date(parsed).toISOString(), String(reason).trim(), tenantId);
    registry.prepare(
      'UPDATE tenant_deletion SET retention_hold_until = ?, retention_hold_reason = ? WHERE tenant_id = ? AND state != \'deleted\'',
    ).run(new Date(parsed).toISOString(), String(reason).trim(), tenantId);
    registry.exec('COMMIT');
  } catch (error) {
    registry.exec('ROLLBACK');
    throw error;
  }
  return true;
}

export function suspendTenantDatabase(db, at = now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const sessions = db.prepare('DELETE FROM session').run().changes;
    const challenges = db.prepare('DELETE FROM login_challenge').run().changes;
    const links = db.prepare('UPDATE access_token SET revoked_at = COALESCE(revoked_at, ?)').run(at).changes;
    const invites = db.prepare("UPDATE invite SET revoked_at = COALESCE(revoked_at, ?) WHERE used_at IS NULL").run(at).changes;
    db.exec('COMMIT');
    return { sessions, challenges, links, invites };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function removeTreeWithoutFollowingLinks(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await unlink(path);
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await removeTreeWithoutFollowingLinks(join(path, entry.name));
  }
  await rmdir(path);
}

/** Idempotent finalizer. Data is first isolated under .retired; a retry continues from either location. */
export async function completeTenantDeletion(registry, { tenantId, tenantsRoot, confirmTenantId, at = new Date() } = {}) {
  if (confirmTenantId !== tenantId) throw new Error('explicit confirmation must exactly match the tenant id');
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenantId)) throw new Error('tenant id must be a UUID');
  const deletion = registry.prepare('SELECT * FROM tenant_deletion WHERE tenant_id = ?').get(tenantId);
  if (!deletion) return { state: 'not-requested' };
  if (deletion.state === 'deleted') return { state: 'already-deleted', completedAt: deletion.completed_at };
  if (deletion.delete_after > at.toISOString()) return { state: 'retention-period', deleteAfter: deletion.delete_after };
  if (deletion.retention_hold_until && deletion.retention_hold_until > at.toISOString()) {
    return { state: 'retention-hold', holdUntil: deletion.retention_hold_until };
  }

  const tenantRoot = resolve(tenantsRoot, tenantId);
  const tenantsInfo = await lstat(resolve(tenantsRoot));
  if (!tenantsInfo.isDirectory() || tenantsInfo.isSymbolicLink()) throw new Error('tenants root must be a real directory');
  const rootRelative = relative(resolve(tenantsRoot), tenantRoot);
  if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${sep}`)) throw new Error('tenant path escaped the tenants root');
  const retiredRoot = resolve(tenantsRoot, '.retired');
  const retiredTenant = resolve(retiredRoot, tenantId);
  if (!retiredTenant.startsWith(`${retiredRoot}${sep}`)) throw new Error('retired path escaped the tenants root');

  registry.prepare("UPDATE tenant SET lifecycle_state = 'deleting' WHERE id = ?").run(tenantId);
  registry.prepare("UPDATE tenant_deletion SET state = 'deleting' WHERE tenant_id = ?").run(tenantId);

  await mkdir(retiredRoot, { recursive: true });
  const retiredRootInfo = await lstat(retiredRoot);
  if (!retiredRootInfo.isDirectory() || retiredRootInfo.isSymbolicLink()) throw new Error('retired tenant root must be a real directory');
  const [sourceInfo, retiredInfo] = await Promise.all([
    lstat(tenantRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    lstat(retiredTenant).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
  ]);
  if (sourceInfo?.isSymbolicLink() || retiredInfo?.isSymbolicLink()) throw new Error('refusing a symlinked tenant lifecycle path');
  if (sourceInfo && retiredInfo) throw new Error('both active and retired tenant directories exist; refusing ambiguous cleanup');
  if (sourceInfo) {
    if (!sourceInfo.isDirectory()) throw new Error('tenant path is not a directory');
    await rename(tenantRoot, retiredTenant);
  }
  await removeTreeWithoutFollowingLinks(retiredTenant);

  registry.exec('BEGIN IMMEDIATE');
  try {
    const members = registry.prepare('SELECT account_id FROM tenant_member WHERE tenant_id = ?').all(tenantId).map((row) => row.account_id);
    const tenant = registry.prepare('SELECT owner_id FROM tenant WHERE id = ?').get(tenantId);
    if (tenant) members.push(tenant.owner_id);
    registry.prepare('DELETE FROM hosted_invite WHERE tenant_id = ?').run(tenantId);
    registry.prepare('DELETE FROM stripe_reconciliation WHERE tenant_id = ?').run(tenantId);
    registry.prepare('DELETE FROM link_index WHERE tenant_id = ?').run(tenantId);
    registry.prepare('DELETE FROM tenant_host WHERE tenant_id = ?').run(tenantId);
    registry.prepare('DELETE FROM tenant_member WHERE tenant_id = ?').run(tenantId);
    registry.prepare('DELETE FROM tenant WHERE id = ?').run(tenantId);
    const uniqueAccounts = [...new Set(members)];
    for (const accountId of uniqueAccounts) {
      const stillNeeded = registry.prepare(
        'SELECT 1 FROM tenant_member WHERE account_id = ? UNION SELECT 1 FROM tenant WHERE owner_id = ? LIMIT 1',
      ).get(accountId, accountId);
      if (!stillNeeded) {
        registry.prepare('DELETE FROM saas_session WHERE account_id = ?').run(accountId);
        registry.prepare('DELETE FROM account WHERE id = ?').run(accountId);
      }
    }
    registry.prepare("UPDATE tenant_deletion SET state = 'deleted', completed_at = ? WHERE tenant_id = ?")
      .run(at.toISOString(), tenantId);
    registry.exec('COMMIT');
  } catch (error) {
    registry.exec('ROLLBACK');
    throw error;
  }
  return { state: 'deleted', completedAt: at.toISOString() };
}

/** Mark a bounded batch of stale pending-payment signups for deletion; the normal retention window still applies. */
export function pendingPaymentRetentionCandidates(registry, { olderThan, limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('batch size must be 1–1000');
  return registry.prepare(
    `SELECT id, owner_id, slug, created_at FROM tenant
      WHERE status = 'pending_payment' AND lifecycle_state = 'active' AND created_at <= ?
      ORDER BY created_at, id LIMIT ?`,
  ).all(olderThan, limit);
}

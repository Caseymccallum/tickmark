import { completeTenantDeletion } from './offboarding.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Merge the deletion ledger from the newest trusted backup into an older restored registry.
 * A deletion recorded as complete is replayed through the normal idempotent finalizer, so data present only in an
 * older snapshot cannot become reachable again. Holds and the original delete-after date remain authoritative.
 */
export async function applyBackupDeletionTombstones(registry, { tenantsRoot, tombstones, at = new Date() } = {}) {
  if (!Array.isArray(tombstones)) throw new TypeError('a complete deletion tombstone list is required');
  const seen = new Set();
  for (const row of tombstones) {
    if (!UUID.test(row.tenant_id ?? '') || seen.has(row.tenant_id)) throw new Error('deletion ledger has an invalid or duplicate tenant id');
    if (!SHA256.test(row.slug_digest ?? '')) throw new Error(`deletion ledger for ${row.tenant_id} has no slug digest`);
    if (!['requested', 'deleting', 'deleted'].includes(row.state)) throw new Error(`deletion ledger for ${row.tenant_id} has an invalid state`);
    for (const field of ['requested_at', 'delete_after']) {
      if (!Number.isFinite(Date.parse(row[field] ?? ''))) throw new Error(`deletion ledger for ${row.tenant_id} has an invalid ${field}`);
    }
    if (row.completed_at && !Number.isFinite(Date.parse(row.completed_at))) throw new Error(`deletion ledger for ${row.tenant_id} has an invalid completed_at`);
    if (row.retention_hold_until && !Number.isFinite(Date.parse(row.retention_hold_until))) throw new Error(`deletion ledger for ${row.tenant_id} has an invalid retention hold`);
    seen.add(row.tenant_id);
  }

  registry.exec('BEGIN IMMEDIATE');
  try {
    for (const row of tombstones) {
      const replayState = row.state === 'requested' ? 'requested' : 'deleting';
      registry.prepare(
        `INSERT INTO tenant_deletion
          (tenant_id, slug_digest, state, requested_at, delete_after, completed_at, retention_hold_until)
         VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
          slug_digest = excluded.slug_digest, state = excluded.state, requested_at = excluded.requested_at,
          delete_after = excluded.delete_after, completed_at = NULL,
          retention_hold_until = excluded.retention_hold_until`,
      ).run(row.tenant_id, row.slug_digest, replayState, row.requested_at, row.delete_after, row.retention_hold_until ?? null);
      registry.prepare(
        `UPDATE tenant SET lifecycle_state = ?, deletion_requested_at = ?, deletion_after = ?,
           retention_hold_until = COALESCE(?, retention_hold_until)
         WHERE id = ?`,
      ).run(replayState === 'requested' ? 'deletion_requested' : 'deleting', row.requested_at, row.delete_after, row.retention_hold_until ?? null, row.tenant_id);
    }
    registry.exec('COMMIT');
  } catch (error) {
    registry.exec('ROLLBACK');
    throw error;
  }

  const results = [];
  for (const row of tombstones) {
    if (row.state !== 'requested') {
      results.push(await completeTenantDeletion(registry, {
        tenantId: row.tenant_id,
        tenantsRoot,
        confirmTenantId: row.tenant_id,
        at,
      }));
    } else {
      results.push({ state: 'deletion-request-restored' });
    }
  }
  return results;
}

import { readFile } from 'node:fs/promises';

/** Fail-closed gate for irreversible tenant purge while off-site recovery is stale or unverified. */
export async function requireFreshHostedBackup(statusFile, { maxAgeHours = 26, now = Date.now() } = {}) {
  let status;
  try {
    status = JSON.parse(await readFile(statusFile, 'utf8'));
  } catch {
    throw new Error('no readable verified off-site backup status exists; tenant data was not deleted');
  }
  const completedAt = Date.parse(status.completedAt ?? '');
  if (status.format !== 'tickmark-hosted-backup-status' || status.version !== 1 || status.state !== 'success' ||
      !Number.isFinite(completedAt) || completedAt > now || now - completedAt > maxAgeHours * 3600000) {
    throw new Error('the verified off-site backup is missing, failed, or stale; tenant data was not deleted');
  }
  return status;
}

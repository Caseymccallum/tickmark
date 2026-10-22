import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';

/** Collect only operational state; never returns tenant names, ids, or document metadata. */
export async function collectHostedStatus({ dataDir, healthUrl, maxAgeHours = 26, maxMaintenanceAgeHours = 30, minFreeBytes = 512 * 1024 * 1024, now = Date.now() }) {
  const checks = {};
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    checks.service = response.ok;
    if (response.ok) checks.database = (await response.json()).ok === true;
  } catch (error) {
    checks.service = false;
    checks.database = false;
    checks.serviceError = error.cause?.code ?? error.name;
  }
  try {
    const fs = await statfs(dataDir);
    checks.primaryStorageFreeBytes = Number(fs.bavail) * Number(fs.bsize);
    checks.primaryStorage = checks.primaryStorageFreeBytes >= minFreeBytes;
  } catch {
    checks.primaryStorageFreeBytes = null;
    checks.primaryStorage = false;
  }
  try {
    const backup = JSON.parse(await readFile(join(dataDir, 'hosted-backup-status.json'), 'utf8'));
    checks.backupState = backup.state;
    checks.backupAgeHours = backup.completedAt ? Math.round((now - Date.parse(backup.completedAt)) / 360000) / 10 : null;
    checks.backupRecent = backup.state === 'success' && Number.isFinite(checks.backupAgeHours) && checks.backupAgeHours >= 0 && checks.backupAgeHours <= maxAgeHours;
  } catch {
    checks.backupState = 'unknown';
    checks.backupAgeHours = null;
    checks.backupRecent = false;
  }
  try {
    const maintenance = JSON.parse(await readFile(join(dataDir, 'hosted-maintenance-status.json'), 'utf8'));
    checks.maintenanceState = maintenance.state;
    checks.maintenanceAgeHours = maintenance.completedAt ? Math.round((now - Date.parse(maintenance.completedAt)) / 360000) / 10 : null;
    checks.maintenanceRecent = maintenance.format === 'tickmark-hosted-maintenance-status' && maintenance.version === 1 &&
      maintenance.state === 'success' && Number.isFinite(checks.maintenanceAgeHours) && checks.maintenanceAgeHours >= 0 &&
      checks.maintenanceAgeHours <= maxMaintenanceAgeHours;
  } catch {
    checks.maintenanceState = 'unknown';
    checks.maintenanceAgeHours = null;
    checks.maintenanceRecent = false;
  }
  return { ts: new Date(now).toISOString(), checks, healthy: checks.service && checks.database && checks.primaryStorage && checks.backupRecent && checks.maintenanceRecent };
}

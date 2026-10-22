import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { createAccount, createTenant, openRegistry, setTenantStorageQuota } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';
import { createResolver } from '../src/tenancy/resolve.js';
import { declaredUploadBytes, measureTenantBlobTree, releaseStorageReservation, reserveStorageBytes, startStorageReservation, storageUsage } from '../src/storage.js';

test('reservations enforce the exact tenant boundary and quota increases admit the remaining bytes', () => {
  const db = openDatabase();
  try {
    startStorageReservation(db, 'upload-a');
    assert.equal(reserveStorageBytes(db, 'upload-a', 7, 10).allowed, true);
    startStorageReservation(db, 'upload-b');
    assert.deepEqual(reserveStorageBytes(db, 'upload-b', 4, 10), { allowed: false, usedBytes: 7, quotaBytes: 10 });
    assert.equal(storageUsage(db).reservedBytes, 7);
    assert.equal(reserveStorageBytes(db, 'upload-b', 4, 11).allowed, true, 'raising the quota immediately changes admission');
    assert.equal(storageUsage(db).logicalBytes, 11);
    releaseStorageReservation(db, 'upload-a');
    assert.equal(storageUsage(db).logicalBytes, 4);
  } finally {
    db.close();
  }
});

test('content lengths accept only safe decimal byte counts', () => {
  assert.equal(declaredUploadBytes(undefined), null);
  assert.equal(declaredUploadBytes('0'), 0);
  assert.equal(declaredUploadBytes('123'), 123);
  for (const invalid of ['-1', '+1', '1.5', '1e3', ' 4', '9007199254740992']) {
    assert.throws(() => declaredUploadBytes(invalid), /invalid content length/);
  }
});

test('storage accounting refuses an oversized ledger instead of scanning it without a bound', () => {
  const db = openDatabase();
  try {
    startStorageReservation(db, 'one');
    startStorageReservation(db, 'two');
    startStorageReservation(db, 'three');
    assert.throws(() => storageUsage(db, { maxRows: 2 }), /safety cap/);
  } finally {
    db.close();
  }
});

test('physical blob accounting bounds its walk and never follows symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-storage-'));
  const outside = mkdtempSync(join(tmpdir(), 'tickmark-outside-'));
  try {
    mkdirSync(join(root, 'request'), { recursive: true });
    writeFileSync(join(root, 'request', 'file.bin'), Buffer.alloc(7));
    writeFileSync(join(outside, 'secret.bin'), Buffer.alloc(100));
    symlinkSync(outside, join(root, 'escape'), 'junction');
    assert.deepEqual(measureTenantBlobTree(root), { files: 1, bytes: 7, skippedSymlinks: 1 });
    assert.throws(() => measureTenantBlobTree(root, { maxFiles: 0 }), /scan limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('hosted tenant quotas and byte reservations stay isolated between practices', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-hosted-storage-'));
  const registry = openRegistry(join(root, 'saas.db'));
  const pool = createPool({ root: join(root, 'tenants') });
  const password = 'synthetic hosted owner password';
  const ownerA = await createAccount(registry, { email: 'a@storage.example', password });
  const ownerB = await createAccount(registry, { email: 'b@storage.example', password });
  const first = createTenant(registry, pool, { ownerAccountId: ownerA, email: 'a@storage.example', name: 'Storage A', storageQuotaBytes: 10 });
  const second = createTenant(registry, pool, { ownerAccountId: ownerB, email: 'b@storage.example', name: 'Storage B', storageQuotaBytes: 20 });
  t.after(() => { pool.closeAll(); registry.close(); rmSync(root, { recursive: true, force: true }); });

  const resolveTenant = createResolver({ registry, pool });
  const firstContext = resolveTenant({ headers: { host: 'localhost' } }, new URL('http://localhost/t/storage-a/requests'), null);
  const secondContext = resolveTenant({ headers: { host: 'localhost' } }, new URL('http://localhost/t/storage-b/requests'), null);
  assert.equal(firstContext.maxStorageBytes, 10);
  assert.equal(secondContext.maxStorageBytes, 20);
  startStorageReservation(firstContext.db, 'reservation-a');
  reserveStorageBytes(firstContext.db, 'reservation-a', 8, firstContext.maxStorageBytes);
  assert.equal(storageUsage(firstContext.db).logicalBytes, 8);
  assert.equal(storageUsage(secondContext.db).logicalBytes, 0, 'the other tenant has a separate quota ledger');
  startStorageReservation(secondContext.db, 'reservation-b');
  assert.equal(reserveStorageBytes(secondContext.db, 'reservation-b', 15, secondContext.maxStorageBytes).allowed, true, 'the other tenant can use its independent allowance');
  assert.equal(setTenantStorageQuota(registry, first.id, 12), true);
  const raised = registry.prepare('SELECT storage_quota_bytes FROM tenant WHERE id = ?').get(first.id).storage_quota_bytes;
  assert.equal(raised, 12);
  assert.equal(reserveStorageBytes(firstContext.db, 'reservation-a', 5, raised).allowed, false, 'a quota change is enforced on the next byte');
  assert.equal(registry.prepare('SELECT storage_quota_bytes FROM tenant WHERE id = ?').get(second.id).storage_quota_bytes, 20);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { reconcileTenantUploads } from '../src/tenancy/reconcile-uploads.js';
import { createClient, createPractice, createPractitioner, createRequest } from '../src/store.js';

test('reconciliation dry-runs aged orphans and apply keeps active, referenced, recent and external files', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-reconcile-'));
  const db = openDatabase(join(root, 'tickmark.db'));
  const blobs = join(root, 'blobs');
  const requestDir = join(blobs, 'request-a');
  mkdirSync(requestDir, { recursive: true });
  const aged = join(requestDir, 'orphan.bin');
  const interrupted = join(requestDir, 'interrupted-id.incoming');
  const referenced = join(requestDir, 'referenced.bin');
  const recent = join(requestDir, 'recent.incoming');
  const outside = join(root, 'outside.bin');
  const link = join(requestDir, 'linked.bin');
  writeFileSync(aged, 'aged ciphertext');
  writeFileSync(interrupted, 'interrupted encrypted staging');
  writeFileSync(referenced, 'referenced ciphertext');
  writeFileSync(recent, 'active staging');
  writeFileSync(outside, 'must remain');
  let symlinkSupported = true;
  try { symlinkSync(outside, link); } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    symlinkSupported = false;
  }
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(aged, old, old);
  utimesSync(interrupted, old, old);
  utimesSync(referenced, old, old);
  db.prepare('INSERT INTO upload_reservation (id, reserved_bytes, created_at) VALUES (?, ?, ?)')
    .run('active-id', 100, new Date().toISOString());
  db.prepare('INSERT INTO upload_reservation (id, reserved_bytes, created_at) VALUES (?, ?, ?)')
    .run('interrupted-id', 100, old.toISOString());
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  // Add a real upload reference so reconciliation must preserve its aged ciphertext.
  const practiceId = createPractice(db, { name: 'Synthetic practice' });
  const practitionerId = createPractitioner(db, { practiceId, email: 'owner@synthetic.example', passwordHash: 'placeholder' });
  const clientId = createClient(db, { practiceId, createdBy: practitionerId, name: 'Synthetic client' });
  const requestId = createRequest(db, { practiceId, createdBy: practitionerId, clientId, title: 'Synthetic request' });
  db.prepare(`INSERT INTO upload (id, request_id, filename, size_bytes, sha256, storage_path, uploaded_at)
    VALUES ('referenced', ?, 'file.pdf', ?, ?, ?, ?)`).run(
    requestId, Buffer.byteLength('referenced ciphertext'), 'digest', referenced, new Date().toISOString(),
  );

  const options = { db, blobDir: blobs, at: new Date(), minAgeMs: 60 * 60 * 1000, staleReservationMs: 60 * 60 * 1000 };
  const preview = await reconcileTenantUploads({ ...options, dryRun: true });
  assert.equal(preview.candidates.length, 2);
  assert.deepEqual(new Set(preview.candidates.map((candidate) => candidate.relativePath)), new Set([
    'request-a/orphan.bin', 'request-a/interrupted-id.incoming',
  ]));
  assert.equal(preview.staleReservations, 1);
  assert.equal(existsSync(aged), true, 'dry run leaves the orphan in place');

  const applied = await reconcileTenantUploads({ ...options, dryRun: false });
  assert.equal(applied.deleted.length, 2);
  assert.equal(existsSync(aged), false);
  assert.equal(existsSync(interrupted), false, 'an aged interrupted staging file is removed after review');
  assert.equal(existsSync(referenced), true);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(outside), true, 'an external file remains intact');
  if (symlinkSupported) assert.equal(existsSync(link), true, 'symlink itself is skipped');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upload_reservation').get().n, 1, 'stale reservation cleared while active one remains');
});

test('reconciliation is tenant-root scoped and bounded by the file cap', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-reconcile-bound-'));
  const db = openDatabase(join(root, 'tickmark.db'));
  const blobs = join(root, 'blobs');
  mkdirSync(blobs);
  writeFileSync(join(blobs, 'one.bin'), 'one');
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(() => reconcileTenantUploads({ db, blobDir: blobs, maxFiles: 0 }), /file reconciliation limit/);
});

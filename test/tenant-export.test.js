import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { openRegistry, createAccount, createTenant } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';
import { createPracticeExport, restorePracticeExport, verifyPracticeExport } from '../src/tenancy/practice-export.js';
import { verifyPassword } from '../src/crypto.js';
import { confirmTwoFactor, setPendingSecret } from '../src/auth.js';
import { codeAt, counterAt, generateRecoveryCodes, generateSecret } from '../src/totp.js';
import { NULL_LOG } from '../src/log.js';
import { decryptEnvelope, unwrapPracticeKey } from '../web/tickmark-crypto.js';
import { agent, createLink, setUpKey, upload } from './helpers.js';

test('an owner export is isolated, checksummed, restoreable and decrypts its original envelope', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'tickmark-export-test-'));
  const registry = openRegistry(join(data, 'saas.db'));
  const pool = createPool({ root: join(data, 'tenants') });
  const password = 'owner password long enough';
  const firstAccount = await createAccount(registry, { email: 'owner@northwind.example', password });
  const tenant = createTenant(registry, pool, { ownerAccountId: firstAccount, email: 'owner@northwind.example', name: 'Northwind Custody' });
  const secondAccount = await createAccount(registry, { email: 'owner@other.example', password });
  const other = createTenant(registry, pool, { ownerAccountId: secondAccount, email: 'owner@other.example', name: 'Unrelated Practice Name' });
  const db = pool.get(tenant.id);
  const blobDir = join(pool.root, tenant.id, 'blobs');
  const server = createApp(db, { blobDir, minFreeBytes: 0, log: NULL_LOG });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const otherDb = pool.get(other.id);
  const otherBlobDir = join(pool.root, other.id, 'blobs');
  const otherServer = createApp(otherDb, { blobDir: otherBlobDir, minFreeBytes: 0, log: NULL_LOG });
  await new Promise((resolve) => otherServer.listen(0, resolve));
  const otherBase = `http://127.0.0.1:${otherServer.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => otherServer.close(resolve));
    pool.closeAll();
    registry.close();
    rmSync(data, { recursive: true, force: true });
  });

  const client = agent(base);
  assert.equal((await client.post('/signin', { email: 'owner@northwind.example', password })).status, 303);
  const keys = await setUpKey(client);
  const created = await client.post('/requests', {
    client: 'Northwind Ltd', client_email: 'accounts@northwind.example', title: 'Custody export test', items: 'Bank statement',
  });
  assert.equal(created.status, 303);
  const requestId = created.headers.get('location').split('/').at(-1);
  const itemId = db.prepare('SELECT id FROM request_item WHERE request_id = ?').get(requestId).id;
  const { token } = await createLink(client, requestId);
  const plaintext = Buffer.from('synthetic statement payload, never in the export as plaintext');
  const accepted = await upload({ base, token, itemId, publicKey: keys.publicKey, plaintext, filename: 'synthetic.pdf' });
  assert.equal(accepted.response.status, 201);

  // The second hosted practice has independent, real encrypted work too; exporting the first must not
  // accidentally become a fleet export just because both directories share one tenants root.
  const otherClient = agent(otherBase);
  assert.equal((await otherClient.post('/signin', { email: 'owner@other.example', password })).status, 303);
  const otherKeys = await setUpKey(otherClient);
  const otherCreated = await otherClient.post('/requests', {
    client: 'Other Practice Ltd', client_email: 'accounts@other.example', title: 'Other synthetic request', items: 'Photo ID',
  });
  assert.equal(otherCreated.status, 303);
  const otherRequestId = otherCreated.headers.get('location').split('/').at(-1);
  const otherItemId = otherDb.prepare('SELECT id FROM request_item WHERE request_id = ?').get(otherRequestId).id;
  const otherLink = await createLink(otherClient, otherRequestId);
  const otherUpload = await upload({
    base: otherBase,
    token: otherLink.token,
    itemId: otherItemId,
    publicKey: otherKeys.publicKey,
    plaintext: Buffer.from('other practice synthetic ciphertext fixture'),
    filename: 'other-synthetic.pdf',
  });
  assert.equal(otherUpload.response.status, 201);

  const destination = join(data, 'owner-export');
  const manifest = await createPracticeExport({
    registry, tenantId: tenant.id, tenantsRoot: pool.root, to: destination,
    email: 'owner@northwind.example', password, confirmTenantId: tenant.id,
  });
  assert.equal(manifest.blobs.files, 1);
  assert.equal((await verifyPracticeExport(destination)).tenantId, tenant.id);
  const packageBytes = Buffer.concat([
    readFileSync(join(destination, 'practice.json')),
    readFileSync(join(destination, 'tickmark.db')),
    readFileSync(join(destination, 'blobs', requestId, `${db.prepare('SELECT id FROM upload').get().id}.bin`)),
  ]);
  assert.ok(!packageBytes.includes(Buffer.from('Unrelated Practice Name')));
  assert.ok(!packageBytes.includes(Buffer.from('Other Practice Ltd')));
  assert.ok(!packageBytes.includes(plaintext), 'plaintext never appears in the export');

  const restored = join(data, 'restored-practice');
  const result = await restorePracticeExport({
    from: destination,
    to: restored,
    ownerEmail: 'owner@northwind.example',
    ownerPassword: 'new owner password long enough',
    confirmTenantId: tenant.id,
  });
  assert.equal(result.documents, 1);
  const restoredDb = (await import('../src/db.js')).openDatabase(join(restored, 'tickmark.db'));
  try {
    const row = restoredDb.prepare('SELECT * FROM upload').get();
    const file = readFileSync(row.storage_path);
    assert.equal(row.size_bytes, accepted.envelope.length);
    assert.deepEqual(Buffer.from(await decryptEnvelope(await unwrapPracticeKey(keys.wrappedPrivateKey, 'a passphrase long enough'), file)), plaintext);
    const practitioner = restoredDb.prepare('SELECT password_hash, totp_secret FROM practitioner WHERE email = ?').get('owner@northwind.example');
    assert.equal(practitioner.totp_secret, null);
    assert.equal(await verifyPassword('new owner password long enough', practitioner.password_hash), true);
    assert.equal(await verifyPassword(password, practitioner.password_hash), false);
  } finally {
    restoredDb.close();
  }
  assert.equal(registry.prepare('SELECT id FROM tenant WHERE id = ?').get(other.id).id, other.id, 'the unrelated hosted tenant remains intact');
  assert.equal(otherDb.prepare('SELECT COUNT(*) AS n FROM upload').get().n, 1, 'the other practice retains its encrypted document');
});

test('export verification refuses a ciphertext byte changed after export', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'tickmark-export-integrity-'));
  const registry = openRegistry(join(data, 'saas.db'));
  const pool = createPool({ root: join(data, 'tenants') });
  const password = 'owner password long enough';
  const accountId = await createAccount(registry, { email: 'owner@integrity.example', password });
  const tenant = createTenant(registry, pool, { ownerAccountId: accountId, email: 'owner@integrity.example', name: 'Integrity Practice' });
  pool.closeAll();
  t.after(() => { pool.closeAll(); registry.close(); rmSync(data, { recursive: true, force: true }); });
  const target = join(data, 'export');
  // A valid no-upload practice still exports its complete database and membership data.
  const bundle = await createPracticeExport({
    registry, tenantId: tenant.id, tenantsRoot: pool.root, to: target,
    email: 'owner@integrity.example', password, confirmTenantId: tenant.id,
  });
  assert.equal(bundle.blobs.files, 0);
  assert.equal((await verifyPracticeExport(target)).tenantId, tenant.id);
  await writeFile(join(target, 'unlisted.txt'), 'not covered by the manifest');
  await assert.rejects(() => verifyPracticeExport(target), /outside its integrity manifest/);
  await unlink(join(target, 'unlisted.txt'));
  const dbBytes = readFileSync(join(target, 'tickmark.db'));
  // The manifest is the integrity boundary; tampering with it must be detected.
  dbBytes[dbBytes.length - 1] ^= 1;
  await writeFile(join(target, 'tickmark.db'), dbBytes);
  await assert.rejects(() => verifyPracticeExport(target), /integrity check failed/);
});

test('an owner export consumes a fresh TOTP or one recovery code when the practice has second factor enabled', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'tickmark-export-totp-'));
  const registry = openRegistry(join(data, 'saas.db'));
  const pool = createPool({ root: join(data, 'tenants') });
  const password = 'owner password long enough';
  const accountId = await createAccount(registry, { email: 'owner@totp-export.example', password });
  const tenant = createTenant(registry, pool, { ownerAccountId: accountId, email: 'owner@totp-export.example', name: 'TOTP Export Practice' });
  const db = pool.get(tenant.id);
  const practitioner = db.prepare('SELECT id FROM practitioner WHERE email = ?').get('owner@totp-export.example');
  const at = new Date();
  const secret = generateSecret();
  setPendingSecret(db, practitioner.id, secret);
  const recoveryCodes = generateRecoveryCodes();
  confirmTwoFactor(db, practitioner.id, recoveryCodes, at);
  t.after(() => { pool.closeAll(); registry.close(); rmSync(data, { recursive: true, force: true }); });

  const base = {
    registry, tenantId: tenant.id, tenantsRoot: pool.root, email: 'owner@totp-export.example', password,
    confirmTenantId: tenant.id, at,
  };
  const missingProof = join(data, 'missing-proof');
  await assert.rejects(() => createPracticeExport({ ...base, to: missingProof }), /second factor/);
  assert.equal(existsSync(missingProof), false, 'a failed second factor creates no export');

  const ownerCode = codeAt(secret, counterAt(at));
  assert.equal((await createPracticeExport({ ...base, to: join(data, 'totp-export'), secondFactorCode: ownerCode })).blobs.files, 0);
  await assert.rejects(() => createPracticeExport({ ...base, to: join(data, 'totp-replay'), secondFactorCode: ownerCode }), /second factor/);
  assert.equal((await createPracticeExport({ ...base, to: join(data, 'recovery-export'), secondFactorCode: recoveryCodes[0] })).blobs.files, 0);
  await assert.rejects(() => createPracticeExport({ ...base, to: join(data, 'recovery-replay'), secondFactorCode: recoveryCodes[0] }), /second factor/);
});

test('export verification and restore refuse a symlink without promoting a destination', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'tickmark-export-symlink-'));
  const registry = openRegistry(join(data, 'saas.db'));
  const pool = createPool({ root: join(data, 'tenants') });
  const password = 'owner password long enough';
  const accountId = await createAccount(registry, { email: 'owner@symlink.example', password });
  const tenant = createTenant(registry, pool, { ownerAccountId: accountId, email: 'owner@symlink.example', name: 'Symlink Practice' });
  pool.closeAll();
  t.after(() => { pool.closeAll(); registry.close(); rmSync(data, { recursive: true, force: true }); });

  const bundle = join(data, 'bundle');
  await createPracticeExport({
    registry, tenantId: tenant.id, tenantsRoot: pool.root, to: bundle,
    email: 'owner@symlink.example', password, confirmTenantId: tenant.id,
  });
  const outside = join(data, 'outside-secret');
  mkdirSync(outside);
  await writeFile(join(outside, 'synthetic.txt'), 'synthetic outside data');
  await symlink(outside, join(bundle, 'escape'), 'junction');
  await assert.rejects(() => verifyPracticeExport(bundle), /symbolic link/);
  const target = join(data, 'restore-target');
  await assert.rejects(() => restorePracticeExport({
    from: bundle, to: target, ownerEmail: 'owner@symlink.example',
    ownerPassword: 'new owner password long enough', confirmTenantId: tenant.id,
  }), /symbolic link/);
  assert.equal(existsSync(target), false, 'validation fails before restore creates or promotes a destination');
  assert.equal(readFileSync(join(outside, 'synthetic.txt'), 'utf8'), 'synthetic outside data');
});

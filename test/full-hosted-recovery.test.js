/**
 * Full hosted recovery from a selected older fleet snapshot plus the newest deletion ledger.
 * The app, registry, tenant SQLite files, browser crypto module and HTTP paths are real. Restic's
 * transport is replaced by the existing fake adapter; no external repository or browser UI is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { confirmTwoFactor, setPendingSecret } from '../src/auth.js';
import { createSaasServer } from '../src/tenancy/entry.js';
import { createAccount, createTenant, openRegistry, setTenantBilling } from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';
import { codeAt, counterAt, generateRecoveryCodes, generateSecret } from '../src/totp.js';
import {
  decryptEnvelope,
  generatePracticeKey,
  newInviteSecret,
  openInviteBytes,
  privateKeyBytesForTransfer,
  sealPrivateKey,
  unwrapPracticeKey,
  wrapBytesForInvite,
} from '../web/tickmark-crypto.js';
import { agent, upload } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BACKUP = join(ROOT, 'tools', 'backup-all.mjs');
const RESTORE = join(ROOT, 'tools', 'restore-hosted.mjs');
const FAKE_RESTIC = join(ROOT, 'test', 'fixtures', 'fake-restic.mjs');
const OWNER_PASSWORD = 'synthetic owner password 4';
const OWNER_PASSPHRASE = 'synthetic owner recovery phrase';
const STAFF_PASSWORD = 'synthetic staff password 4';
const STAFF_PASSPHRASE = 'synthetic staff recovery phrase';

const run = (script, args, env = process.env) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const closeSaas = async (saas) => {
  saas.server.closeAllConnections?.();
  await new Promise((resolve) => saas.server.close(resolve));
  saas.pool.closeAll();
  saas.registry.close();
};

async function authenticateWithTotp(client, slug, email, password, secret) {
  const started = await client.post(`/t/${slug}/signin`, { email, password });
  assert.equal(started.status, 303, 'password opens only the second-factor challenge');
  assert.equal(started.headers.get('location'), `/t/${slug}/signin/code`);
  const completed = await client.post(`/t/${slug}/signin/code`, {
    code: codeAt(secret, counterAt(new Date())),
  });
  assert.equal(completed.status, 303, 'a current TOTP completes tenant authentication');
  assert.equal(completed.headers.get('location'), `/t/${slug}/requests`);
}

test('hosted application, identity, TOTP, staff membership and encrypted documents survive a full isolated restore', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tickmark-full-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const data = join(root, 'primary-data');
  const tenantsRoot = join(data, 'tenants');
  mkdirSync(tenantsRoot, { recursive: true });

  const seedRegistry = openRegistry(join(data, 'saas.db'));
  const ownerAccount = await createAccount(seedRegistry, { email: 'owner@northstar.example', password: OWNER_PASSWORD });
  const deletedOwner = await createAccount(seedRegistry, { email: 'owner@erased.example', password: OWNER_PASSWORD });
  const provisioningPool = createPool({ root: tenantsRoot });
  const survivor = createTenant(seedRegistry, provisioningPool, {
    ownerAccountId: ownerAccount, email: 'owner@northstar.example', name: 'Northstar Synthetic Practice', slug: 'northstar',
  });
  const erased = createTenant(seedRegistry, provisioningPool, {
    ownerAccountId: deletedOwner, email: 'erased@synthetic.example', name: 'Retired Synthetic Practice', slug: 'retired',
  });
  provisioningPool.closeAll();
  seedRegistry.close();

  let saas = createSaasServer({ registryFile: join(data, 'saas.db'), tenantsRoot, env: {} });
  await listen(saas.server);
  let base = `http://127.0.0.1:${saas.server.address().port}`;
  const owner = agent(base);
  const deletedOwnerAgent = agent(base);

  setTenantBilling(saas.registry, survivor.id, { status: 'active' });
  setTenantBilling(saas.registry, erased.id, { status: 'active' });
  const ownerLogin = await owner.post('/login', { email: 'owner@northstar.example', password: OWNER_PASSWORD });
  assert.equal(ownerLogin.status, 303);
  const erasedLogin = await deletedOwnerAgent.post('/login', { email: 'owner@erased.example', password: OWNER_PASSWORD });
  assert.equal(erasedLogin.status, 303);

  const survivorDb = saas.pool.get(survivor.id);
  const ownerPractitioner = survivorDb.prepare('SELECT id FROM practitioner WHERE email = ?').get('owner@northstar.example').id;
  const ownerKeys = await generatePracticeKey(OWNER_PASSPHRASE);
  const keySaved = await owner.post(`/t/${survivor.slug}/setup`, {
    public_key: JSON.stringify(ownerKeys.publicKey), wrapped_private_key: ownerKeys.wrappedPrivateKey,
  });
  assert.equal(keySaved.status, 303);
  const keyId = survivorDb.prepare('SELECT id FROM practice_key ORDER BY created_at DESC, rowid DESC LIMIT 1').get().id;

  // Issue and accept a real keyed hosted invitation. The cryptographic operations are the same
  // module the browser scripts use; requests cross the actual invitation HTTP endpoints.
  const pkcs8 = await privateKeyBytesForTransfer(ownerKeys.wrappedPrivateKey, OWNER_PASSPHRASE);
  const inviteSecret = newInviteSecret();
  const sealed = await wrapBytesForInvite(pkcs8, inviteSecret);
  const madeInvite = await owner.post(`/t/${survivor.slug}/members/invite`, {
    email: 'staff@northstar.example', role: 'accountant', key_id: keyId, sealed_key: sealed,
  });
  assert.equal(madeInvite.status, 201);
  const invite = await madeInvite.json();
  assert.ok(invite.token);
  const invitePage = await agent(base).get(`/invite/${invite.token}`);
  assert.equal(invitePage.status, 200, 'the bearer token locates the right practice without a Host header');
  const acceptedPkcs8 = await openInviteBytes(sealed, inviteSecret);
  const staffWrappedKey = await sealPrivateKey(acceptedPkcs8, STAFF_PASSPHRASE);
  const staff = agent(base);
  const accepted = await staff.post(`/invite/${invite.token}`, {
    email: 'staff@northstar.example', password: STAFF_PASSWORD, wrapped_private_key: staffWrappedKey,
  });
  assert.equal(accepted.status, 303, 'the invitation is consumed and grants the invited member a session');

  const staffPractitioner = survivorDb.prepare('SELECT id FROM practitioner WHERE email = ?').get('staff@northstar.example').id;
  const ownerTotp = generateSecret();
  const staffTotp = generateSecret();
  setPendingSecret(survivorDb, ownerPractitioner, ownerTotp);
  confirmTwoFactor(survivorDb, ownerPractitioner, generateRecoveryCodes());
  setPendingSecret(survivorDb, staffPractitioner, staffTotp);
  confirmTwoFactor(survivorDb, staffPractitioner, generateRecoveryCodes());
  assert.ok(saas.registry.prepare('SELECT 1 FROM tenant_member WHERE tenant_id = ? AND account_id = (SELECT id FROM account WHERE email = ?)').get(survivor.id, 'staff@northstar.example'));

  const created = await owner.post(`/t/${survivor.slug}/requests`, {
    client: 'Fictional Client Ltd', client_email: 'synthetic-client@example.test',
    title: 'Synthetic year end', items: 'Bank statement\nSales invoices',
  });
  assert.equal(created.status, 303);
  const requestId = created.headers.get('location').split('/').pop();
  const itemIds = survivorDb.prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position').all(requestId).map((row) => row.id);
  const issued = await owner.post(`/t/${survivor.slug}/requests/${requestId}/link`, { days: '30' });
  const token = /\/r\/([A-Za-z0-9_-]+)/.exec(await issued.text())?.[1];
  assert.ok(token);
  const plaintext = Buffer.from('synthetic bank statement for recovery qualification');
  const sent = await upload({ base, token, itemId: itemIds[0], publicKey: ownerKeys.publicKey, plaintext, filename: 'synthetic.pdf' });
  assert.equal(sent.response.status, 201);
  const checked = await owner.post(`/t/${survivor.slug}/requests/${requestId}/items/${itemIds[0]}/check`, {});
  assert.equal(checked.status, 303);
  const uploadRow = survivorDb.prepare('SELECT * FROM upload WHERE request_id = ?').get(requestId);
  const eventCount = survivorDb.prepare('SELECT COUNT(*) AS n FROM event WHERE request_id = ?').get(requestId).n;
  assert.ok(eventCount >= 4, 'create, issue, receipt and review actions have an append-only history');
  assert.notEqual((await staff.get(`/t/${erased.slug}/requests`)).status, 200, 'an accepted staff member is isolated from a different active practice');

  // Create a second practice and a request through the same HTTP service. It is intentionally
  // deleted only after snapshot one, to prove the newer deletion ledger wins over that snapshot.
  const secondCreated = await deletedOwnerAgent.post(`/t/${erased.slug}/requests`, {
    client: 'Fictional Second Client', title: 'Second synthetic request', items: 'ID',
  });
  assert.equal(secondCreated.status, 303);
  const ownerRecoveryKey = await unwrapPracticeKey(ownerKeys.wrappedPrivateKey, OWNER_PASSPHRASE);

  await closeSaas(saas);
  saas = null;
  const snapshotOne = join(root, 'snapshot-before-delete');
  const backupOne = run(BACKUP, ['--data', data, '--to', snapshotOne, '--quiet']);
  assert.equal(backupOne.status, 0, backupOne.output);

  const deletionRegistry = openRegistry(join(data, 'saas.db'));
  const deletion = await import('../src/tenancy/offboarding.js');
  deletion.requestTenantDeletion(deletionRegistry, {
    tenantId: erased.id, ownerAccountId: deletedOwner, retentionDays: 0, at: new Date('2026-10-20T00:00:00.000Z'),
  });
  await deletion.completeTenantDeletion(deletionRegistry, {
    tenantId: erased.id, tenantsRoot, confirmTenantId: erased.id, at: new Date('2026-10-21T00:00:00.000Z'),
  });
  deletionRegistry.close();

  const snapshotTwo = join(root, 'snapshot-with-deletion-ledger');
  const backupTwo = run(BACKUP, ['--data', data, '--to', snapshotTwo, '--quiet']);
  assert.equal(backupTwo.status, 0, backupTwo.output);

  // Simulate losing the entire active service data path. Restore an older complete fleet image, then replay the newer
  // deletion ledger before constructing a server over the fresh target.
  const lostData = join(root, 'lost-primary-data');
  renameSync(data, lostData);
  assert.equal(existsSync(data), false);
  assert.ok(existsSync(join(lostData, 'saas.db')));
  const state = join(root, 'fake-restic-state.json');
  const oldId = '1111111111111111';
  const newestId = '2222222222222222';
  writeFileSync(state, JSON.stringify({ commands: [], snapshots: [
    { id: oldId, short_id: oldId.slice(0, 8), time: '2026-10-20T02:00:00.000Z', tags: ['tickmark-hosted'] },
    { id: newestId, short_id: newestId.slice(0, 8), time: '2026-10-21T02:00:00.000Z', tags: ['tickmark-hosted'] },
  ] }));
  const resticPassword = join(root, 'restic-password');
  writeFileSync(resticPassword, 'synthetic fake transport password\n', { mode: 0o600 });
  const target = join(root, 'fresh-restored-data');
  const restoreEnv = {
    ...process.env,
    RESTIC_REPOSITORY: 'fake-isolated-repository',
    RESTIC_PASSWORD_FILE: resticPassword,
    RESTIC_BIN_ARGS: JSON.stringify([FAKE_RESTIC]),
    RESTIC_TEST_STATE: state,
    RESTIC_TEST_RESTORE_ROOT: snapshotOne,
    RESTIC_TEST_LEDGER_FILE: join(snapshotTwo, 'fleet.json'),
    RESTIC_TEST_SNAPSHOT_MAP: JSON.stringify({
      [oldId]: join(snapshotOne, 'fleet.json'), [newestId]: join(snapshotTwo, 'fleet.json'),
    }),
  };
  const restored = run(RESTORE, [
    '--snapshot', oldId, '--to', target, '--staging', root, '--restic-bin', process.execPath,
  ], restoreEnv);
  assert.equal(restored.status, 0, restored.output);
  const restoreEvidence = JSON.parse(restored.output.trim().split(/\r?\n/).at(-1));
  assert.equal(restoreEvidence.event, 'restore.completed');
  assert.equal(restoreEvidence.serviceStarted, false);
  assert.equal(restoreEvidence.deletionTombstonesReplayed, 1);
  assert.equal(existsSync(join(target, 'tenants', erased.id)), false, 'deleted practice data cannot return from snapshot one');
  assert.ok(existsSync(join(target, 'tenants', survivor.id, 'tickmark.db')));

  const brokenLedger = join(root, 'broken-latest-ledger.json');
  writeFileSync(brokenLedger, '{invalid');
  const failedTarget = join(root, 'failed-restore-target');
  const failedState = join(root, 'failed-restic-state.json');
  writeFileSync(failedState, JSON.stringify({ commands: [], snapshots: [
    { id: oldId, short_id: oldId.slice(0, 8), time: '2026-10-20T02:00:00.000Z', tags: ['tickmark-hosted'] },
    { id: newestId, short_id: newestId.slice(0, 8), time: '2026-10-21T02:00:00.000Z', tags: ['tickmark-hosted'] },
  ] }));
  const failedRestore = run(RESTORE, [
    '--snapshot', oldId, '--to', failedTarget, '--staging', root, '--restic-bin', process.execPath,
  ], {
    ...restoreEnv,
    RESTIC_TEST_STATE: failedState,
    RESTIC_TEST_SNAPSHOT_MAP: JSON.stringify({
      [oldId]: join(snapshotOne, 'fleet.json'), [newestId]: brokenLedger,
    }),
  });
  assert.equal(failedRestore.status, 1, 'a malformed latest deletion ledger refuses restore promotion');
  assert.match(failedRestore.output, /restore.failed/);
  assert.equal(existsSync(failedTarget), false, 'a failed restore never exposes a partial data directory');

  saas = createSaasServer({ registryFile: join(target, 'saas.db'), tenantsRoot: join(target, 'tenants'), env: {} });
  await listen(saas.server);
  base = `http://127.0.0.1:${saas.server.address().port}`;
  const recoveredDb = saas.pool.get(survivor.id);
  assert.equal(recoveredDb.prepare('SELECT COUNT(*) AS n FROM request').get().n, 1);
  assert.equal(recoveredDb.prepare('SELECT COUNT(*) AS n FROM request_item WHERE id IN (?, ?)').get(...itemIds).n, 2);
  assert.equal(recoveredDb.prepare("SELECT COUNT(*) AS n FROM event WHERE request_id = ? AND kind = 'item.checked'").get(requestId).n, 1);
  assert.equal(saas.registry.prepare('SELECT COUNT(*) AS n FROM tenant').get().n, 1, 'the restored registry exposes only the survivor');

  const recoveredOwner = agent(base);
  await authenticateWithTotp(recoveredOwner, survivor.slug, 'owner@northstar.example', OWNER_PASSWORD, ownerTotp);
  assert.equal((await recoveredOwner.get(`/t/${survivor.slug}/requests`)).status, 200);
  const recoveredStaff = agent(base);
  await authenticateWithTotp(recoveredStaff, survivor.slug, 'staff@northstar.example', STAFF_PASSWORD, staffTotp);
  assert.equal((await recoveredStaff.get(`/t/${survivor.slug}/requests`)).status, 200, 'permitted staff membership and second factor survive');
  assert.notEqual((await recoveredStaff.get(`/t/${erased.slug}/requests`)).status, 200, 'the staff session cannot enter the deleted tenant');

  const restoredUpload = recoveredDb.prepare('SELECT * FROM upload WHERE id = ?').get(uploadRow.id);
  assert.ok(restoredUpload);
  const ciphertext = readFileSync(join(target, 'tenants', survivor.id, 'blobs', restoredUpload.request_id, `${restoredUpload.id}.bin`));
  assert.equal(createHash('sha256').update(ciphertext).digest('hex'), restoredUpload.sha256, 'ciphertext matches its recovered database digest');
  assert.deepEqual(Buffer.from(await decryptEnvelope(ownerRecoveryKey, ciphertext)), plaintext, 'the valid practice recovery key decrypts the recovered original bytes');
  assert.equal((await agent(base).get(`/r/${token}`)).status, 200, 'an active survivor link resolves after restore');

  t.diagnostic(`full-host synthetic evidence: 2 practices provisioned; 1 keyed staff invitation accepted; owner+staff TOTP login passed after recovery; 1 request, 2 checklist items, ${eventCount} events; ciphertext SHA-256 ${restoredUpload.sha256}; decrypted ${plaintext.byteLength} bytes; selected snapshot ${restoreEvidence.snapshotId}; deletion ledger replayed ${restoreEvidence.deletionTombstonesReplayed}; malformed-ledger restore refused without promotion; fake Restic transport; browser UI/device testing not part of this run.`);
  await closeSaas(saas);
  saas = null;
});

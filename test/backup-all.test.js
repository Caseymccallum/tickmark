/**
 * The fleet drill.
 *
 * `docs/operations.md` used to answer "how do I back up a hosted install" with a shell loop — one
 * `tools/backup.mjs` per practice, and a final `--data data` for the registry that, in a multi-tenant install,
 * points at a `tickmark.db` that does not exist. `tools/backup-all.mjs` replaces it, and the things worth proving
 * about a fleet tool are not the same as the things worth proving about one backup:
 *
 *   1. **every** practice is taken, not just the ones the registry remembers — a tenant with no registry row still
 *      has fifty clients' documents in its directory, so it is backed up and the discrepancy is reported;
 *   2. each one is verified as it goes, with the same definition of "verified" the single-installation tool uses;
 *   3. one broken practice is **named** and does not stop the other — and does not silently become a claim in the
 *      fleet manifest either;
 *   4. an interrupted run is refused from the top, because `fleet.json` is written last: a directory of verified
 *      practices with no fleet manifest is not a fleet backup;
 *   5. and the restore property survives the extra layer — a document uploaded through the real server is still
 *      openable with the practice's real private key, out of the copy this tool made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db.js';
import { createPool } from '../src/tenancy/pool.js';
import { createAccount, createTenant, openRegistry } from '../src/tenancy/registry.js';
import { decryptEnvelope } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALL = join(ROOT, 'tools', 'backup-all.mjs');
const BACKUP = join(ROOT, 'tools', 'backup.mjs');

/** Run a tool and keep everything it said: these tests are about what an operator reads as much as what happened. */
function run(tool, args) {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/**
 * A multi-tenant install: a registry, two practices, and a real encrypted document in each.
 *
 * The practice data comes from a real server run — an upload through `withServer`, exactly as a practice would
 * produce it — and is then copied into two tenant directories the way `tools/import-tenant.mjs` does it. Nothing
 * about the bytes is inventing here, which is what makes step 5 of the header a real drill rather than a shaped
 * fixture.
 */
async function fleetInstall(scratch) {
  const seed = join(scratch, 'seed');
  mkdirSync(seed, { recursive: true });
  const caught = {};
  await withServer(async ({ base, db, blobDir, agent }) => {
    const { client, requestId, itemIds, keys, privateKey } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    const plaintext = new TextEncoder().encode('the engagement letter, in the clear');
    await upload({ base, token, itemId: itemIds[0], publicKey: keys.publicKey, plaintext, filename: 'letter.pdf' });
    caught.row = db.prepare('SELECT * FROM upload').get();
    caught.privateKey = privateKey;
    caught.plaintext = plaintext;
    // The seed database is taken the way the tools take one — `VACUUM INTO`, not a file copy — because a copy of a
    // live WAL database on its own can silently miss everything since the last checkpoint. A fixture that made that
    // mistake would be testing a fleet of practices whose documents have no rows.
    db.exec(`VACUUM INTO '${join(seed, 'tickmark.db').replace(/'/g, "''")}'`);
    cpSync(blobDir, join(seed, 'blobs'), { recursive: true });
  });

  const dataDir = join(scratch, 'data');
  const tenantsRoot = join(dataDir, 'tenants');
  const registryFile = join(dataDir, 'saas.db');
  const registry = openRegistry(registryFile);
  const ownerAccountId = await createAccount(registry, { email: 'owner@example.test', password: 'a long enough password' });
  const pool = createPool({ root: tenantsRoot });
  const ids = {};
  for (const [slug, name] of [
    ['acme', 'Acme Accounting'],
    ['baker', 'Baker & Co'],
  ]) {
    const tenant = createTenant(registry, pool, { ownerAccountId, name, slug, email: 'owner@example.test' });
    pool.drop(tenant.id);
    cpSync(join(seed, 'tickmark.db'), join(tenantsRoot, tenant.id, 'tickmark.db'));
    cpSync(join(seed, 'blobs'), join(tenantsRoot, tenant.id, 'blobs'), { recursive: true });
    ids[slug] = tenant.id;
  }
  pool.closeAll();
  registry.close();
  return { dataDir, tenantsRoot, registryFile, ids, caught, seed };
}

test('one command backs up every practice and the registry, and one document decrypts out of the copy', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'tickmark-fleet-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const install = await fleetInstall(scratch);
  const to = join(scratch, 'backup');

  const took = run(ALL, ['--data', install.dataDir, '--to', to]);
  assert.equal(took.status, 0, took.out);
  assert.match(took.out, /Acme Accounting/, 'the registry gives the practice names, so fifty lines are readable');
  assert.match(took.out, /2 practices: 2 backed up and verified/);

  for (const id of Object.values(install.ids)) {
    assert.ok(existsSync(join(to, id, 'manifest.json')), `a manifest for ${id}`);
  }
  assert.ok(existsSync(join(to, 'registry', 'manifest.json')), 'and one for the registry, which the documented loop could not make');
  assert.ok(existsSync(join(to, 'fleet.json')), 'and the fleet manifest, written last');

  // The same `--verify` the single-installation tool has, from the top. An operator should not have to remember
  // which of the two tools checks which kind of backup.
  const checked = run(BACKUP, ['--verify', to]);
  assert.equal(checked.status, 0, checked.out);
  assert.match(checked.out, /2 practices and the registry/);

  // The restore property, out of a practice's copy: the row came across, and the practice's own private key opens
  // the document. `--verify` proves the file is present; only this proves the bytes are the right ones.
  const row = install.caught.row;
  const copied = openDatabase(join(to, install.ids.acme, 'tickmark.db'));
  const copiedRow = copied.prepare('SELECT * FROM upload').get();
  copied.close();
  assert.equal(copiedRow.id, row.id, 'the same document, by id');
  const bytes = readFileSync(join(to, install.ids.acme, 'blobs', row.request_id, `${row.id}.bin`));
  const opened = await decryptEnvelope(install.caught.privateKey, bytes);
  assert.deepEqual(Buffer.from(opened), Buffer.from(install.caught.plaintext), 'the key, the envelope and the bytes all came across');
});

test('a practice that lost a document is named, and one broken practice does not cost the others their backup', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'tickmark-fleet-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const install = await fleetInstall(scratch);
  const to = join(scratch, 'backup');
  const row = install.caught.row;
  const blob = (root, id) => join(root, id, 'blobs', row.request_id, `${row.id}.bin`);

  const took = run(ALL, ['--data', install.dataDir, '--to', to]);
  assert.equal(took.status, 0, took.out);

  // Baker's copy loses the document the row names — the failure `--verify` exists to catch.
  rmSync(blob(to, install.ids.baker));
  const checked = run(ALL, ['--verify', to]);
  assert.equal(checked.status, 1, 'a fleet backup with a broken practice is not verified');
  assert.match(checked.out, /Baker & Co/, 'and it says which practice');
  assert.match(checked.out, /1 of 1 documents are not in this backup/);
  assert.match(checked.out, /Acme Accounting[\s\S]*every one of the 1 rows has its file present/, 'the others still checked');

  // The take side does not stop at the first failure either: the good practice is backed up, and the broken one is
  // reported rather than claimed — it is not among the practices the fleet manifest lists.
  rmSync(blob(install.tenantsRoot, install.ids.baker));
  const second = join(scratch, 'backup2');
  const again = run(ALL, ['--data', install.dataDir, '--to', second]);
  assert.equal(again.status, 1, 'the run says so in its exit code');
  assert.match(again.out, /1 could not be backed up/);
  assert.ok(existsSync(join(second, install.ids.acme, 'manifest.json')), 'the good practice was still taken');
  const fleet = JSON.parse(readFileSync(join(second, 'fleet.json'), 'utf8'));
  assert.deepEqual(fleet.practices.map((entry) => entry.id), [install.ids.acme], 'the manifest claims only what verified');
  assert.deepEqual(fleet.failed, [install.ids.baker], 'and records what did not');
});

test('an interrupted run is refused from the top, and a practice the registry has forgotten is still backed up', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'tickmark-fleet-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const install = await fleetInstall(scratch);

  // A practice directory no registry row names. The data is the truth and the registry is a convenience, so this is
  // backed up like any other — and reported, because a directory nobody wrote down is worth looking at.
  const stray = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';
  mkdirSync(join(install.tenantsRoot, stray), { recursive: true });
  cpSync(join(install.seed, 'tickmark.db'), join(install.tenantsRoot, stray, 'tickmark.db'));
  cpSync(join(install.seed, 'blobs'), join(install.tenantsRoot, stray, 'blobs'), { recursive: true });

  const to = join(scratch, 'backup');
  const took = run(ALL, ['--data', install.dataDir, '--to', to]);
  assert.equal(took.status, 0, took.out);
  assert.match(took.out, /registry row/, 'the discrepancy is reported');
  assert.ok(existsSync(join(to, stray, 'manifest.json')), 'and its documents are taken anyway');

  // Interrupted: no `fleet.json` means no fleet backup, exactly as a missing manifest means no practice backup. A
  // directory of verified practices is not the same as a fleet backup, and the difference is what a restore needs.
  rmSync(join(to, 'fleet.json'));
  const refused = run(ALL, ['--verify', to]);
  assert.equal(refused.status, 1);
  assert.match(refused.out, /fleet\.json/);

  // `--only` narrows a run to named practices, which is how one failed practice is re-taken without rewriting the
  // fleet — and the manifest then claims exactly what it holds.
  const narrowed = join(scratch, 'backup-only');
  const one = run(ALL, ['--data', install.dataDir, '--to', narrowed, '--only', install.ids.acme]);
  assert.equal(one.status, 0, one.out);
  const fleet = JSON.parse(readFileSync(join(narrowed, 'fleet.json'), 'utf8'));
  assert.deepEqual(fleet.practices.map((entry) => entry.id), [install.ids.acme]);

  // A fleet backup naming a practice whose directory is not there is refused: `fleet.json` is the take side's
  // promise, and a promise about a practice that is missing is worth less than silence.
  rmSync(join(narrowed, install.ids.acme), { recursive: true, force: true });
  const gone = run(ALL, ['--verify', narrowed]);
  assert.equal(gone.status, 1);
  assert.match(gone.out, /no manifest\.json/);
});


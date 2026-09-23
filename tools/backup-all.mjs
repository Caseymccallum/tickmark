/**
 * Every practice on the machine, in one command, checked as it goes.
 *
 *   node tools/backup-all.mjs --data data --to backups/2026-09-23
 *   node tools/backup-all.mjs --verify backups/2026-09-23
 *
 * ### Why this exists rather than the loop the documentation used to give
 *
 * `docs/operations.md` told an operator to write a shell loop: one `tools/backup.mjs` per directory under
 * `data/tenants`. Two things were wrong with it, and the second one is a trap rather than an inconvenience.
 *
 * 1. **Nothing checked the results.** The doc says a directory of practices where one failed verification is a
 *    directory where one practice has silently lost files, and a loop prints fifty reassuring lines either way.
 *    This takes each practice and then verifies it — the check that matters, per tenant, not at the end when
 *    nobody is reading.
 * 2. **The registry cannot be copied that way.** The loop finished with `tools/backup.mjs --data data`, which looks
 *    for `data/tickmark.db`. In a multi-tenant install there is no such file, so the last line of the documented
 *    procedure would have failed — every time — and left a fleet backup with no accounts, hosts or subscription
 *    state in it.
 *
 * ### Discovery is by directory, and the registry is a name rather than a gate
 *
 * A practice is backed up because its directory holds a `tickmark.db`, not because a registry row says so. The data
 * is the thing worth protecting, and a tenant the registry has forgotten still has fifty clients' documents in it —
 * so it is backed up, and reported as a note so the discrepancy gets looked at. The registry is read for names and
 * slugs, which is what makes the output readable fifty lines deep.
 *
 * ### The order, and what an interrupted run looks like
 *
 * Practices first, then the registry, then a `fleet.json` written **last**. That last file is what makes this a
 * backup rather than a directory: a run that dies halfway leaves fifty verified practices and no `fleet.json`, and
 * verification of the whole refuses it — rather than a directory that looks like a complete fleet and is missing
 * forty practices. It is the same rule as the manifest inside one practice, one level up.
 *
 * ### What it does not do
 *
 * It does not stop the server, and it does not need to: `VACUUM INTO` reads a live database correctly, which is the
 * whole reason `tools/backup-lib.mjs` exists. It also does not delete anything, ever — old backups are pruned by an
 * operator who has looked at them, not by a tool.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FLEET_FILE, takeBackup, takeDatabaseBackup, verifyBackup, verifyFleetBackup, writeFleetManifest } from './backup-lib.mjs';
import { openRegistry } from '../src/tenancy/registry.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : null;
};

const dataDir = resolve(option('data') ?? 'data');
const tenantsRoot = resolve(option('tenants') ?? join(dataDir, 'tenants'));
const registryFile = resolve(option('registry') ?? join(dataDir, 'saas.db'));
const to = option('to') ? resolve(option('to')) : null;
const verifyOnly = option('verify') ? resolve(option('verify')) : null;
const only = option('only') ? new Set(option('only').split(',').map((id) => id.trim()).filter(Boolean)) : null;
const quiet = args.includes('--quiet');

const say = (line) => {
  if (!quiet) console.log(line);
};

const fail = (message) => {
  console.error(`tickmark backup-all: ${message}`);
  process.exit(1);
};

/**
 * The practices on this machine: directories under the tenants root that hold a database.
 *
 * Sorted, because an operator comparing two runs wants the difference to mean something. `--only` narrows it to
 * named tenants, which is how a single failed practice is re-taken without rewriting the fleet backup.
 */
function tenantDirectories() {
  if (!existsSync(tenantsRoot)) fail(`there is no tenants directory at ${tenantsRoot} — is this a multi-tenant install?`);
  const found = readdirSync(tenantsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(tenantsRoot, entry.name, 'tickmark.db')))
    .map((entry) => entry.name)
    .sort();
  if (found.length === 0) fail(`no practice directories under ${tenantsRoot}.`);
  if (!only) return found;
  const chosen = found.filter((id) => only.has(id));
  const unknown = [...only].filter((id) => !found.includes(id));
  if (unknown.length > 0) fail(`no practice directory for: ${unknown.join(', ')}.`);
  return chosen;
}

/** The names a registry gives those directories, so the output says "Acme Accounting" and not an opaque id. */
function namesFromRegistry(ids) {
  const names = new Map();
  if (!existsSync(registryFile)) return names;
  const registry = openRegistry(registryFile);
  for (const id of ids) {
    const row = registry.prepare('SELECT name, slug FROM tenant WHERE id = ?').get(id);
    if (row) names.set(id, row);
  }
  registry.close();
  return names;
}

/**
 * Take the whole fleet.
 *
 * Each practice is taken **and verified before the next one starts**, so a failure is reported while the run is
 * still going and names the practice it belongs to. A failure does not stop the run — one broken practice must not
 * cost the other forty-nine their backup — and the exit code says whether every one of them was good.
 */
async function takeAll() {
  if (!to) fail('a --to directory is required in take mode. See the header of this file.');
  if (existsSync(to) && readdirSync(to).length > 0) {
    fail(`${to} already has something in it. Backups are never overwritten — choose a new directory.`);
  }
  if (!existsSync(registryFile)) {
    fail(
      `there is no registry at ${registryFile}. This tool backs up a multi-tenant install; for a single ` +
        'installation use `node tools/backup.mjs --data <dir> --to <dir>`.',
    );
  }

  const ids = tenantDirectories();
  const names = namesFromRegistry(ids);
  const unregistered = ids.filter((id) => !names.has(id));

  const entries = [];
  const failures = [];
  let documents = 0;
  let bytes = 0;

  let first = true;
  for (const id of ids) {
    const label = names.get(id)?.name ?? '(not in the registry)';
    say(`${first ? '' : '\n'}${label}  ${id}`);
    first = false;
    try {
      const manifest = await takeBackup(join(tenantsRoot, id), join(to, id), { say });
      await verifyBackup(join(to, id), { say });
      documents += manifest.blobs.files;
      bytes += manifest.blobs.bytes;
      entries.push({ id, kind: 'practice', name: names.get(id)?.name ?? null, slug: names.get(id)?.slug ?? null });
    } catch (error) {
      failures.push({ id, label, problems: error.problems ?? [error.message] });
      say('  NOT BACKED UP — see the list at the end.');
    }
  }

  // The registry last: it is accounts and host names rather than documents, and a fleet backup that is missing it
  // is recoverable — the practices' own files carry their names — while a registry claiming practices that are not
  // in the backup is the one kind of lie a restore cannot detect.
  say('\nregistry');
  let registryEntry = null;
  try {
    await takeDatabaseBackup(registryFile, join(to, 'registry'), { say });
    await verifyBackup(join(to, 'registry'), { say });
    registryEntry = { id: 'registry', kind: 'registry', name: 'registry', slug: null };
  } catch (error) {
    failures.push({ id: 'registry', label: 'registry', problems: error.problems ?? [error.message] });
    say('  NOT BACKED UP — see the list at the end.');
  }

  // The fleet manifest, written last: it is what makes this directory a fleet backup rather than a pile of verified
  // practices. See the note at the top of this file.
  const fleet = {
    at: new Date().toISOString(),
    from: dataDir,
    practices: entries,
    registry: registryEntry,
    verified: entries.length,
    failed: failures.map((failure) => failure.id),
    documents,
    bytes,
  };
  await writeFleetManifest(to, fleet);

  say(
    `\n${ids.length} practice${ids.length === 1 ? '' : 's'}: ${entries.length} backed up and verified, ` +
      `${documents} documents, ${(bytes / 1024 / 1024).toFixed(1)} MB`,
  );
  if (unregistered.length > 0) {
    say(`note       ${unregistered.length} practice director${unregistered.length === 1 ? 'y has' : 'ies have'} no`);
    say(`           registry row: ${unregistered.join(', ')}. Backed up anyway — look at why they are missing.`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} could not be backed up:`);
    for (const failure of failures) {
      console.error(`  - ${failure.label} (${failure.id})`);
      for (const problem of failure.problems) console.error(`      ${problem}`);
    }
    console.error(
      '\nA practice that fails verification has a row naming a file the copy does not have. If its keys were being\n' +
        're-encrypted while this ran, that is the documented cause — see docs/operations.md — and running this again\n' +
        'after the pass finishes is the answer.',
    );
    process.exit(1);
  }
}

/**
 * Check a whole fleet backup.
 *
 * `fleet.json` decides what is in it — the directory is not walked, because a practice somebody deleted from the
 * backup directory on purpose should not become a mystery, and because the manifest is what the take side promised.
 * Every practice's own manifest is then verified by the same function the single-installation tool uses, so there is
 * one definition of "this practice's documents are all here".
 */
async function verifyAll() {
  if (!existsSync(join(verifyOnly, FLEET_FILE))) {
    fail(
      `${verifyOnly} has no ${FLEET_FILE}, so it is not a finished fleet backup. Nothing is verified. ` +
        '(A run that was interrupted leaves exactly this.)',
    );
  }
  const fleet = await verifyFleetBackup(verifyOnly, { say });
  const failures = fleet.failures ?? [];

  say(
    `\n${fleet.practices.length} practice${fleet.practices.length === 1 ? '' : 's'}, ` +
      `${fleet.documents} documents, taken ${fleet.at}`,
  );
  if (failures.length > 0) {
    console.error(`\n${failures.length} failed:`);
    for (const failure of failures) {
      console.error(`  - ${failure.label} (${failure.id})`);
      for (const problem of failure.problems) console.error(`      ${problem}`);
    }
    process.exit(1);
  }
  console.log('\nEvery practice in this backup verified. See docs/operations.md for what a restore involves.');
}

if (verifyOnly) {
  await verifyAll();
} else {
  await takeAll();
}

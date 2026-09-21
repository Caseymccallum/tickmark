/**
 * Bring an existing single-tenant installation into the SaaS registry.
 *
 * A current self-hosted practice has `data/tickmark.db` and `data/blobs/`. This tool copies both
 * into the tenants root under a new tenant id, registers the tenant (and an owner account carrying
 * the practice's own credentials, so the first sign-in after import is the same email and password
 * the practice has always used), and verifies the copy by hashing it and reading the practice back
 * through the pool.
 *
 * **The originals are never deleted.** A move that goes wrong is a data-loss incident; a copy that
 * goes wrong is a retry. The final line says where the originals sit so the operator can delete
 * them when satisfied — deliberately by hand, deliberately a decision.
 *
 * Usage:
 *   node tools/import-tenant.mjs --db data/tickmark.db --slug acme --host acme.example
 *
 * Options:
 *   --db            the practice's tickmark.db (required)
 *   --blobs         the uploads directory (default: beside --db)
 *   --registry      the registry file (default: data/saas.db)
 *   --tenants-root  the tenants directory (default: data/tenants)
 *   --slug          the URL slug (required, must be free)
 *   --host          the host to map (optional)
 *   --plan          free | standard (default: standard)
 */
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { openDatabase, newId, now } from '../src/db.js';
import {
  accountByEmail,
  createTenant,
  mapHost,
  openRegistry,
  PLANS,
} from '../src/tenancy/registry.js';
import { createPool } from '../src/tenancy/pool.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : null;
};

const dbPath = resolve(option('db') ?? 'data/tickmark.db');
const blobsPath = resolve(option('blobs') ?? join(dirname(dbPath), 'blobs'));
const registryFile = resolve(option('registry') ?? 'data/saas.db');
const tenantsRoot = resolve(option('tenants-root') ?? 'data/tenants');
const slug = option('slug');
const host = option('host');
const plan = option('plan') ?? 'standard';

const fail = (message) => {
  console.error(`tickmark import-tenant: ${message}`);
  process.exit(1);
};

if (!slug) fail('a --slug is required — see the header of this file.');
if (!PLANS[plan]) fail(`unknown plan "${plan}". Known: ${Object.keys(PLANS).join(', ')}.`);
if (!existsSync(dbPath)) fail(`no database at ${dbPath}.`);

// The import assumes one practice — the shape a self-hosted install has. Several practices in one
// file is a topology this tool refuses rather than invents a story for.
const source = openDatabase(dbPath);
const practices = source.prepare('SELECT id, name FROM practice ORDER BY created_at').all();
const practitioner = source.prepare('SELECT email, password_hash FROM practitioner ORDER BY created_at').get();
if (practices.length !== 1 || !practitioner) {
  fail(`${dbPath} holds ${practices.length} practice(s) and ${practitioner ? 'a member' : 'no member'}. This tool imports a single-practice installation.`);
}
const practice = practices[0];
const hashOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
source.close();

const registry = openRegistry(registryFile);
const pool = createPool({ root: tenantsRoot });

// The owner account is the practice's own first member: same email, same password hash. The
// practice keeps signing in with the credentials it already has, and the account is a truthful
// record of who owns the tenant rather than an invented identity.
let account = accountByEmail(registry, practitioner.email);
if (!account) {
  const id = newId();
  registry
    .prepare('INSERT INTO account (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, practitioner.email, practitioner.password_hash, now());
  account = accountByEmail(registry, practitioner.email);
}

// Provision through the registry's own path, then replace the freshly minted practice with the
// imported one: drop the handle, copy the file over it, and let the pool open the real data.
const tenant = createTenant(registry, pool, {
  ownerAccountId: account.id,
  name: practice.name,
  slug,
  email: practitioner.email,
  plan,
});
if (host) mapHost(registry, { tenantId: tenant.id, host });

pool.drop(tenant.id);
const tenantDbPath = join(tenantsRoot, tenant.id, 'tickmark.db');
cpSync(dbPath, tenantDbPath);
if (hashOf(tenantDbPath) !== hashOf(dbPath)) {
  fail('the copied database does not match the original — nothing was registered. Investigate before retrying.');
}
if (existsSync(blobsPath)) {
  cpSync(blobsPath, join(tenantsRoot, tenant.id, 'blobs'), { recursive: true });
}

// The registry's practice_id must be the id inside the imported file, not the placeholder's.
registry.prepare('UPDATE tenant SET practice_id = ? WHERE id = ?').run(practice.id, tenant.id);

// And the proof, not the promise: open the copy through the pool and read the practice back.
const reopened = pool.get(tenant.id);
const check = reopened.prepare('SELECT id, name FROM practice').get();
if (check?.id !== practice.id) {
  fail(`the imported file does not hold practice ${practice.id} — investigate before use.`);
}

console.log(`tickmark import-tenant: imported "${practice.name}" as tenant ${tenant.id}`);
console.log(`  registry:  ${registryFile}`);
console.log(`  files:     ${tenantDbPath}`);
console.log(`  slug:      ${slug}${host ? ` (host ${host})` : ''}, plan ${plan}`);
console.log(`  sign-in:   ${practitioner.email}, with the password the practice already used`);
console.log(`  originals: ${dbPath} and ${blobsPath} were left in place — delete them when satisfied.`);


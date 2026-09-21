/**
 * Create a practice, so a test environment can be used before Stripe is wired up.
 *
 * In production, practices arrive through `/signup` and open when Stripe's webhook says they paid.
 * Neither of those is available on a machine with no Stripe keys and no Stripe CLI — and a billing
 * wall with no way past it is not a test environment, it is a brick.
 *
 * So: this tool makes an account and a tenant exactly the way the gateway does (same functions,
 * same hashes, same files), and can mark it active in one step. It is operator tooling, run by
 * hand, exactly like `import-tenant.mjs` — it is not a route, and nothing in the server can reach it.
 *
 * Usage:
 *   node tools/create-tenant.mjs --email you@example.com --password 'at least 12 characters' \
 *     --name "Acme Accounting" [--slug acme] [--host acme.localhost] [--plan free] [--activate]
 *
 * Options:
 *   --data       the SaaS data directory          (default: data)
 *   --registry   the registry file                (default: <data>/saas.db)
 *   --tenants    the tenants directory            (default: <data>/tenants)
 *   --email      the account's email              (required)
 *   --password   the account's password           (required; 12 characters or more)
 *   --name       the practice's name              (required)
 *   --slug       the address slug                 (default: derived from --name)
 *   --host       map a host to this practice      (optional)
 *   --plan       free | standard                  (default: standard)
 *   --activate   mark it active, skipping the billing wall
 */
import { resolve } from 'node:path';

import { createPool } from '../src/tenancy/pool.js';
import { createAccount, createTenant, mapHost, openRegistry, PLANS, setTenantBilling, slugify } from '../src/tenancy/registry.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : null;
};

const fail = (message) => {
  console.error(`tickmark create-tenant: ${message}`);
  process.exit(1);
};

const dataDir = resolve(option('data') ?? 'data');
const registryFile = resolve(option('registry') ?? `${dataDir}/saas.db`);
const tenantsRoot = resolve(option('tenants') ?? `${dataDir}/tenants`);
const email = option('email')?.toLowerCase() ?? null;
const password = option('password') ?? '';
const name = option('name');
const slug = option('slug');
const host = option('host');
const plan = option('plan') ?? 'standard';
const activate = args.includes('--activate');

if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) fail('a valid --email is required.');
if (password.length < 12) fail('a --password of at least 12 characters is required.');
if (!name) fail('a --name is required.');
if (!PLANS[plan]) fail(`unknown plan "${plan}". Known: ${Object.keys(PLANS).join(', ')}.`);

const registry = openRegistry(registryFile);
const pool = createPool({ root: tenantsRoot });

const existing = registry.prepare('SELECT id FROM account WHERE email = ?').get(email);
const accountId = existing?.id ?? (await createAccount(registry, { email, password }));
if (existing) {
  console.log(`tickmark create-tenant: the password was not changed — ${email} already had an account.`);
}

const tenant = createTenant(registry, pool, {
  ownerAccountId: accountId,
  name,
  slug: slug ?? slugify(name),
  email,
  plan,
  status: activate ? 'active' : 'pending_payment',
});
if (host) mapHost(registry, { tenantId: tenant.id, host });

if (activate) setTenantBilling(registry, tenant.id, { status: 'active', plan });

console.log(`tickmark create-tenant: "${name}" is ready`);
console.log(`  registry:  ${registryFile}`);
console.log(`  files:     ${tenantsRoot}/${tenant.id}/tickmark.db`);
console.log(`  address:   ${host ? `http://${host}/` : `/t/${tenant.slug}/`}`);
console.log(`  sign in:   ${email} (the password you just set) at /login`);
console.log(
  activate
    ? '  status:    active — the workspace is open'
    : '  status:    pending_payment — run again with --activate, or complete Stripe checkout',
);

pool.closeAll();
registry.close();

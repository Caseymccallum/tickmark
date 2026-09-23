/**
 * The operator's database, and everything that is not a practice's data.
 *
 * A person's *account* is not a practice: an accountant who works for two firms is one account with
 * two memberships, and the self-hosted schema deliberately has no such idea — its `practitioner` row
 * belongs to one practice, in one file, and its password hash belongs to that file. So the SaaS
 * layer keeps accounts here, beside the practices rather than inside any of them, in its own small
 * SQLite file (`data/saas.db`).
 *
 * What lives here: accounts and their SaaS sessions, the host → practice map, and the token prefix
 * index that routes a client link to the right file **without trying every file** — trying each in
 * turn would turn tenant isolation into a timing side channel. What must never live here:
 * passphrases, key material, or any row a practice's own database holds. The registry can leak
 * without leaking a single document, and the design intends to keep it that way.
 * (docs/saas.md §2.3.)
 *
 * Sessions use the same discipline as the core — the token is stored only as a digest, via
 * `hashToken` from `src/crypto.js`, which is reused rather than copied. A second way to hash a
 * secret is a second way to get it wrong.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { hashPassword, hashToken, newToken } from '../crypto.js';
import { newId, now } from '../db.js';
import { createPractice, createPractitioner } from '../store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- A tenant: the practice directory, its name, and who owns it. The id is the directory name
-- under the tenants root; a practice that renames itself keeps its directory. practice_id is
-- the id of the practice row *inside* the tenant's own file — the two are not the same id, and
-- the difference is exactly why this table exists. Status is the billing state the Stripe
-- webhooks drive: pending_payment until a checkout completes, active while paid, past_due when
-- Stripe says payment is failing, cancelled when the subscription ends.
CREATE TABLE IF NOT EXISTS tenant (
  id          TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,     -- acme, in acme.tickmark.example
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'standard',
  status      TEXT NOT NULL DEFAULT 'active',
  -- Stripe's identifiers for this practice. Copied from the checkout session and the subscription
  -- events, so a webhook that arrives later can be matched to a tenant without trusting metadata
  -- alone; and so support can find the customer record from a practice's row.
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  owner_id    TEXT NOT NULL REFERENCES account(id),
  created_at  TEXT NOT NULL
);

-- An account may act in several tenants; a SaaS session knows only the account.
CREATE TABLE IF NOT EXISTS tenant_member (
  tenant_id  TEXT NOT NULL REFERENCES tenant(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);

-- The host the request arrived at, resolved before any tenant file is opened. One host per
-- tenant; a practice with no host yet is reachable through its slug or not at all.
CREATE TABLE IF NOT EXISTS tenant_host (
  host      TEXT PRIMARY KEY,          -- acme.tickmark.example, lowercased, without the port
  tenant_id TEXT NOT NULL REFERENCES tenant(id)
);

-- Where a client link can be found. The prefix is the first characters of the *token digest* —
-- the digest is already all this installation ever stores of a link, so the index adds no
-- secret the tenant files do not have. Filled by the SaaS entry's onLinkIssued recorder
-- whenever a link is issued or re-issued.
CREATE TABLE IF NOT EXISTS link_index (
  token_prefix TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenant(id),
  created_at   TEXT NOT NULL
);

-- The SaaS session: an account, not a practice.
CREATE TABLE IF NOT EXISTS saas_session (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS saas_session_account ON saas_session(account_id);
`;

const SESSION_DAYS = 14;
export const SAAS_COOKIE = 'tickmark_saas_session';

export function openRegistry(file) {
  mkdirSync(join(file, '..'), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Registries made before billing existed have no status column; SQLite cannot add it with a
  // different default than the one every existing row should honestly carry, so the default
  // travels with the column and reads as what those rows were: active, paid-up, working.
  const columns = db.prepare("SELECT name FROM pragma_table_info('tenant')").all().map((row) => row.name);
  if (!columns.includes('status')) {
    db.exec("ALTER TABLE tenant ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!columns.includes('stripe_customer_id')) {
    db.exec('ALTER TABLE tenant ADD COLUMN stripe_customer_id TEXT');
  }
  if (!columns.includes('stripe_subscription_id')) {
    db.exec('ALTER TABLE tenant ADD COLUMN stripe_subscription_id TEXT');
  }
  return db;
}

// --- accounts and sessions -------------------------------------------------------------------

export async function createAccount(registry, { email, password }) {
  const passwordHash = await hashPassword(password);
  const id = newId();
  registry
    .prepare('INSERT INTO account (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, String(email).toLowerCase(), passwordHash, now());
  return id;
}

export function accountByEmail(registry, email) {
  return (
    registry
      .prepare('SELECT id, email, password_hash FROM account WHERE email = ?')
      .get(String(email).toLowerCase()) ?? null
  );
}

export function createSaasSession(registry, accountId, at = new Date()) {
  const token = newToken();
  const expires = new Date(at.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  registry
    .prepare('INSERT INTO saas_session (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(newId(), accountId, hashToken(token), expires.toISOString(), at.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

/** The account behind a SaaS session cookie, or null. Expired sessions are removed on sight. */
export function accountForRequest(registry, request, at = new Date()) {
  const header = request.headers.cookie ?? '';
  const match = new RegExp(`(?:^|;\\s*)${SAAS_COOKIE}=([^;]+)`).exec(header);
  if (!match) return null;
  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const row = registry
    .prepare(
      `SELECT s.id, s.expires_at, a.id AS account_id, a.email
         FROM saas_session s JOIN account a ON a.id = s.account_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at <= at.toISOString()) {
    registry.prepare('DELETE FROM saas_session WHERE id = ?').run(row.id);
    return null;
  }
  return { id: row.account_id, email: row.email };
}

export function endSaasSession(registry, token) {
  if (typeof token !== 'string' || token.length === 0) return;
  registry.prepare('DELETE FROM saas_session WHERE token_hash = ?').run(hashToken(token));
}

/** The token from a request's cookies, or null. One regex, so the cookie name lives in one place. */
export function sessionTokenFrom(request) {
  const header = request.headers.cookie ?? '';
  const match = new RegExp(`(?:^|;\\s*)${SAAS_COOKIE}=([^;]+)`).exec(header);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** The `Set-Cookie` for a SaaS session, in the same shape the core uses for its own. */
export function saasSessionCookie(token, secure = true) {
  const attributes = [
    `${SAAS_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSaasSessionCookie(secure = true) {
  const attributes = [`${SAAS_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** The tenant a session token is for, if that account is a member of one. */
export function tenantForToken(registry, token, at = new Date()) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = registry
    .prepare(
      `SELECT s.id, s.expires_at, a.id AS account_id, a.email,
              t.id AS tenant_id, t.slug, t.name, t.plan, t.status
         FROM saas_session s
         JOIN account a ON a.id = s.account_id
         LEFT JOIN tenant_member m ON m.account_id = a.id
         LEFT JOIN tenant t ON t.id = m.tenant_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at <= at.toISOString()) {
    registry.prepare('DELETE FROM saas_session WHERE id = ?').run(row.id);
    return null;
  }
  return {
    account: { id: row.account_id, email: row.email },
    tenant: row.tenant_id
      ? { id: row.tenant_id, slug: row.slug, name: row.name, plan: row.plan, status: row.status }
      : null,
  };
}

// --- the bridge between a registry account and a tenant's own session --------------------------

/**
 * The practitioner row **inside the tenant's file** for a signed-in account, or null.
 *
 * The core's pages ask the core's own question — `practitionerFor(db, request)` — and they go on
 * doing so: that check is the second lock on the door, and a tenant file must never become
 * reachable by a cookie it cannot verify. So a registry sign-in, having proven who the person is,
 * looks up the tenant-side practitioner and then mints the tenant-side session the core would have
 * minted had they signed in there (the gateway calls the core's own `createSession`). The cookie
 * the browser carries is that token, in the core's cookie name, so `src/app.js` is unchanged.
 */
export function practitionerForAccount(pool, tenant, email) {
  const db = pool.get(tenant.id);
  const practitioner = db
    .prepare('SELECT id, email FROM practitioner WHERE email = ? AND removed_at IS NULL')
    .get(String(email).toLowerCase());
  return practitioner ? { db, practitioner } : null;
}

// --- billing state ----------------------------------------------------------------------------

/**
 * What each status means for access, in one place, so the guard and the pages cannot disagree.
 *
 * `pending_payment` is not an error: it is a practice that has just signed up and is on its way to
 * Stripe. `past_due` is a card that failed and can be fixed. `cancelled` is the subscription gone.
 * Only `active` opens the documents.
 */
export const TENANT_STATUS = {
  active: { allowed: true, heading: null },
  pending_payment: {
    allowed: false,
    heading: 'Your subscription is not set up yet',
    detail: 'Finish setting up your subscription and your workspace opens straight away.',
  },
  past_due: {
    allowed: false,
    heading: 'Your subscription is currently inactive. Please update your payment details to access your documents.',
    detail: 'The last payment did not go through. Nothing has been deleted — your documents are waiting.',
  },
  cancelled: {
    allowed: false,
    heading: 'Your subscription is currently inactive. Please update your payment details to access your documents.',
    detail: 'The subscription has ended. Start it again and your workspace comes straight back.',
  },
};

export const tenantAllowsAccess = (tenant) => (TENANT_STATUS[tenant?.status] ?? TENANT_STATUS.cancelled).allowed;

/** Record what Stripe says. Returns the previous status, for the audit line. */
export function setTenantBilling(registry, tenantId, { status = null, plan = null, customerId = null, subscriptionId = null }) {
  const current = registry
    .prepare('SELECT status, plan, stripe_customer_id, stripe_subscription_id FROM tenant WHERE id = ?')
    .get(tenantId);
  if (!current) return null;

  registry
    .prepare(
      `UPDATE tenant
          SET status = ?, plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?
        WHERE id = ?`,
    )
    .run(
      status ?? current.status,
      plan ?? current.plan,
      customerId ?? current.stripe_customer_id,
      subscriptionId ?? current.stripe_subscription_id,
      tenantId,
    );
  return current;
}

// --- tenants ---------------------------------------------------------------------------------

/** A slug a URL can carry: lowercased, letters, digits and dashes, 1–63 characters. */
export function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, 63) || 'practice';
}

/**
 * Create a tenant: a directory under the pool's root, a practice inside its own file, and an owner
 * membership. The practice inside is exactly what a fresh self-hosted install has — one practice,
 * no key, no members — so the practice's first sign-in is the same page the open-source product
 * shows, passphrase warning included. Nothing about the practice's *data* is known here, and
 * nothing about it is asked for: the passphrase belongs to the practice alone.
 */
export function createTenant(registry, pool, { ownerAccountId, name, slug = null, email = null, plan = 'standard', status = 'active' }) {
  const id = newId();
  const finalSlug = slug ?? slugify(name);

  mkdirSync(join(pool.root, id), { recursive: true });

  // The practice row is created by the core's own store functions, so a tenant file is born
  // identical to a self-hosted database rather than a lookalike of one. The practitioner's
  // password hash is the *account's* hash, copied: the practice's own sign-in page then works
  // with the account's email and password, and every core flow (key setup, members, passphrase
  // change) works unchanged inside the file. The SaaS session is the second layer on top, not a
  // replacement for the practice's own.
  const db = pool.get(id);
  const practiceId = createPractice(db, { name });
  const account = registry.prepare('SELECT password_hash FROM account WHERE id = ?').get(ownerAccountId);
  createPractitioner(db, {
    practiceId,
    email: email ?? `${id}@tenants.invalid`,
    passwordHash: account?.password_hash ?? 'scrypt$N=2,r=1,p=1$AAAA$AAAA',
  });

  registry
    .prepare('INSERT INTO tenant (id, practice_id, slug, name, plan, status, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, practiceId, finalSlug, name, plan, status, ownerAccountId, now());
  registry
    .prepare('INSERT INTO tenant_member (tenant_id, account_id, created_at) VALUES (?, ?, ?)')
    .run(id, ownerAccountId, now());

  return { id, practiceId, slug: finalSlug };
}

/** The tenant whose own file holds this practice id, or null. */
export function tenantForPractice(registry, practiceId) {
  return (
    registry.prepare('SELECT id, slug, name FROM tenant WHERE practice_id = ?').get(practiceId) ?? null
  );
}

// --- the host map ----------------------------------------------------------------------------

/** Point a host at a tenant. The host is stored lowercased and without its port. */
export function mapHost(registry, { tenantId, host }) {
  const cleaned = String(host).toLowerCase().replace(/:\d+$/, '');
  registry
    .prepare(
      'INSERT INTO tenant_host (host, tenant_id) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET tenant_id = excluded.tenant_id',
    )
    .run(cleaned, tenantId);
}

/** The tenant behind a host, or behind a slug, or null — never a guess. Status travels with it. */
export function tenantForHost(registry, host) {
  if (!host) return null;
  return (
    registry
      .prepare(
        `SELECT t.id, t.slug, t.name, t.plan, t.status
           FROM tenant_host h JOIN tenant t ON t.id = h.tenant_id
          WHERE h.host = ?`,
      )
      .get(String(host).toLowerCase().replace(/:\d+$/, '')) ?? null
  );
}

export function tenantForSlug(registry, slug) {
  return (
    registry
      .prepare('SELECT id, slug, name, plan, status FROM tenant WHERE slug = ?')
      .get(String(slug).toLowerCase()) ?? null
  );
}

// --- plans -----------------------------------------------------------------------------------

/**
 * What a plan buys, in the only currencies the core already understands: how long a chase run may
 * take, and how big one upload may be. Both are injected dependencies of `createApp`, so a plan is
 * data — not a fork of the server. An unknown plan reads as `standard`, never as unlimited.
 */
export const PLANS = {
  free: {
    chaseBudgetMs: 15_000,
    maxUploadBytes: 10 * 1024 * 1024,
    maxRequestBytes: 512 * 1024 * 1024,
    maxRequestFiles: 100,
  },
  standard: {
    chaseBudgetMs: 60_000,
    maxUploadBytes: 25 * 1024 * 1024,
    maxRequestBytes: 2 * 1024 * 1024 * 1024,
    maxRequestFiles: 500,
  },
};

// --- the link index --------------------------------------------------------------------------

/** How many digest characters the index stores. 48 bits: a collision needs a lottery. */
export const LINK_PREFIX_LENGTH = 12;

export const linkPrefixOf = (token) => hashToken(token).slice(0, LINK_PREFIX_LENGTH);

/** Record where a link lives. Called by the SaaS layer when a link is issued or re-issued. */
export function recordLink(registry, { tenantId, token }) {
  if (typeof token !== 'string' || token.length === 0) return false;
  registry
    .prepare('INSERT OR IGNORE INTO link_index (token_prefix, tenant_id, created_at) VALUES (?, ?, ?)')
    .run(linkPrefixOf(token), tenantId, now());
  return true;
}

/**
 * The tenant a client link belongs to, by its prefix — or null. The full token is re-checked by
 * the core's own lookup inside whatever file this returns, so a prefix can only ever aim a
 * request at a file, never at a document.
 */
export function tenantForLink(registry, token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return (
    registry
      .prepare(
        `SELECT t.id, t.slug, t.name, t.plan
           FROM link_index l JOIN tenant t ON t.id = l.tenant_id
          WHERE l.token_prefix = ?`,
      )
      .get(linkPrefixOf(token)) ?? null
  );
}

/** An operator-facing count, for /healthz and for nobody else. */
export function countTenants(registry) {
  return registry.prepare('SELECT COUNT(*) AS n FROM tenant').get().n;
}



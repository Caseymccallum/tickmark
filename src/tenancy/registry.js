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
import { randomBytes } from 'node:crypto';

import { DatabaseSync } from 'node:sqlite';

import { hashPassword, hashToken, newToken, verifyPassword } from '../crypto.js';
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
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'deletion_requested', 'deleting', 'deleted')),
  deletion_requested_at TEXT,
  deletion_after TEXT,
  retention_hold_until TEXT,
  retention_hold_reason TEXT,
  storage_quota_bytes INTEGER NOT NULL DEFAULT 5368709120 CHECK (storage_quota_bytes > 0),
  -- When the card first failed, for the grace window that decides how long the documents stay open
  -- after past_due. Null unless the subscription is past due, and cleared the moment it is fixed — so a
  -- card that fails, is retried, and fails again keeps one clock rather than a fresh window each time.
  past_due_since TEXT,
  -- Stripe's identifiers for this practice. Copied from the checkout session and the subscription
  -- events, so a webhook that arrives later can be matched to a tenant without trusting metadata
  -- alone; and so support can find the customer record from a practice's row.
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  stripe_event_created INTEGER NOT NULL DEFAULT 0,
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

-- Hosted invitations mirror only identity/lifecycle metadata. The sealed practice-key blob stays in
-- the tenant file, and the URL token is stored only as a digest here and in that file.
CREATE TABLE IF NOT EXISTS hosted_invite (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepting', 'accepted', 'revoked')),
  account_id TEXT REFERENCES account(id),
  created_account INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS hosted_invite_tenant ON hosted_invite(tenant_id, state);

-- A tombstone survives retirement of the tenant row. It records the lifecycle decision without
-- retaining practice names, emails, credentials, documents, or billing identifiers.
CREATE TABLE IF NOT EXISTS tenant_deletion (
  tenant_id TEXT PRIMARY KEY,
  slug_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'deleting', 'deleted')),
  requested_at TEXT NOT NULL,
  delete_after TEXT NOT NULL,
  completed_at TEXT,
  export_manifest_sha256 TEXT,
  retention_hold_until TEXT,
  retention_hold_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_deletion_slug ON tenant_deletion(slug_digest);

-- The SaaS session: an account, not a practice.
CREATE TABLE IF NOT EXISTS saas_session (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS saas_session_account ON saas_session(account_id);

-- Stripe retries and reorders webhook events. This durable receipt ledger is committed in the
-- same SQLite transaction as the billing state change, so a restart cannot split the two.
CREATE TABLE IF NOT EXISTS stripe_event (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_created INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  tenant_id TEXT,
  received_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS stripe_event_received ON stripe_event(received_at);

-- Reviewable operator reconciliation. Store the verified Stripe identifiers and state only; never
-- store API responses, secrets, payment methods, or raw event bodies. Removed with the tenant.
CREATE TABLE IF NOT EXISTS stripe_reconciliation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  stripe_status TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  resulting_status TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('corrected', 'confirmed')),
  operator TEXT NOT NULL,
  reconciled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stripe_reconciliation_tenant ON stripe_reconciliation(tenant_id, reconciled_at);
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
  if (!columns.includes('past_due_since')) {
    db.exec('ALTER TABLE tenant ADD COLUMN past_due_since TEXT');
    // Start the grace clock for anyone already past due, rather than reading a null as "since when?"
    // and locking a practice out whose card failed before this column existed.
    db.prepare("UPDATE tenant SET past_due_since = ? WHERE status = 'past_due'").run(new Date().toISOString());
  }
  if (!columns.includes('stripe_event_created')) {
    db.exec('ALTER TABLE tenant ADD COLUMN stripe_event_created INTEGER NOT NULL DEFAULT 0');
  }
  for (const [column, definition] of [
    ['lifecycle_state', "TEXT NOT NULL DEFAULT 'active'"],
    ['deletion_requested_at', 'TEXT'],
    ['deletion_after', 'TEXT'],
    ['retention_hold_until', 'TEXT'],
    ['retention_hold_reason', 'TEXT'],
    ['storage_quota_bytes', 'INTEGER NOT NULL DEFAULT 5368709120'],
  ]) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE tenant ADD COLUMN ${column} ${definition}`);
  }
  // The same startup sweep `src/db.js` does: platform sessions are live state, and a row nobody ever
  // touched again is a row that would otherwise outlive its own expiry forever.
  db.prepare('DELETE FROM saas_session WHERE expires_at <= ?').run(new Date().toISOString());
  return db;
}

/**
 * What a tenant's practitioner gets when the owner's account row cannot be found — which should never
 * happen (`owner_id` is a foreign key) and must not be answerable if it somehow does.
 *
 * The old placeholder here was `'scrypt$N=2,r=1,p=1$AAAA$AAAA'` — a *valid* password record under
 * trivially cheap parameters, so some short password verified against it and the tenant's sign-in
 * page had a guessable backdoor. This is the same record shape under the real cost parameters with a
 * random salt and a random 32-byte target: no password is known to satisfy it, and finding one is a
 * 2^256 search. (An honest footnote: every hash record has *some* preimage — the property being
 * bought is that nobody knows one.)
 */
export const UNVERIFIABLE_PASSWORD_HASH = [
  'scrypt',
  'N=65536,r=8,p=1',
  randomBytes(16).toString('base64url'),
  randomBytes(32).toString('base64url'),
].join('$');

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

/**
 * Keep the platform account in step with the practitioner row that shares its password.
 *
 * `createTenant` copies the account's hash into the tenant file so that one password works at both
 * doors (see the comment there). A password change behind either door that updated only one store
 * would leave the other answering with the *old* password — which for the "I think my password is
 * compromised" case is the worst possible outcome. So the core's change calls back here through the
 * injected `onCredentialChanged`, and the core still never learns this file exists.
 */
export function updateAccountPassword(registry, email, passwordHash) {
  return (
    registry
      .prepare('UPDATE account SET password_hash = ? WHERE email = ?')
      .run(passwordHash, String(email).toLowerCase()).changes === 1
  );
}

/** The same for the address. False when the platform already has an account at the new address. */
export function updateAccountEmail(registry, oldEmail, newEmail) {
  const wanted = String(newEmail).toLowerCase();
  if (registry.prepare('SELECT id FROM account WHERE email = ?').get(wanted)) return false;
  return (
    registry
      .prepare('UPDATE account SET email = ? WHERE email = ?')
      .run(wanted, String(oldEmail).toLowerCase()).changes === 1
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
              t.id AS tenant_id, t.slug, t.name, t.plan, t.status, t.past_due_since
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
    heading: 'A payment needs attention',
    detail: 'Your practice stays available during the configured 14-day payment grace period. Update payment details to keep access after that period. Nothing has been deleted.',
  },
  cancelled: {
    allowed: false,
    heading: 'The subscription has ended',
    detail: 'Practice access is paused. Your encrypted documents remain stored during the published retention period. Contact the service operator to arrange export or deletion.',
  },
};

/**
 * How long a practice keeps its doors open after a card fails, before the documents are locked.
 *
 * Stripe's own dunning runs for weeks, and cutting a working practice off at the first failed charge is
 * how a fixable billing hiccup becomes a cancellation. Zero means lock out at once. Per install, because
 * how much slack to give a paying customer is the operator's call and not the software's.
 */
export const pastDueGraceDays = () => {
  const value = Number(process.env.TICKMARK_PAST_DUE_GRACE_DAYS);
  return Number.isFinite(value) && value >= 0 ? value : 14;
};

/**
 * Whether the documents open for this tenant right now.
 *
 * `active` opens them; `pending_payment` and `cancelled` do not. `past_due` is the one with a judgement
 * in it: a card that failed is a mistake to fix, not a decision to stop paying, so the documents stay
 * open for `pastDueGraceDays()` while Stripe chases the card and close after it. `cancelled` — the
 * subscription is over — still closes at once, because that is a decision rather than a hiccup.
 */
export function tenantAllowsAccess(tenant, at = new Date()) {
  if (tenant?.lifecycle_state && tenant.lifecycle_state !== 'active') return false;
  if (tenant?.status === 'past_due') {
    const since = Date.parse(tenant?.past_due_since ?? '');
    // A past-due practice with no clock is a state this code did not create (a hand-edited row). It is
    // refused rather than waved through: an unmeasurable grace period must not become a door left open.
    if (!Number.isFinite(since)) return false;
    return at.getTime() < since + pastDueGraceDays() * 86400000;
  }
  return (TENANT_STATUS[tenant?.status] ?? TENANT_STATUS.cancelled).allowed;
}

/** Record what Stripe says. Returns the previous status, for the audit line. */
export function setTenantBilling(registry, tenantId, { status = null, plan = null, customerId = null, subscriptionId = null, at = now() }) {
  const current = registry
    .prepare('SELECT status, plan, stripe_customer_id, stripe_subscription_id, past_due_since FROM tenant WHERE id = ?')
    .get(tenantId);
  if (!current) return null;

  const nextStatus = status ?? current.status;
  // The grace clock starts when the card first fails and stops the moment it is fixed. A repeat failure
  // keeps the original clock rather than buying a fresh window — so "keep retrying a dead card" is not
  // a way to hold the documents open forever.
  const pastDueSince =
    nextStatus === 'past_due' ? (current.status === 'past_due' ? current.past_due_since : at) : null;

  registry
    .prepare(
      `UPDATE tenant
          SET status = ?, plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, past_due_since = ?
        WHERE id = ?`,
    )
    .run(
      nextStatus,
      plan ?? current.plan,
      customerId ?? current.stripe_customer_id,
      subscriptionId ?? current.stripe_subscription_id,
      pastDueSince,
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
export function createTenant(registry, pool, { ownerAccountId, name, slug = null, email = null, plan = 'standard', status = 'active', storageQuotaBytes = 5 * 1024 ** 3 }) {
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
    passwordHash: account?.password_hash ?? UNVERIFIABLE_PASSWORD_HASH,
  });

  registry
    .prepare('INSERT INTO tenant (id, practice_id, slug, name, plan, status, storage_quota_bytes, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, practiceId, finalSlug, name, plan, status, storageQuotaBytes, ownerAccountId, now());
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
        `SELECT t.id, t.slug, t.name, t.plan, t.status, t.past_due_since,
                t.storage_quota_bytes, t.lifecycle_state, t.deletion_after
           FROM tenant_host h JOIN tenant t ON t.id = h.tenant_id
          WHERE h.host = ?`,
      )
      .get(String(host).toLowerCase().replace(/:\d+$/, '')) ?? null
  );
}

export function tenantForSlug(registry, slug) {
  return (
    registry
      .prepare('SELECT id, slug, name, plan, status, past_due_since, storage_quota_bytes, lifecycle_state, deletion_after FROM tenant WHERE slug = ?')
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

/** Change one practice's limit without changing another tenant's allowance. */
export function setTenantStorageQuota(registry, tenantId, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError('storage quota must be a positive safe integer');
  return registry.prepare('UPDATE tenant SET storage_quota_bytes = ? WHERE id = ?').run(bytes, tenantId).changes === 1;
}

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
        `SELECT t.id, t.slug, t.name, t.plan, t.status, t.lifecycle_state,
                t.past_due_since, t.storage_quota_bytes
           FROM link_index l JOIN tenant t ON t.id = l.tenant_id
          WHERE l.token_prefix = ?`,
      )
      .get(linkPrefixOf(token)) ?? null
  );
}

/** Add the registry index and lifecycle row for an invitation after its tenant record exists. */
export function recordHostedInvite(registry, { tenantId, token, email, role, expiresAt, at = new Date() }) {
  const tokenHash = hashToken(token);
  registry.exec('BEGIN IMMEDIATE');
  try {
    registry.prepare(
      `INSERT INTO hosted_invite (token_hash, tenant_id, email, role, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(tokenHash, tenantId, String(email).toLowerCase(), role, expiresAt, at.toISOString());
    registry.prepare(
      'INSERT OR IGNORE INTO link_index (token_prefix, tenant_id, created_at) VALUES (?, ?, ?)',
    ).run(tokenHash.slice(0, LINK_PREFIX_LENGTH), tenantId, at.toISOString());
    registry.exec('COMMIT');
    return true;
  } catch (error) {
    registry.exec('ROLLBACK');
    throw error;
  }
}

/** Invitation metadata by bearer token. No sealed key or raw token is returned. */
export function hostedInviteByToken(registry, token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return registry.prepare('SELECT token_hash, tenant_id, email, role, expires_at, state, account_id FROM hosted_invite WHERE token_hash = ?')
    .get(hashToken(token)) ?? null;
}

/**
 * Prepare cross-database acceptance. The account is created or authenticated first; membership remains
 * pending until the tenant database has atomically claimed its invitation and created the practitioner/key copy.
 */
export async function prepareHostedInviteAcceptance(registry, {
  tenantId, token, email, password, passwordHash, role, expiresAt, at = new Date(),
}) {
  const tokenHash = hashToken(token);
  const invited = registry.prepare('SELECT * FROM hosted_invite WHERE token_hash = ?').get(tokenHash);
  if (invited && invited.tenant_id !== tenantId) return { state: 'wrong-tenant' };
  if (invited && (invited.state === 'accepted' || invited.state === 'revoked')) return { state: invited.state };
  if (invited && invited.expires_at <= at.toISOString()) return { state: 'expired' };
  if (invited && invited.email !== String(email).toLowerCase()) return { state: 'wrong-email' };
  if (invited && invited.role !== role) return { state: 'wrong-role' };

  const account = accountByEmail(registry, email);
  if (account && !(await verifyPassword(password, account.password_hash))) return { state: 'bad-password' };
  const accountId = account?.id ?? newId();
  const acceptedHash = account?.password_hash ?? passwordHash;

  registry.exec('BEGIN IMMEDIATE');
  try {
    // Compatibility for invitations issued before the registry mirror existed. The core has already
    // checked the live tenant invitation; bind this token to the first valid acceptance attempt.
    if (!invited) {
      registry.prepare(
        `INSERT INTO hosted_invite
          (token_hash, tenant_id, email, role, expires_at, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(tokenHash, tenantId, String(email).toLowerCase(), role, expiresAt, at.toISOString());
      registry.prepare(
        'INSERT OR IGNORE INTO link_index (token_prefix, tenant_id, created_at) VALUES (?, ?, ?)',
      ).run(tokenHash.slice(0, LINK_PREFIX_LENGTH), tenantId, at.toISOString());
    }

    const current = registry.prepare('SELECT state, account_id FROM hosted_invite WHERE token_hash = ?').get(tokenHash);
    if (current.state === 'accepted' || current.state === 'revoked') {
      registry.exec('COMMIT');
      return { state: current.state };
    }
    if (current.account_id && current.account_id !== accountId) {
      registry.exec('COMMIT');
      return { state: 'acceptance-in-progress' };
    }
    if (!account) {
      registry.prepare('INSERT INTO account (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(accountId, String(email).toLowerCase(), acceptedHash, at.toISOString());
    }
    registry.prepare(
      `UPDATE hosted_invite SET state = 'accepting', account_id = ?, created_account = ?
        WHERE token_hash = ? AND state IN ('pending', 'accepting')`,
    ).run(accountId, account ? 0 : 1, tokenHash);
    registry.exec('COMMIT');
  } catch (error) {
    registry.exec('ROLLBACK');
    if (/UNIQUE constraint failed: account\.email/i.test(error.message ?? '')) return { state: 'account-race' };
    throw error;
  }
  return { state: 'ready', accountId, passwordHash: acceptedHash };
}

/** Finalize registry membership only after the tenant-side claim committed. Idempotent for recovery. */
export function completeHostedInviteAcceptance(registry, { token, tenantId, accountId, at = new Date(), issueSession = true }) {
  const tokenHash = hashToken(token);
  registry.exec('BEGIN IMMEDIATE');
  try {
    const invite = registry.prepare('SELECT tenant_id, state, account_id FROM hosted_invite WHERE token_hash = ?')
      .get(tokenHash);
    if (!invite || invite.tenant_id !== tenantId || invite.account_id !== accountId ||
        !['accepting', 'accepted'].includes(invite.state)) {
      registry.exec('ROLLBACK');
      return null;
    }
    registry.prepare(
      'INSERT INTO tenant_member (tenant_id, account_id, created_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id, account_id) DO NOTHING',
    ).run(tenantId, accountId, at.toISOString());
    registry.prepare(
      `UPDATE hosted_invite SET state = 'accepted', accepted_at = COALESCE(accepted_at, ?)
        WHERE token_hash = ?`,
    ).run(at.toISOString(), tokenHash);
    const session = issueSession ? createSaasSession(registry, accountId, at) : null;
    registry.exec('COMMIT');
    return session;
  } catch (error) {
    registry.exec('ROLLBACK');
    throw error;
  }
}

/** Finish a registry write interrupted after the tenant transaction committed. */
export function reconcileHostedInvite(registry, pool, token, at = new Date()) {
  const invite = hostedInviteByToken(registry, token);
  if (!invite || invite.state !== 'accepting' || !invite.account_id) return false;
  const db = pool.get(invite.tenant_id);
  const row = db.prepare(
    `SELECT p.email, p.removed_at
       FROM invite i JOIN practitioner p ON p.id = i.used_by
      WHERE i.token_hash = ? AND i.used_at IS NOT NULL`,
  ).get(invite.token_hash);
  if (!row || row.email !== invite.email || row.removed_at !== null) return false;
  return Boolean(completeHostedInviteAcceptance(registry, {
    token, tenantId: invite.tenant_id, accountId: invite.account_id, at, issueSession: false,
  }));
}

export function revokeHostedInvite(registry, tokenHash, tenantId) {
  registry.prepare("UPDATE hosted_invite SET state = 'revoked' WHERE token_hash = ? AND tenant_id = ? AND state IN ('pending', 'accepting')")
    .run(tokenHash, tenantId);
}

/** Drop one tenant membership; the tenant file remains the final authority for already issued sessions. */
export function removeTenantMembership(registry, practiceId, email) {
  const tenant = tenantForPractice(registry, practiceId);
  if (!tenant) return false;
  const account = accountByEmail(registry, email);
  if (!account) return false;
  return registry.prepare('DELETE FROM tenant_member WHERE tenant_id = ? AND account_id = ?')
    .run(tenant.id, account.id).changes === 1;
}

/** An operator-facing count, for /healthz and for nobody else. */
export function countTenants(registry) {
  return registry.prepare('SELECT COUNT(*) AS n FROM tenant').get().n;
}



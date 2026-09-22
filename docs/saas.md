# Many practices on one machine

This file is the design decision first, in the same way `docs/members.md` was: the answer decides the
shape of the data, and the shape of the data is expensive to change later.

It has two parts: an audit of how **Plain Forms** (`../plain-forms`, a working multi-tenant SaaS in
this workspace) does tenancy, and the plan for wrapping Tickmark as a hosted, multi-tenant service
without touching the single-tenant open-source core. **All five steps of §2.6 are built and
tested** — see the status notes there — so this file is now a record of a decision *and* of the
software that carries it.

---

## Part 1 — What Plain Forms actually does

Plain Forms is a Next.js application backed by **Supabase** (hosted Postgres + Auth + Storage).
There is exactly one database for everybody. The findings below are drawn from
`supabase/schema_baseline.sql` (29 tables, 95 RLS policies), `src/lib/workspace/`,
`src/lib/supabase/`, `src/lib/api/auth.ts` and `src/app/api/`.

### 1.1 Tenant isolation: shared database, `workspace_id` column, Postgres RLS

A tenant is a **workspace** — not a database file. The shape:

```sql
workspaces        (id uuid, slug, name, owner_id uuid, settings jsonb, ...)
workspace_members (workspace_id, user_id, role: owner|admin|member|viewer, invited_by, joined_at)
```

Every tenant-owned table carries the tenant key as a plain column — `forms.workspace_id`,
`form_responses` via its `form_id → forms` chain, and so on. Ownership is *data*, not structure.

Enforcement is **Row Level Security in the database itself**, not in application code. The load-bearing
function is small enough to quote:

```sql
CREATE FUNCTION get_my_workspace_ids() RETURNS SETOF uuid
  SECURITY DEFINER STABLE SET search_path TO ''
  AS $$ SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid() $$;
```

and the policies all reduce to one pattern:

```sql
CREATE POLICY "Authenticated users can view their workspace forms" ON forms FOR SELECT
  USING (workspace_id IN (SELECT get_my_workspace_ids()));
```

So isolation is a database property. A route that forgets its `WHERE workspace_id = …` still cannot
read another tenant's rows, because Postgres refuses. There is also a deliberate escape hatch: the
**service role** key bypasses RLS and is used only for server-owned work (webhook dispatch, billing
sync, cron jobs, the public submission endpoint) — `src/lib/supabase/service.ts` fails *closed* in
production when that key is missing.

**Not per-tenant files.** There are no `tenant_abc123.sqlite` files anywhere. One schema, shared by
every workspace, with the id column as the wall.

### 1.2 Authentication routing: platform auth, per-request tenant resolution

Sessions are **Supabase Auth (GoTrue) JWTs in cookies**. The browser talks to Supabase directly; the
server reads the same cookies through `createServerClient` (`src/lib/supabase/server.ts`) — the JWT
is verified by Supabase, not by application code. Two extra authentication surfaces exist:

- **API keys** for the REST API: `pf_live_<32 random chars>`, stored only as a SHA-256 hash with a
  short prefix for display, compared in constant time (`src/lib/api/auth.ts`).
- **CSRF + rate limits** on cookie-authenticated writes.

The important observation for Tickmark: **the tenant is not in the token.** The session says who the
person is; which workspace they are acting in is *resolved per request* by querying
`workspace_members` (the UI keeps the chosen workspace in React context and a `localStorage` slug;
server routes resolve the user's workspace membership themselves — see the workspace lookup in
`POST /api/forms`). That split is what makes the RLS backstop honest: resolution can be wrong without
being dangerous, because the database re-derives what the member is actually allowed to touch.

### 1.3 Encrypted payloads: ciphertext as data, keys as browser state

Plain Forms is zero-knowledge in the same sense Tickmark is, and it stores everything **inside the
database** — there is no object-storage bucket for responses at all:

- A form carries its **ECDH P-256 public key** (`forms.ecdh_public_key`).
- A respondent's browser generates an **ephemeral key pair per submission**, derives an AES-256-GCM
  key against the form's public key, and encrypts. Only the ciphertext and the *respondent's public
  key* travel to the server (`form_responses.answers` jsonb, `respondent_public_key` column).
- Attachments arrive the same way: base64 ciphertext in a `files` array, capped (≤ 20 files,
  ≤ 40 MB total, zod-validated; a CHECK constraint caps `answers` at 1 MB).
- The owner's private key **never reaches the server in any form**. It is stored client-side, wrapped
  under a user-chosen sync passphrase (PBKDF2-SHA256, 600k iterations), with the derived key held in
  memory for one hour and recovery codes for the lost-passphrase case (`src/lib/security/`).

The server's role in the encrypted path is exactly Tickmark's: **validate, size-cap, store, and
serve opaque bytes**. It cannot read them, and no tenant context changes that, because the keys are
not on the server at all.

### 1.4 What is worth copying, and what is not

| Plain Forms does | Worth taking to Tickmark? |
| --- | --- |
| Tenant = a row, not a file; ownership as a column | **Yes in spirit** — Tickmark already has `practice` |
| Enforcement in the storage layer, invisible to routes | **Yes** — but SQLite has no RLS, so it must be a different mechanism (Part 2) |
| Platform-level auth (accounts independent of tenants) | **Yes** — the SaaS layer must own sign-up/sign-in |
| Per-request tenant resolution + a backstop that cannot be forgotten | **Yes** — this is the heart of the plan |
| Service-role bypass for server-owned work | **Yes** — reminders/chase run across tenants and must not be tenant-scoped |
| One shared schema for all tenants | **Partly** — see the isolation decision below |
| Ciphertext stored in-DB as JSON | **No** — Tickmark's blob files and envelope format are better for 25 MB documents, and they already exist |
| Billing/plan tables beside tenant data | **No** — billing belongs to the SaaS layer, not the core schema |

---

## Part 2 — The Tickmark wrapper strategy

### 2.1 The position Tickmark starts from

Three facts decide the whole plan, and all three are already true:

1. **The tenant already exists.** `practice` is the tenant. `practitioner.practice_id`,
   `client.practice_id`, `request.practice_id`, `practice_key.practice_id` are the tenant keys, and
   every store function that reads practice data already takes `practiceId` as its first argument.
   The codebase's own rule — *authorization is a scoping of the query, not a check beside it* — is
   the tenancy discipline a SaaS needs. The core has been multi-tenant-ready since `members.md`.
2. **The database and the crypto are already isolated.** `src/db.js` and `src/crypto.js` know
   nothing about HTTP or tenancy; `web/tickmark-crypto.js` and `src/mailer.js` likewise. The
   architectural constraint for the SaaS version is therefore not a refactor — it is a *refusal*:
   the multi-tenancy layer may wrap these modules, never enter them.
3. **Handlers receive their dependencies by injection.** `contextFor()` hands every route handler
   `{ db, blobDir, mailer, ... }`. This is the seam the wrapper uses.

### 2.2 The isolation decision: one SQLite file per practice

Plain Forms gets its wall from Postgres RLS, which SQLite does not have. Row-scoping in application
code is the only shared-file option, and a check beside a query is exactly the thing the codebase
says someone eventually forgets. So:

> **In SaaS mode, each practice gets its own SQLite file and its own blob directory.**
> `data/tenants/<tenant_id>/tickmark.db` and `data/tenants/<tenant_id>/blobs/` — the directory named
> for the registry's tenant row, whose `practice_id` column records the practice inside the file.

The isolation boundary becomes the **filesystem**, which needs no RLS, no query rewriting and no
policy language. A tenant's queries are physically unable to name another tenant's rows, because
another tenant's rows are not in the file that was opened. Backup and export ("your data, on
request") becomes copying a directory — which is already the whole of the self-hosted backup story.
Right-deletion for GDPR is the same directory, dropped.

What makes this honest rather than a workaround: `openDatabase(file)` is **not changed**. It is
called once per tenant with a different path. The core schema, migrations and store functions run
unmodified inside each file; `practice_id` columns keep existing (the single-tenant deployment still
has one practice per file). The multi-tenancy layer *chooses* which file to open — it never rewrites
a query.

The cost, stated: N files means N `DatabaseSync` handles, and a runaway SaaS will hold thousands.
They are opened lazily and closed LRU-wise, and N files means N WAL checkpoints — fine at the scale
of accounting firms (hundreds of practices, not millions of users), and exactly the wrong design
past that. This document is the place to say it: **this design is for the first thousand practices.**
At Postgres scale, the swap is behind the same seam (§2.4) and the store layer does not change.

### 2.3 The SaaS layer, as a flag

```
MULTI_TENANT=1 node src/server.js        # hosted: registry + per-tenant files
node src/server.js                       # self-hosted: exactly as today, byte for byte
```

One new module family, all beside the core rather than inside it:

```
src/tenancy/
  registry.js    the operator's database: accounts, practice mapping, plans, SaaS sessions
  resolve.js     request → tenant: host or path → practice id → opened database handle
  pool.js        lazy open / LRU close of tenant database handles
  entry.js       the MULTI_TENANT=1 bootstrap that wraps createApp
```

- **`registry.js`** owns the things the open-source core deliberately has no opinion about: a
  person's *account* (email + password, possibly across several practices — the core's
  `practitioner` stays per-practice and per-file), which practice a subdomain maps to, what plan a
  practice is on, and the SaaS session table. It is its own small SQLite file (`data/saas.db`), so
  the operator's data survives a tenant being deleted. Password hashing uses the same
  `hashPassword` from `src/crypto.js` — reused, not copied.
- **`pool.js`** is a map from practice id to an open handle, opened on first touch, closed
  least-recently-used. It calls `openDatabase()` and nothing else.
- **`entry.js`** exists so that `MULTI_TENANT` unset runs the untouched `src/server.js` path. The
  SaaS entry calls `createApp()` the same way `server.js` does; the difference is what it *puts in*
  the context.

### 2.4 Route hijacking: the seam is `contextFor`, not the route table

`src/app.js`'s route table and handlers stay **byte-for-byte identical**. The interception happens
where every handler is already given its dependencies:

```js
// today (single-tenant)
const context = await contextFor(db, request, response, url, params.slice(1));
await handler({ ...context, blobDir, maxUploadBytes, webDir, mailer, chaseBudgetMs });

// MULTI_TENANT=1 — the same lines, with a tenant-aware resolver installed.
// resolveTenant(request) → { practiceId, db, blobDir, mailer, chaseBudgetMs, plan }
//   db   = the calling practice's own SQLite handle (via the pool)
//   blobDir = data/tenants/<id>/blobs
//   mailer  = the practice's own relay configuration
```

Concretely, `createApp` grows one optional dependency — `resolveTenant(request)` — defaulting to
the current behaviour when absent. The flag changes what is **injected**, never what is **routed**:

1. **Resolution.** `resolveTenant` inspects the host (`acme.tickmark.example`) or, for development,
   a `/t/<slug>/` path prefix, and looks the practice up in the registry. Unknown host → a
   "no such practice" page, before any tenant database is opened.
2. **Authentication, in two layers.** The SaaS session cookie (registry-level, a person) is
   verified first; `practitionerFor(db, request)` — the existing core function, run *against the
   tenant's file* — then verifies the person is a live member of *this* practice, exactly as the
   self-hosted build does today. A person in one practice presenting a session from another fails
   the second check even if the first passes.
3. **Public routes keep working unchanged.** `/r/<token>`, `/invite/<token>`, `/healthz` and the
   asset route do not need a tenant from the host: the token lookup finds the right file through a
   small `token_prefix → practice` index in the registry. (Trying every file is not the design —
   it would turn isolation into timing.) The zero-knowledge property is preserved untouched: an
   access token is still stored only as a digest, the envelope still arrives sealed, and the server
   still cannot read any of it.
4. **Cross-tenant writes are impossible by construction.** The store functions scope by the
   practice id their *session* carries, and a session row exists only in the file whose sign-in
   created it — so a session from another practice resolves to nothing before any store function
   runs. The resolver names the file; the session inside it names the practice; the two can never
   disagree, because each file keeps its own sessions. The existing tenancy tests
   (`test/tenancy.test.js`) keep passing against a two-file setup — that is the acceptance test
   for this whole section.

The service-role escape hatch from Plain Forms maps onto `chase`/reminders: a run across many
practices opens each tenant's handle through the pool, sends through each practice's own relay
config, and never writes into another file. The chase budget already exists as an injected
parameter, which is now also where a per-plan limit lands.

### 2.5 What the SaaS layer adds, and what it must never touch

| Layer | Owns | Must never touch |
| --- | --- | --- |
| Core (`src/db.js`, `src/store.js`, `src/crypto.js`, `web/tickmark-crypto.js`, `src/mailer.js`) | schema, queries, hashing, envelopes, SMTP | tenancy, billing, HTTP concerns |
| App (`src/app.js`, `src/views.js`) | routes, pages, forms | which file the `db` in its context came from |
| Tenancy (`src/tenancy/*`) | files-per-tenant, resolution, pooling, registry, plans | query text, crypto, the envelope format |

Billing sits in the tenancy layer only as *limits already injected* (seat counts, chase budget, max
upload bytes — `maxUploadBytes` is already a parameter). Payment processing is outside this design
on purpose; when it arrives it talks to `registry.js` and never to a tenant file.

### 2.6 The plan, in order — and what was built

All five steps are **built and green** (`test/saas.test.js`, `test/import-tenant.test.js`, and the
rest of the suite at 190 passing):

1. **`resolveTenant` + flag. Built.** `createApp` grew three optional injected dependencies —
   `resolveTenant`, `onLinkIssued`, `healthCheck` — each defaulting to today's behaviour, so the
   route table and every handler are otherwise untouched. `server.js` checks
   `MULTI_TENANT=1` and delegates to `src/tenancy/entry.js`, which is the only file that wires them
   together. Acceptance: two practices, two files, one process; every page answers only for its own
   tenant; a wrong host is refused before any tenant file is opened.
2. **Registry + pool. Built.** `src/tenancy/pool.js` (lazy open, LRU close) and
   `src/tenancy/registry.js` (accounts, SaaS sessions, the host map, tenants). Provisioning goes
   through the core's own `createPractice`/`createPractitioner`, and the account's password hash is
   copied into the practice's file — so the first sign-in is the same page the self-hosted product
   shows, and the SaaS layer never invents a second way in.
3. **The link index. Built — with one refinement to the plan.** The index (`link_index`, digest
   prefixes only) is not written by a resolver-side sweep but by an injected `onLinkIssued` the
   core's `issueLink` already calls — a no-op single-tenant, the registry's recorder in SaaS mode.
   The core never learns a registry exists, and the acceptance test passes: a client link resolves
   with no host hint, and a token that was never issued is an unknown address, not a practice.
   Resolution also accepts a `/t/<slug>/` path prefix (development and preview, where wildcard DNS
   does not exist), stripped before routing.
4. **Plan limits as injection. Built.** `PLANS` in the registry maps a plan to the two currencies
   the core already understands — `chaseBudgetMs` and `maxUploadBytes` — and the resolver injects
   them per tenant. An unknown plan reads as `standard`, never as unlimited.
5. **Migration tooling. Built.** `tools/import-tenant.mjs` copies a single-tenant install into the
   tenants root, verifies the copy by hash and by reading the practice back through the pool, and
   registers an owner account carrying the practice's own credentials. **The originals are left in
   place on purpose** — a botched move is a data-loss incident, a botched copy is a retry.

One further seam worth recording: `request.client_id` remains NOT NULL, and nothing in this plan
changes the core schema. A practice's *data* is untouched by tenancy — which is the point.

### 2.8 The gateway and billing. Built.

The public surface — `/signup`, `/login`, `/dashboard`, `/billing/*`, `/webhooks/stripe` — is the
`preHandle` hook in `createApp`, answered by `src/tenancy/gateway.js`. Everything else falls through
to the core app untouched. The pieces:

- **Signing up** creates an account and a tenant with status `pending_payment`, then sends the
  browser straight to a Stripe Checkout Session. Its slug comes from the practice's name
  (`slugify`), and a name already taken gets `-2`, so two Acme Accountings are two addresses.
- **The tenant id is the anchor.** It travels in the Checkout Session's `metadata` *and* in
  `subscription_data[metadata]`, because `customer.subscription.*` events arrive with a
  subscription and no session. Nothing in the webhook trusts a form or a URL.
- **`src/tenancy/stripe.js` is Stripe over `fetch`, with no package.** The official SDK is a
  dependency tree in a project with none; the REST API is form-encoded requests. Webhook
  verification is the real scheme — HMAC-SHA256 over `timestamp + '.' + rawBody`, constant-time
  compare, five-minute replay window (`test/gateway.test.js` proves a forged signature and a stale
  one are both refused).
- **The webhook is a translation layer** (`src/tenancy/billing.js`): `checkout.session.completed`
  → `active`/`standard`; `customer.subscription.updated`/`deleted` → the mapped status;
  `invoice.payment_failed` → `past_due`, and `invoice.payment_succeeded` → `active` again. An event
  about an unknown tenant is acknowledged with `handled: false` — Stripe retrying it would change
  nothing.
- **Signing in bridges into the tenant's own session.** The registry account is authenticated with
  the core's own `hashToken`/`verifyPassword` discipline, and a core session is then minted inside
  the practice's file with the core's own `createSession`, under the core's own cookie name. That
  is why `src/app.js` still knows nothing about registries, and why every existing page works
  unchanged for a hosted practice.
- **The billing wall lives in the resolver** (`§2.4`, step 4): a tenant whose status is not
  `active` is answered *before* `pool.get`, so a locked-out practice's database is never opened for
  a request that cannot be served. Client links (`/r/<token>`) are deliberately **not** blocked —
  a client mid-collection must not be stranded by their accountant's billing.
- **Confirmed sign-in, and the one thing this does not do yet.** Payment is confirmed by the
  webhook, never by the `success_url` redirect: a browser can close before it arrives, and Stripe
  retries until the endpoint says 200.

One limitation, stated rather than discovered: **slug paths (`/t/<slug>/…`) do not rewrite the
core's own redirects** — after a form posts under a slug prefix, the core redirects to `/requests/…`
without the prefix, which only matters on a deployment with no tenant host mapped. Slug paths are
the development and preview surface; production deployments map hosts (`tenant_host`), where the
prefix problem does not exist. Fixing it properly means threading the prefix through `redirect()`,
and that is a change to the core this sprint did not need.

---

## Part 3 — Running a test environment

### 3.1 What is proven, and what is not

Everything below is exercised by `npm test` (202 tests, including `test/gateway.test.js` and
`test/saas.test.js`), and the multi-tenant server has been booted by hand through the whole path:
sign up → sign in on a practice's host → workspace → billing wall → activation.

**Not yet proven: a real Stripe round trip.** Checkout is tested against a stubbed `fetch` that
inspects the exact form body Stripe would receive, and webhooks are tested with payloads signed the
way Stripe signs them — but no real Stripe account has been driven end to end. That is exactly what
a test environment with test-mode keys is for, and it is the first thing to do in one.

### 3.2 Two modes, one codebase

```bash
# Self-hosted: one practice, one file, no accounts, no billing. Unchanged.
node src/server.js

# Hosted: many practices, a registry, the public gateway and Stripe.
MULTI_TENANT=1 node src/server.js
```

On Windows PowerShell:

```powershell
$env:MULTI_TENANT='1'; $env:TICKMARK_DATA='data'; $env:PORT='3000'; node src/server.js
```

The log line names the registry and the tenants directory, and `/healthz` answers
`{"ok":true,"practices":<tenants>}`.

### 3.3 A practice without Stripe (the fastest way in)

`/signup` creates a tenant in `pending_payment` and sends it to Stripe — with no Stripe keys, the
workspace stays behind the billing wall. `tools/create-tenant.mjs` is the operator's way past that,
and it is the same tool to reach for when a webhook is not arriving:

```bash
node tools/create-tenant.mjs --data data \
  --email you@example.com --password 'at least 12 characters' \
  --name "Acme Accounting" --host acme.localhost --activate
```

Then sign in at `/login` with that email and password — on the practice's own address
(`http://acme.localhost:3000/login`), which is the flow a real member uses: the registry session is
bridged into the practice's own file, and the browser is sent to `/requests`.

**Hosts.** Chrome and Firefox resolve any `*.localhost` to loopback, so `acme.localhost:3000` works
with no configuration. Other clients need a hosts-file entry
(`127.0.0.1 acme.localhost`), or the slug path `/t/acme/…` — which works, with the redirect
limitation recorded in §2.8.

**Cookies over plain HTTP.** Browsers refuse `Secure` cookies on a plain-HTTP host that is not
localhost, so a local trial on `acme.localhost` needs `TICKMARK_INSECURE_COOKIES=1`. It is a real
security setting, not a dev flag to leave on: unset it (and unset it before running the test suite,
which checks that sign-in sets `Secure`).

### 3.4 With Stripe in test mode

1. Stripe dashboard → **Test mode** → *Developers → API keys* → `STRIPE_SECRET_KEY=sk_test_…`.
2. *Products* → a recurring price → `STRIPE_PRICE_ID=price_…`.
3. `stripe login`, then `stripe listen --forward-to localhost:3000/webhooks/stripe` — it prints a
   signing secret for this session; put it in `STRIPE_WEBHOOK_SECRET=whsec_…`.
4. `TICKMARK_PUBLIC_URL=http://localhost:3000` — where Stripe returns the browser after checkout.
5. Sign up at `/signup`; pay with `4242 4242 4242 4242`, any future expiry, any CVC. The CLI
   forwards `checkout.session.completed`, the tenant flips to `active`, and the dashboard says so.

To watch the failure paths, use the decline card `4000 0000 0000 0341`, or send events directly:
`stripe trigger invoice.payment_failed`, `stripe trigger customer.subscription.deleted`. Both should
move the practice to `past_due` / `cancelled` and put the billing wall in front of its pages —
while client links (`/r/<token>`) keep working.

### 3.5 The environment, in one table

| Variable | Default | What it does |
| --- | --- | --- |
| `MULTI_TENANT` | unset | `1` runs the hosted server; anything else runs the self-hosted one |
| `PORT` | `3000` | |
| `TICKMARK_DATA` | `data` | the directory holding the registry and the tenants |
| `TICKMARK_REGISTRY` | `<data>/saas.db` | the operator's database |
| `TICKMARK_TENANTS` | `<data>/tenants` | one directory per practice, each with its own db and blobs |
| `TICKMARK_TENANT_DOMAIN` | unset | with it, a new practice gets `<slug>.<domain>` as its host |
| `TICKMARK_PUBLIC_URL` | `http://localhost:3000` | where Stripe returns the browser |
| `STRIPE_SECRET_KEY` | unset | without it, sign-up still works and billing says it is not configured |
| `STRIPE_PRICE_ID` | unset | the recurring price practices subscribe to |
| `STRIPE_WEBHOOK_SECRET` | unset | without it the webhook endpoint refuses every event |
| `TICKMARK_MAX_UPLOAD` | 25 MB | the per-file ceiling for the *process*; a plan overrides it per tenant |
| `TICKMARK_INSECURE_COOKIES` | unset | `1` drops `Secure` from cookies — local plain-HTTP trials only |
| `TICKMARK_SMTP_URL` / `TICKMARK_MAIL_FROM` | unset | one relay for the process (per-tenant relays are not built yet) |

Backing up a hosted install is `cp -r data`, exactly as it is self-hosted: the registry is one file
and every practice is a directory inside it.

### 3.6 What is not ready, honestly

Ready to **try in a test environment**: yes. Ready to **charge a customer**: not yet, and these are
the reasons, in the order they would bite:

1. **No password reset.** A practice that forgets its password needs an operator with database
   access. There is no "forgot password" and no email verification of a new account.
2. **No rate limiting on `/login` or `/signup`.** The core's own sign-in has the same gap; a
   public endpoint makes it worth closing.
3. **Webhook events are not deduplicated.** Every handler sets state rather than appending to it, so
   a repeated event is harmless — but nothing records which event ids have been seen, so a replay
   inside the five-minute window would be executed twice.
4. **A password changed inside the practice does not change the registry's copy.** The practice's
   own pages hash their own password; the gateway hashes the registry's. They are separate records
   and can drift, which matters for gateway sign-in and password reset.
5. **No tenant deletion or export for a leaving customer.** `tools/import-tenant.mjs` goes one way.
6. **One mail relay for the whole installation.** A hosted practice cannot yet send reminders from
   its own address.
7. **`pending_payment` tenants get a real directory and a real practice row** — nobody can read it,
   and an abandoned sign-up leaves a directory behind. A reaper for abandoned tenants does not exist
   yet.


### 2.7 What this design costs, stated rather than discovered

- **Per-file open handles.** Bounded by the pool; fine for hundreds of practices; the wrong design
  past that, and the seam to swap is `openDatabase()` plus the pool.
- **The registry is now the crown jewels** — a leak of `saas.db` maps every account to every
  practice. It holds no passphrases and no key material (nothing ever does), but it holds session
  digests and email addresses, and it gets the same hashing discipline as the core.
- **Cross-tenant search and operator tooling get harder on purpose.** There is no query that sees
  every practice's rows. When support needs one, it opens the file explicitly, as
  `tools/decrypt.mjs` does today — with the audit trail that comes with doing it by hand.
- **The envelope format does not change.** Nothing in this plan adds a tenant key, a tenant salt or
  a tenant KMS. The practice's passphrase still exists only in the practice's heads, and a lost
  passphrase is still unrecoverable by the operator — which the SaaS version says out loud on the
  setup page, in the same warning box, because the promise is the product.





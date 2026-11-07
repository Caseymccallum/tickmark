# Architecture and Data Custody

Verified against the source at `6ff16ff`, and against a running instance seeded with fictional data.
Every claim below is either a file reference or an observation recorded in `evidence/`.

---

## 1. Verified technology stack

| Concern | Implementation | Evidence |
|---|---|---|
| Language / runtime | JavaScript (ESM), Node ≥ 24 | `package.json` `"type": "module"`, `engines.node >=24.0.0`; ran on v26.5.0 |
| Third-party packages | **None** | `"dependencies": {}`, `"devDependencies": {}`; no lockfile, no `node_modules`; imports are exclusively `node:*` |
| HTTP server | `node:http` + route table | `src/server.js`, `src/app.js` (523 lines; `ROUTES` at `src/app.js:121`) |
| Database | SQLite via `node:sqlite` `DatabaseSync` | `src/db.js:26`, `src/db.js:867`, `src/tenancy/registry.js:176` |
| DB settings | WAL, `foreign_keys=ON`, `busy_timeout=5000` | `src/db.js:899`, `:907`, `:927` |
| Templates / CSS | Template literals + one CSS string | `src/views.js`, `src/style.js` (52.9 KB) |
| Client scripts | 11 ES modules served from an allowlist | `web/*.js`, served by `asset()` in `src/app.js` |
| Crypto (documents) | Web Crypto: ECDH P-256, HKDF-SHA-256, AES-256-GCM | `web/tickmark-crypto.js` |
| Crypto (passwords) | `node:crypto` scrypt `N=2^16` | `src/crypto.js:28` |
| Mail | Hand-written SMTP over `node:net`/`node:tls` | `src/mailer.js` (24.3 KB) |
| SMS | Hand-written HTTP POST to a gateway | `src/sms.js` |
| Background work | **None.** No queue, no timer, no worker | No scheduler in `src/`; only optional systemd units in `ops/` |
| Container | `node:24-alpine`, non-root, read-only rootfs, `cap_drop: ALL` | `Dockerfile`, `docker-compose.yml` |

**No ORM, no framework, no bundler, no transpiler, no CDN font, no analytics.** The only network egress the server
can make is to an SMTP relay, an SMS gateway, Xero/QuickBooks, or Stripe — each only if configured.

## 2. The seventeen questions, answered

1. **Does Tickmark use Supabase?** **No.** No client, SDK, URL, environment variable or reference in `src/`, `web/`,
   `tools/` or `test/`. The word appears once, in `docs/saas.md:16`, describing a *different* project ("Plain Forms").
2. **PostgreSQL, SQLite or another database?** **SQLite only** — `node:sqlite`, file-backed. No Postgres, no MySQL,
   no MongoDB, no Redis.
3. **Which database is authoritative?** The SQLite file at `TICKMARK_DATA` (default `data/tickmark.db`). In hosted
   mode the *registry* (`data/saas.db`) is authoritative for tenant existence and billing state, and each practice's
   own `data/tenants/<uuid>/tickmark.db` is authoritative for its records. There is no second copy anywhere.
4. **Where are uploaded documents stored?** On the local filesystem, under `TICKMARK_BLOBS` (default
   `blobs/` beside the database), as `<requestId>/<uploadId>.bin`. **Never in the database.** Verified on disk:
   two files of 721 bytes each, inside a per-request directory, named by a generated upload id.
5. **Where are encryption and decryption performed?** **Exclusively in the browser.** Encryption in `web/upload.js` →
   `web/tickmark-crypto.js`; decryption in `web/download.js` → the same module. The server has no decryption path:
   `src/blobs.js` reads at most 84 bytes to check the magic.
6. **Where do cryptographic keys originate?** The practice key pair is generated **in the browser**
   (`generatePracticeKey`, `web/tickmark-crypto.js:78`) and posted as a *public* JWK plus a *wrapped* private key.
   The server never sees the passphrase or the unwrapped key.
7. **Where are keys held during an active session?** In a **JavaScript variable in that browser tab**. There is no
   `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` or Cache API use anywhere in `web/` or `src/`
   (verified by grep — zero matches). Reloading the page re-locks the key.
8. **Which data is accessible to the application server?** All *metadata*: practice and member records, client names,
   email addresses, request titles, item labels, due dates, review states, the client's filename, the file size, the
   arrival time, the event log, and the *wrapped* private keys (useless without the passphrase). Plus outbound email
   bodies it drafts. **Not** document plaintext, and not the unwrapped key.
9. **What information is stored in the browser?** A session cookie (`HttpOnly`, so unreadable by script) and, only
   while a tab is open and unlocked, the unwrapped private key in memory. Nothing persistent beyond the cookie.
10. **Does Tickmark require an internet connection for ordinary operation?** **No.** Self-hosted on a LAN it works
    fully offline; only email/SMS sending and the Xero/QuickBooks imports need egress, and all are optional.
11. **Can Tickmark operate entirely on one local machine?** **Yes** — `node src/server.js`, one file, one port.
    `docs/mvp.md` and the README describe exactly this.
12. **Can it operate on a private self-hosted server?** **Yes.** That is the documented model: one container behind a
    reverse proxy that terminates TLS (`docs/operations.md` §"Running it in production").
13. **What infrastructure would a hosted deployment require?** One Linux host with Node 24 (or Docker), a persistent
    volume, TLS termination at a proxy, SMTP relay credentials, DNS, a backup target *off* that host, and — for paid
    hosting — a Stripe account. `MULTI_TENANT=1` adds a registry file and a per-practice directory; nothing else.
14. **Are external email services configured, optional or required?** **Optional, and genuinely so.** With no relay
    configured the product drafts the reminder in full and the page says it cannot send. SMS is separately optional.
15. **Are backup, restore and disaster recovery actually implemented?** **Yes, with honest limits.** Backups use
    `VACUUM INTO` (`tools/backup.mjs`) with a `--verify` that checks the DB opens *and* that every document the
    database names exists in the copy; `tools/backup-all.mjs` does a fleet. Restore is a documented procedure, not a
    one-keystroke command, and it is drilled in `test/backup.test.js` (delete the original, restore, decrypt a
    document). Limits, stated by the author: the manifest records counts not per-file digests; a backup taken during
    a key re-encryption pass can be inconsistent; the hosted path is exercised against a **fake** Restic transport,
    so a real remote repository is unproven.
16. **Is any user information transmitted to external services?** Only if a feature is switched on: a client's email
    address and the message body to the SMTP relay; a phone number and one line of text to the SMS gateway; client
    **names and email addresses** (never documents) to Xero/QuickBooks on import; billing identifiers to Stripe in
    hosted mode. Nothing is sent anywhere by default.
17. **Does a production deployment currently exist?** **No.** No live domain appears anywhere in the tree, and
    `docs/phase-5-launch-qualification.md` states: *"qualification in progress; this document is not launch
    approval."* The marketing site says hosted access is "awaiting launch validation".

## 3. Trust boundaries

```
BOUNDARY 1 — the client's browser
  • plaintext document exists here, and only here
  • encrypts with the practice PUBLIC key (ECDH P-256, ephemeral per file)
  • holds no practice secret; cannot read other files
        │  HTTPS: TKME envelope only (83-byte header + ciphertext)
BOUNDARY 2 — the application server (SELF-HOSTED = the practice itself)
  • CAN see: metadata, filenames, sizes, times, wrapped private keys
  • CANNOT see: document plaintext, passphrase, unwrapped key
  • enforces: route roles, practice scoping, quotas, rate limits
  • writes: SQLite rows + blob files
        │  optional egress
BOUNDARY 3 — external services (all optional)
  SMTP relay  ← client email address + drafted message text (+ optional
                practice-supplied attachment, which is NOT encrypted)
  SMS gateway ← phone number + one line + link
  Xero / QB   ← client names + emails on import; read scopes only
  Stripe      ← billing identifiers (hosted mode only)

BOUNDARY 4 — the practice's browser (the only place decryption happens)
  • receives the wrapped keys (already public ciphertext)
  • passphrase typed here; unwraps in memory in that tab
  • fetches the envelope, decrypts, hands plaintext to a download
  • plaintext is NEVER rendered into the DOM and NEVER posted back
```

## 4. Document lifecycle, stage by stage

| Stage | Trust boundary | Auth / authz | Sensitive exposure | Server or browser | Persistence | Failure behaviour |
|---|---|---|---|---|---|---|
| **1. Request created** | practice browser → server | session + role (`owner`/`accountant`) | metadata only | server | `request`, `request_item` rows | 404 if practice mismatch |
| **2. Link issued** | server → client | 256-bit token, SHA-256 digest at rest | token is a bearer capability | server | digest in `access_token`; plaintext never stored | revocable; 7/30/90-day expiry |
| **3. Client opens link** | client browser | token only — no account | wrong/expired token → `404` | server renders page | none | generic "nothing at that address" |
| **4. Client uploads** | client browser | token + item must belong to that request | plaintext exists transiently in the tab | **browser encrypts**, server stores | blob file | forged/plaintext envelope → `400`; over quota → refused with remaining bytes |
| **5. Stored** | server filesystem | path derived from a DB row already scoped to a practice | ciphertext + header only | server | `blobs/<req>/<upload>.bin` | a partial upload never becomes a row |
| **6. Practice access** | practice browser | role ≥ `accountant` **and** a key wrapping | plaintext in tab memory during download | **browser decrypts** | none | wrong passphrase → GCM tag fails, no partial plaintext |
| **7. Review** | practice browser → server | role ≥ `accountant` (item state, `/check-all`) | no document content | server | `item.checked` events with a reason | reason stored beside the file, not in email |
| **8. Retention** | operator | role `owner` for key operations | — | server + operator tools | `event` log, tombstones | documented procedure; deletion is explicit |
| **9. Export / deletion** | operator | `owner` | ciphertext-preserving export | server tools | export bundle | `--verify`-able; tombstones replay on restore |

**The single most important property, stated precisely:** the plaintext of a client's document exists in exactly two
places — the client's tab before encryption and the practice's tab after decryption. The server sits between them and
holds only an envelope it has no key for. I verified this by reading the bytes on disk and by confirming the server
refuses a plaintext upload.

## 5. Deployment models — not interchangeable

| Model | What it means | Evidence | Readiness |
|---|---|---|---|
| **Browser-local only** | Not a thing here. There is always a server; the browser only holds keys while open. | — | n/a |
| **Local single-tenant** | `node src/server.js` on one machine, `data/` beside it | Documented in README; exercised by `demo:synthetic` | **Ready** |
| **Self-hosted server** | Container + volume + reverse proxy + TLS | `Dockerfile`, `docker-compose.yml`, `ops/*.service`, `docs/operations.md` | **Ready**, with the proxy as the operator's job |
| **Hosted multi-tenant** | `MULTI_TENANT=1`, registry + per-tenant DBs + Stripe | `src/tenancy/*`, `docs/saas.md`, `docs/phase-5-*` | **Built, not qualified** — no real Stripe call, fake Restic |
| **Public cloud SaaS** | Multi-tenant + a live domain + legal entity | Nothing in the tree | **Not started** |

## 6. Verdict

The architecture is **coherent, unusually simple, and fits its stated purpose.** SQLite is the right call at this
scale and there is no evidence justifying PostgreSQL or any managed database: measured page render at 500 clients and
2,000 documents is 22 ms median, 33 ms worst. A practice would need to be an order of magnitude larger before the
single-writer constraint mattered, and even then only writes contend.

The one architectural risk worth naming: **`src/store.js` is 2,537 lines** and holds most of the data-access surface
(though the 7,173-line `app.js` it was split out of is now 523 lines). That is the file where a tenancy mistake would
most plausibly hide, and it is covered by `test/security.test.js` and `test/tenancy.test.js` rather than by structure.

**No recommendation to move to PostgreSQL, Supabase or any hosted database is justified by the evidence.**

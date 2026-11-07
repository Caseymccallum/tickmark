# Security and Privacy Review

Read-only. No exploitation was attempted against anything but an isolated local instance holding fictional data.
Live probes are recorded in `evidence/probe-live.json`, `probe-adversarial.json`, `probe-enumeration.json`,
`probe-signup-verify.json` and their `.log` companions.

## 1. What I verified myself, and how

| Property | Method | Result |
|---|---|---|
| Documents are encrypted at rest | Wrote two files through the real upload endpoint, then read the bytes off disk | `721`-byte blobs, magic `TKME`, **no** `%PDF`, **no** plaintext marker |
| A plaintext upload is impossible | POSTed `%PDF-1.4 …` to the client upload route | `400`, nothing stored |
| A forged envelope is refused | POSTed `TKME` + 400 junk bytes | `400` |
| An item from another link is refused | POSTed to a random item UUID on a valid token | `404` |
| Path traversal is impossible | `/assets/..%2F..%2Fpackage.json`, `%2e%2e%2f`, `/assets/../src/db.js` | all `404`; only allow-listed assets served |
| Link tokens are not stored in the clear | Full scan of all 21 tables × all columns for a live 43-char token | **no match anywhere** |
| Session flags | Inspected `Set-Cookie` on sign-in | `HttpOnly; SameSite=Lax; Secure; Max-Age=1209600` |
| Practice data is unreachable unauthenticated | 7 routes, cookie cleared | all `303 → /signin` |
| IDOR across records | 5 guessed-UUID addresses as a signed-in owner | all `404` |
| Credential guessing is bounded | 13 wrong passwords | `401`×10 then `429`, `429`, `429` (blocked at 11) |
| Sign-up cannot enumerate accounts | Taken vs free address, nonce-stripped bodies compared | identical except the address the user typed |
| Sign-up verify cannot take over an account | Opened the verify link issued for a *taken* address | no session minted, no practice/member created, owner's password unchanged |
| Security headers on every page | `GET /` and `/healthz` | CSP with per-response nonce; `X-Frame-Options: DENY`; `nosniff`; `no-referrer`; COOP `same-origin` |
| Secrets are not logged | Read `src/log.js`; inspected log output | `/r/`, `/invite/`, `/reset/`, `/verify/` segments redacted; secret query params redacted; key-name filter |

**No confirmed Critical or High finding exists in this checkout.** The findings below are residual risks, accepted
trades and assurance gaps.

## 2. Findings

### S-01 — CSRF rests entirely on `SameSite=Lax` · **Medium** · Confidence: Confirmed

| | |
|---|---|
| **Area** | Session / request integrity — all state-changing POSTs |
| **Evidence** | No CSRF token anywhere (no `csrf` match in `src/`); no `Origin`/`Referer` check (`src/http.js`, no matches); rationale at `docs/security.md:227-230` |
| **Failure path** | `SameSite=Lax` blocks cross-*site* cookie-bearing POSTs. It does not distinguish same-*site* origins (a sibling subdomain), and it is a browser behaviour rather than a server check. Any future GET route that mutates state would be entirely unprotected — the defence is a property of the method, and nothing enforces the method. |
| **Impact** | Integrity: an attacker able to run script on a same-site origin, or to reach a user on an old/non-conforming browser, could trigger a state change (create a request, revoke a link, remove a member). |
| **Current mitigation** | `SameSite=Lax`, `HttpOnly`, `Secure`; every mutating route is POST; no GET route changes material state (one writes an audit line). |
| **Required fix** | In the dispatcher, for `POST`: if `Origin` is present and does not equal the derived origin, answer `403`. ~15 lines in `src/app.js` beside the role check. Optionally also reject `Sec-Fetch-Site: cross-site`. |
| **Verification** | New test posting with `Origin: https://evil.example` → expect `403`; posting without `Origin` → unchanged; full suite still green. |

### S-02 — A practice can attach a plaintext file to an outbound email, with no warning that it leaves encryption · **Medium** · Confidence: Confirmed

| | |
|---|---|
| **Area** | Data custody at the human boundary — request/reminder sending |
| **Evidence** | `src/request-actions.js:483` and `:631` build `attachment` from the posted form; `:590` is the label: *"Attach a file (optional — a template, a letter, a spreadsheet. It goes out with this message and is not kept anywhere.)"* |
| **Failure path** | A practice decrypts a client's bank statement, then attaches that PDF to a reminder "so they can see what we already have". The file now transits the server process and the SMTP relay in the clear and lands in the client's inbox — outside every guarantee the product makes. Nothing in the UI says so. |
| **Impact** | Confidentiality: the zero-knowledge property is defeated by a normal-looking action, and by the *practice* rather than an attacker. |
| **Current mitigation** | The copy steers to templates/letters; the file is never persisted server-side (genuinely true); SMTP uses STARTTLS or implicit TLS. |
| **Required fix** | Extend that label: *"This is not encrypted by Tickmark and it will exist in the recipient's mailbox. Do not attach a client's document here — send those through the request."* |
| **Verification** | Render the request/reminder page and assert the sentence is present. |

### S-03 — `/healthz` discloses version and practice count to anyone · **Low** · Confidence: Confirmed

| | |
|---|---|
| **Evidence** | Live: `{"ok":true,"version":"0.2.0","practices":2}`; documented at `docs/security.md:239` |
| **Failure path** | Exact-version fingerprinting → known-issue targeting. In hosted mode the practice count is commercially sensitive. |
| **Impact** | Confidentiality (low). No effect on documents. |
| **Current mitigation** | No names, no client data. |
| **Required fix** | In `MULTI_TENANT=1`, return `{"ok":true}` only. |
| **Verification** | Start hosted mode, assert the body has no `version`/`practices` keys. |

### S-04 — Xero/QuickBooks OAuth tokens are stored readable; import reads client names and emails · **Medium (accepted)** · Confidence: Confirmed

| | |
|---|---|
| **Evidence** | `docs/security.md:34-37` states the trade; `connection` table; `src/tenancy/xero.js`, `quickbooks.js` |
| **Failure path** | Server compromise or a stolen database yields live read-scoped OAuth tokens plus the client book. |
| **Impact** | Confidentiality: metadata (client names/emails) and read access to the practice's *client list* at the provider. Never documents, never transactions. |
| **Current mitigation** | Read scopes only; tokens refreshed only while a request is in flight; connection revocable; documented. |
| **Required fix** | None required. If hardening: encrypt tokens at rest under a key held in the environment. |
| **Verification** | Out of scope here (no provider credentials available). |

### S-05 — The server cannot detect malicious files, and never could · **Medium (inherent)** · Confidence: Confirmed

| | |
|---|---|
| **Evidence** | Documented as F-11 in `docs/phase-5-launch-qualification.md`; `src/blobs.js` reads only the header; downloads served as `content-type: application/octet-stream` (`src/request-actions.js:133`) |
| **Failure path** | A client — or whoever holds a forwarded link — uploads a malicious `.exe` renamed `statement.pdf`. Antivirus cannot be applied; the practice downloads and opens it. |
| **Impact** | Integrity/availability of the *practice's* machine. Note the direction: this is a risk to the receiving practice, not a way to read another client's documents. |
| **Current mitigation** | Uploads are ciphertext so the server never holds a scannable file; the raw envelope is always served as `application/octet-stream` with `nosniff`; only the practice's browser decrypts it. Browser-side preflight flags structural problems, not malice. |
| **Required fix** | No code fix exists without abandoning the design. **Do**: say it on the client page and in the review copy ("a file may be anything the sender chose — open what you expect, from whom you expect"). |
| **Verification** | Copy assertion; operational documentation. |

### S-06 — A weak passphrase is offline-attackable; PBKDF2 is the only defence · **Medium (accepted)** · Confidence: Confirmed

| | |
|---|---|
| **Evidence** | `web/tickmark-crypto.js:48` — `KDF = { hash: 'SHA-256', iterations: 600000, saltBytes: 16 }`; limit stated in `SECURITY.md:43-44` and `docs/encryption.md` |
| **Failure path** | Whoever obtains the database gets the wrapped private keys. With a 6-character passphrase, 600k PBKDF2 rounds is hours, not years. |
| **Impact** | Confidentiality of *every* document in the practice. |
| **Current mitigation** | 600,000 rounds; 16-byte salt; **no verification token stored** (so no cheaper oracle); `MIN_PASSPHRASE = 12`. Web Crypto offers no Argon2/scrypt, and the author explains refusing to ship a hand-rolled KDF. |
| **Required fix** | Confirm `MIN_PASSPHRASE = 12` blocks submission rather than merely warning. |
| **Verification** | Attempt a 5-character passphrase at `/setup`; expect refusal. |

### S-07 — A lost passphrase destroys the documents · **Accepted** · Confidence: Confirmed

The product's stated position (`SECURITY.md:45`). Mitigated by a **recovery sheet**: `POST /keys/:id/recovery-sheet`
seals a copy of the key under a printed secret, and `/keys/:id/recover` restores from it. A real, thoughtful
mitigation — but it depends on the practice printing and storing paper, which no product can guarantee.

### S-08 — Anyone holding a client link can upload · **Accepted** · Confidence: Confirmed

Bearer-capability design, stated plainly on the client page ("Keep this private link safe") and in `SECURITY.md:51`.
Mitigations: 256-bit entropy, expiry, revocation, per-link byte and file-count ceilings, and the practice must still
*check* what arrives. Correct for the use case; not a defect.

### S-09 — No `ON DELETE` clauses; referential integrity is application-managed · **Low** · Confidence: Confirmed

| | |
|---|---|
| **Evidence** | `PRAGMA foreign_keys = ON` (`src/db.js:899`) and 40 `REFERENCES` declarations, but **zero** `ON DELETE` clauses; only 2 `CHECK` constraints |
| **Failure path** | A crash between deleting a request row and its blob files leaves orphans; a crash between writing a blob and its row leaves an unreferenced file. |
| **Impact** | Availability/storage: disk slowly fills with unreferenced ciphertext; a restore may carry phantom files. No confidentiality impact (orphans are ciphertext). |
| **Current mitigation** | Explicit deletion in `src/store.js`; `src/tenancy/reconcile-uploads.js` and `tools/reconcile-uploads.mjs` exist for exactly this; `test/reconcile-uploads.test.js` covers it; `restore-tombstones.js` prevents resurrecting deleted practices. |
| **Required fix** | None urgent. Consider `ON DELETE CASCADE` on leaf tables (`upload`, `request_item`, `key_wrapping`, `session`), and schedule `reconcile-uploads` in `ops/`. |
| **Verification** | Delete a request, assert no `upload` row and no blob remain. |

### S-10 — No HSTS from the application · **Low (by design)** · Confidence: Confirmed

Deliberate and reasoned at `src/views.js:346-349` and `docs/operations.md:222-232`. **Consequence to state clearly:**
a self-hosted install deployed *without* a proxy has no HSTS. That must stay in the operator checklist (it is), and is
worth restating in beta onboarding.

### S-11 — Assurance gap: the least-tested code is the encryption path · **Medium** · Confidence: Confirmed

| | |
|---|---|
| **Evidence** | On Node 26.5.0: `web/upload.js` 78.28% lines / 41.94% branches; `web/download.js` 65.46% / 31.58%; `web/invite.js` 52.63%; `web/keys.js` 76.67%; `web/setup.js` 79.10% |
| **Failure path** | A regression that encrypts to the wrong key, or writes plaintext on one code path, could sit in an untested branch. The *end-to-end* property is tested (`test/stack.test.js` uploads over HTTP and requires the document not to appear on disk), which is the important protection; the untested parts are error and edge branches. |
| **Impact** | Integrity of the central claim under conditions the tests do not rehearse. |
| **Current mitigation** | End-to-end tests over the real endpoint; `test/crypto.test.js`; `test/browser-keys.test.js`; refusal tests for plaintext and forged envelopes. |
| **Required fix** | Raise branch coverage on `web/upload.js` and `web/download.js` — failure mid-upload, quota refusal, cancelled download, wrong passphrase, re-encrypted file. |
| **Verification** | `npm run coverage` exits 0 with a raised branches floor. |

## 3. Common application vulnerability assessment

| Class | Verdict | Basis |
|---|---|---|
| SQL injection | **Not present** | All statements are static strings with bound parameters. The only interpolation is a table name passed as a parameter to `pragma_table_info` from a hard-coded list (`src/db.js`). |
| Cross-site scripting | **Not present (found)** | The `html` tag escapes by default; `raw()` is used for literal script tags and boolean attributes, each justifiable. CSP is `default-src 'none'` with a per-response nonce, so an injected inline script would not execute. |
| CSRF | **Partial** — S-01 | `SameSite=Lax` only |
| Path traversal | **Not present** | The asset route resolves a name against an allow-list *before* joining; upload paths are generated ids. Confirmed by probe (all traversal attempts `404`). |
| IDOR / broken object-level auth | **Not present (found)** | Every lookup is scoped by `practiceId`; 5 guessed-UUID probes returned `404`. |
| Authentication bypass | **Not present (found)** | The second factor is demanded *before* a session exists (`test/security.test.js:144`); the challenge is bounded to <10 guesses. |
| Privilege escalation | **Not present (found)** | Roles are declared on the route and enforced centrally at `src/app.js:500`; a test walks the table and fails if a sensitive address lacks a role (`test/roles.test.js`). |
| Insecure deserialisation | **Not applicable** | No serialiser; JSON is parsed with `JSON.parse`. The ZIP is a hand-written *reader* used only for export. |
| SSRF | **Low** | Outbound requests go only to operator-configured SMTP/SMS/provider endpoints, never to user-supplied URLs. The Xero callback state is verified before any exchange ("a forged callback is refused"). |
| Command injection | **Not present** | No shell invocation in `src/`; operator tools `spawn` with argument arrays. |
| Dependency vulnerabilities | **None possible** | Zero dependencies. |
| Sensitive-data logging | **Not present (found)** | `src/log.js` redacts bearer path segments and secret query parameters by name and by pattern. |
| Missing security headers | **Mostly present** | CSP w/ nonce, `nosniff`, `DENY`, `no-referrer`, COOP. **Absent by design:** HSTS (proxy responsibility); no `Permissions-Policy` (harmless — `default-src 'none'` already denies most capabilities). |
| Misconfigured CORS | **Not applicable** | No CORS headers are emitted, so no cross-origin reading is possible. |
| Unsafe production defaults | **Mostly safe** | Secure cookies on by default; upload/mail/TLS fail closed. The one soft default is a verbose `/healthz` (S-03). |
| Session fixation | **Not present (found)** | A fresh token is minted at sign-in and the pre-auth challenge cookie is cleared. |
| Brute force | **Bounded (found)** | Per-account limiter; `429` observed at attempt 11. Per-account bucketing is the right choice behind a proxy. |

## 4. Operational protection

| Control | State |
|---|---|
| Audit log | **Yes** — an `event` table with a human-readable detail per row, plus JSON operational lines on stdout |
| Log retention | **Operator's** — the app does not rotate; `docs/operations.md` covers the proxy log and one-line events |
| Backup | **Yes** — `tools/backup.mjs` (`VACUUM INTO`) + `--verify` that checks every named document is present |
| Restore | **Procedure, drilled in tests** (`test/backup.test.js` decrypts a document out of a restored copy) |
| Reconciliation | **Yes** — `reconcile-uploads`, `restore-tombstones`, `hosted-maintenance` |
| Key rotation | **Yes** — new key, re-encrypt files, retire the old key; envelopes need no format change |
| Disaster recovery | **Single-tenant: documented and drilled. Hosted: exercised against a *fake* Restic transport** — a real remote repository is unproven |
| Production secrets | Environment variables only; no secret in the tree; `.env` is git-ignored |
| Monitoring | `/healthz` pokes the database (not just the port); JSON logs are alertable (`request.failed`) |
| Rate limiting | **Yes**, but **only** on sign-in/sign-up and the client upload path — not a general DoS defence |
| DoS resilience | **Partial** — per-link byte/file ceilings and a free-disk floor (512 MiB) protect the *install*; there is no request-rate limiter in front of anonymous client routes beyond the upload ceilings |
| Tenant deletion | **Yes** — offboarding + tombstones; verified not to resurrect on restore |
| Data portability | **Yes** — CSV exports; per-tenant ciphertext-preserving export (`tools/export-tenant.mjs`) |

## 5. Privacy and GDPR-adjacent position

| Question | Answer |
|---|---|
| Who is the controller? | The **practice**, for its clients' documents. The **operator** (if hosted) is a processor — and for a self-hosted install the practice is both. The architecture makes this easy to state because the operator cannot read the documents. |
| Is special-category / financial data involved? | Yes — bank statements, tax returns, ID scans. The zero-knowledge design is the product's actual answer, and a strong one. |
| Data subject access / erasure | **Achievable, not self-serve.** The practice can export CSV and download files; erasure is a documented operator procedure, not a button a client can press. Under GDPR that needs a written process rather than code. |
| Self-serve export for a *customer* leaving | **Absent.** `docs/phase-5-launch-qualification.md` records it honestly: *"Phase 4 found no billing-wall self-serve export."* For paid hosting this is a real gap — a leaving customer must ask the operator. |
| Retention enforcement | Configurable grace periods (`TICKMARK_DELETION_GRACE_DAYS`, `TICKMARK_PENDING_RETENTION_DAYS`), but retention is **operator-scheduled**, not automatic. `ops/*.timer` units exist but must be installed. |
| Legal documents | Drafts only, with operator placeholders explicitly unfilled (`docs/hosted-legal-drafts.md`). **Correctly not invented.** |
| Sub-processors | SMTP relay, SMS gateway, Xero/Intuit, Stripe — all optional, all must be listed in a real privacy notice before hosted launch. |

**Privacy verdict:** the *technical* posture is excellent — genuinely zero-knowledge documents, minimal collection, no
analytics, no third-party scripts, no fonts from a CDN, no `localStorage`. The *procedural* posture (DSAR workflow,
self-serve export, retention automation, published notice) is **not yet fit for a paid hosted service**, and the author
says so rather than implying otherwise.

## 6. Summary of severity

| Severity | Count | Items |
|---|---|---|
| Critical | **0** | — |
| High | **0** | — |
| Medium | 5 | S-01 CSRF, S-02 plaintext attachment, S-04 integration tokens, S-06 passphrase strength, S-11 encryption-path coverage |
| Medium (inherent/accepted) | 1 | S-05 no malware scanning |
| Low | 3 | S-03 verbose health, S-09 no cascade, S-10 no HSTS from app |
| Accepted by design | 2 | S-07 lost passphrase, S-08 link bearer capability |

The distribution is the finding: **this product has no security problems of the kind that would stop a pilot, and
several of the kind that would stop a hosted launch** (procedural privacy, real-provider validation, CSRF depth).

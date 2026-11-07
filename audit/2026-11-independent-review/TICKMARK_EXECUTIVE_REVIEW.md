# Tickmark — Independent Executive Review

**Audit date:** 7 November 2026
**Audited commit:** `6ff16ff` on `main` (`origin/main`), 109 commits, 17 Sep 2026 – 22 Oct 2026
**Auditor role:** independent principal engineer / application security reviewer / product strategist
**Mode:** read-only. No product code, schema, credential or external service was changed.

---

## 1. What Tickmark is today

Tickmark is a **self-hostable document-collection tool for accounting and bookkeeping practices**. A practice
builds a checklist of what it needs from a client, issues one link, and the client uploads against that list with
**no account, no app and no sign-up**. Files are encrypted **in the client's browser** to an ECDH P-256 key the
practice holds, so the server stores ciphertext it cannot open. The practice then reviews each arrival (checked /
needs attention / stop asking), chases, records contact, and carries the list forward next year.

That is not a description of intent. It is running software, verified below.

This is not a prototype. It is a **complete, working, unusually disciplined single-tenant application** with a
second, optional multi-tenant hosting layer, 48 server/browser modules, 90 test files and **zero third-party
runtime dependencies**.

## 2. Strongest qualities

1. **The central security claim is real and independently reproduced.** I uploaded through the live HTTP endpoint,
   read the bytes back off disk, and got `TKME` envelopes containing no `%PDF` magic and no plaintext marker. A
   plaintext upload was refused with `400`. See `SECURITY_AND_PRIVACY_REVIEW.md` §2.
2. **Zero dependency tree.** `"dependencies": {}`, `"devDependencies": {}`, no lockfile, no `node_modules`. Only
   `node:*` builtins. There is no supply chain to audit — a genuine, verifiable advantage for software holding
   other people's financial records.
3. **Authorisation is a query scope, not a check beside one.** Every handler receives `practiceId` and looks records
   up *through* it. My IDOR probes against requests, edits, files, clients and templates all returned `404`.
4. **The role model is cryptographic, not a policy.** An `assistant` cannot read documents because key wrappings are
   per-member (`key_wrapping.practitioner_id`), not because the UI hides a link. A competitor cannot copy that
   without giving up their architecture.
5. **Test suite actually passes.** 563 tests, 563 pass, 0 fail, 0 skipped, 76 s. Not a claim in a document.
6. **The client experience is genuinely excellent** and the copy is honest — including a trust panel that states
   what the server *can* still see (filename, item, arrival time).
7. **Operational honesty.** `docs/security.md`, `docs/encryption.md` and `docs/phase-5-launch-qualification.md`
   list their own gaps, including the coverage gate failure I independently reproduced.
8. **It was verified in a real browser, not just read.** A practice was seeded into four states and driven through
   BrowserOS neo over MCP: sign-in through the form, the board, the request page, the client checklist at 390 px, a
   client receipt, and an invalid link. Fifteen screenshots are in the evidence directory. Doing this **overturned two
   of my own earlier claims** and found a defect that markup alone had hidden (see §3).

## 3. Biggest weaknesses

1. **It has never been used for real.** No production deployment, no real Stripe transaction, no real remote
   backup, no human tester. The author says so; my inspection agrees. This is the dominant risk, and it is a
   *validation* risk rather than an engineering one.
2. **The project's own quality gate fails.** `npm run coverage` exits `1` (91.57% lines / 88.86% functions /
   74.65% branches vs a 93/90/75 floor). CI runs this job, so `main` should be red today.
3. **The least-covered code is the most security-critical.** `web/upload.js` 78.3% lines, `web/download.js` 65.5%,
   `web/invite.js` 52.6% — the browser paths that carry the encryption promise.
4. **The document table clips its review controls mid-word below ~44rem.** On the request page — the screen a practice
   lives in — the buttons that review a document render as `Che…`, `Nee…`, `Stop…` at ordinary laptop widths, with no
   visible hint that the region scrolls. Seen in the browser, invisible in the markup (B-02).
5. **CSRF rests on `SameSite=Lax` alone** — no token, no `Origin` check. Defensible, but thinner than the rest.
6. **Two unmerged branches and a stash** hold work not in `main` (`codex/tickmark-interactive-demo`, +2 commits).
7. **A copy bug sits on the busiest screen**: a section headed "The file itself" that actually contains *Close this
   request* and *Do this again* (`src/board-views.js:1136`) — B-01.
8. **Green visual identity is competent but not distinctive** — it reads "friendly small-business", not
   "professional services precision".

## 4. Confirmed architecture

| Layer | Fact |
|---|---|
| Runtime | Node ≥ 24 (`node:sqlite`, `node:crypto`, `node:http`) |
| Server | `node:http` + a 120-route table (`src/app.js`), no framework |
| Database | **SQLite** via `node:sqlite`; WAL, `foreign_keys=ON`, `busy_timeout=5000` |
| Hosted DB | One SQLite file **per practice** under `tenants/<uuid>/`, plus a registry file |
| Files | Encrypted envelopes in `blobs/<requestId>/<uploadId>.bin` |
| Crypto (documents) | Browser: ECDH P-256 → HKDF-SHA-256 → AES-256-GCM, 83-byte header as AAD |
| Crypto (keys) | Private key wrapped by PBKDF2-SHA-256 (600k rounds) + AES-GCM |
| Crypto (passwords) | scrypt `N=2^16, r=8, p=1` |
| Mail / SMS | Optional SMTP / gateway relays, hand-written protocol code |
| Deployment | One container, one volume, read-only rootfs, non-root user |

## 5. Supabase verdict — **NO**

**Tickmark does not use Supabase.** It does not use PostgreSQL, MySQL, MongoDB or any hosted database.

The single occurrence of "Supabase" in the tree is `docs/saas.md` §1, which audits **Plain Forms** — a *different*
project in the same workspace — as a design contrast to Tickmark's own tenancy model. There is no Supabase client,
no SDK, no connection string, no environment variable and no URL anywhere in `src/`, `web/`, `tools/` or `test/`.

`package.json` has **no dependencies at all**. The database is a local SQLite file. The owner's belief is correct.

## 6. Security assessment

**Substantially stronger than typical for a solo, pre-launch product, and honest about its edges.**

Verified live: per-response-nonce CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP; session cookies
`HttpOnly; SameSite=Lax; Secure`; link tokens stored only as SHA-256 digests (a full-database scan for a live token
found **no** column containing it); login limited per account (429 on the 11th attempt); sign-up enumeration-
resistant (identical bodies) and takeover-safe (the verify link on a taken address creates nothing and mints no
session); IDOR, path traversal and forged-envelope probes all refused.

Accepted limits, all documented and reasoned: operator sees metadata; weak passphrase is offline-attackable; a lost
passphrase loses the documents; the server cannot scan ciphertext for malware; a compromised browser reads
everything. I found **no confirmed critical or high-severity vulnerability** in the current checkout.

## 7. Product-quality assessment

The **practice workflow is complete**: client records, requests, reusable templates, bulk ask, due dates,
duplication, carry-forward, editing, email delivery, reminders with a cadence, contact logging, per-item review with
reasons, replacement and resubmission, search, CSV export, Xero/QuickBooks import, audit history, close/reopen,
retention and export.

The **client workflow is complete and better than most competitors**: no account, phone-camera uploads, per-item
status, "I will send this later" / "I do not have this", send-an-extra-document, send-a-message, returning to the
same link, and browser-side preflight warnings for cut-off PDFs and unreadable photos.

**Critical question — can a small practice complete its primary document-collection workflow today?**
**Yes.** I did it end-to-end in one command: sign-up, email verification, key creation, member invitation, request
creation, link issue, two encrypted client uploads, and review. No blocker. The caveats are operational (email needs
a relay; the passphrase cannot be recovered), not functional.

## 8. Commercial potential

**Real, narrow, and unproven.** The differentiators are genuine and hard to copy: zero-knowledge storage,
self-hosting for data residency, accounting-software import, and a per-member key model. The market is anchored by
**Content Snare at $35 USD/month** (2 users, 20 requests) — so Tickmark's documented £49/month hosted sits *above*
the cheapest credible incumbent, which is a positioning problem, not a feature problem.

The strongest commercial wedge is **self-hosted**: ProjectSend proves the niche (4,000+ active installs, GPL v2,
self-hosted since 2011) and offers **no encryption at rest** and no checklist-driven collection. Nobody occupies
"self-hosted, zero-knowledge, built for accountants" today.

But there is no evidence yet that anyone will pay. No pilot, no interview log with a commitment, no invoice.

## 9. Top twelve improvements

| # | Improvement | Why now | Priority |
|---|---|---|---|
| 1 | Make `npm run coverage` pass (or reset the floor with a written reason) and raise coverage on `web/upload.js`, `web/download.js` | The project's own gate is red | P0 |
| 2 | Add an `Origin`/`Sec-Fetch-Site` check on state-changing POSTs | Close the thinnest layer cheaply | P0 |
| 3 | Run one real practice through one real season on a throwaway host | Every remaining unknown is empirical | P0 |
| 4 | Stop the request page's document table clipping its review buttons (B-02) | The review controls are the point of the screen, and they look broken at ordinary widths | P1 |
| 5 | Rename the "The file itself" section (B-01) | One line, on the busiest screen in the product | P1 |
| 6 | Reconcile or discard `codex/tickmark-interactive-demo` and `stash@{0}` | Unreviewed work decays | P1 |
| 7 | Define and record the backup/restore drill against a real proxy and real TLS | Recovery is asserted, not exercised | P1 |
| 8 | Explicitly warn that an email attachment leaves the encryption model | Prevents a practice defeating the promise by hand | P1 |
| 9 | Custom upload affordance instead of native `<input type="file">` chrome | Trust-reducing on the client's phone | P2 |
| 10 | Choose a distinctive palette (ink/cobalt or plum/stone) | Green reads agricultural, as the owner suspected | P2 |
| 11 | Signed engagement letter / simple signature capture | The one universally named gap | P2 |
| 12 | Publish a self-hosted quickstart + a one-page "what we cannot protect" page | Converts the moat into adoption | P3 |

## 10. Immediate recommendation

**Do not build another feature yet.** Run a **private, three-practice beta on a throwaway host** using fictional-then-
real documents, with the coverage gate fixed and the `Origin` check added first. Everything that remains unknown
about Tickmark is empirical — whether practitioners finish onboarding, whether clients upload from a phone, whether
chasing actually reduces the chase — and no amount of further engineering resolves it.

Continue reading: [Architecture](ARCHITECTURE_AND_DATA_CUSTODY.md) ·
[Features](FEATURE_AND_WORKFLOW_AUDIT.md) · [Security](SECURITY_AND_PRIVACY_REVIEW.md) ·
[UI/UX](UI_UX_ACCESSIBILITY_REVIEW.md) · [Browser verification](BROWSER_VERIFICATION.md) ·
[Engineering](ENGINEERING_AND_TEST_REPORT.md) · [Market](MARKET_AND_POSITIONING.md) ·
[Roadmap](PRIORITISED_ROADMAP.md) · [Evidence](AUDIT_EVIDENCE_MANIFEST.md)

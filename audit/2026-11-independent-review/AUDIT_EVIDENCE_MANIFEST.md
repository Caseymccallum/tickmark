# Audit Evidence Manifest

## 1. Repository identity

| Fact | Value |
|---|---|
| Canonical path | `C:\Users\Casey\Web Apps\Tickmark` |
| GitHub remote | `origin` → `https://github.com/Caseymccallum/tickmark.git` (fetch + push) |
| Branch | `main` (tracking `origin/main`) |
| HEAD commit | `6ff16ff9bcc9781808363e7cf772382e846e9cb1` |
| HEAD subject / date | "Document independent visual review evidence" · 2026-10-22 14:39:14 +0100 |
| Commit count | 109 (2026-09-17 → 2026-10-22; 75 in September, 34 in October) |
| Tag | `v0.2.0` (the only tag) |
| Package version | `0.2.0` |
| Licence | AGPL-3.0-or-later |
| Runtime used | Node **v26.5.0**, npm **11.17.0**, Windows |

### Branches and pending work

| Ref | State |
|---|---|
| `origin/main` = `main` | 34 commits **ahead** of `codex/tickmark-commercial-audit`, 2 ahead of nothing else |
| `origin/codex/tickmark-commercial-audit` | 34 behind, 1 ahead (a docs-only commit: "docs: add Tickmark commercial readiness audit") |
| `origin/codex/tickmark-interactive-demo` | **2 commits not in `main`**: `a3109ab` "Add isolated interactive synthetic demo", `228eb71` "Gate public interactive demo CTA" |
| `stash@{0}` | "On codex/tickmark-commercial-audit: Preserve pre-existing docs/go-succeed-prep.md edit before Tickmark worktree cleanup" |

### Working-tree state before the audit

Only one untracked directory: `review/` — a prior review (`review/rediscovery-2026-11-07/`) recorded earlier the same
day. **It was not modified or overwritten by this audit**, which writes to a new `audit/` directory.

### Working-tree state after the audit

```
$ git status --porcelain
?? audit/
?? review/
$ git diff --stat          (no output — no tracked file changed)
$ git rev-parse HEAD
6ff16ff9bcc9781808363e7cf772382e846e9cb1
```

**No product code, schema, configuration, credential or external service was modified.** Nothing was committed,
pushed, merged or deployed.

## 2. Read-only guarantees observed

- No product source file created, edited or deleted.
- No database schema change; no destructive database operation; no user data deleted.
- No credentials rotated; no external service setting changed.
- No branch created, merged, or pushed.
- No package installed; no infrastructure provisioned.
- No test modified, skipped or deleted.
- All audit output written under `audit/2026-11-independent-review/`, separate from product code.
- All external HTTP probes targeted an in-process server bound to `127.0.0.1` with an ephemeral port, holding
  **fictional** data (`owner@fictional.tickmark.invalid`, `FICTIONAL — Example Practice`).

## 3. Commands executed and results

| # | Command | Result | Evidence file |
|---|---|---|---|
| 1 | `git rev-parse HEAD`, `git remote -v`, `git status`, `git log`, `git branch -a`, `git stash list` | identity captured | §1 above |
| 2 | `node --version` / `npm --version` | v26.5.0 / 11.17.0 | §1 |
| 3 | `node --test "test/*.test.js"` | **exit 0** — 563 tests, 563 pass, 0 fail, 0 skipped, 75 995 ms | `evidence/tests-full.log` |
| 4 | `node --test --experimental-test-coverage --test-coverage-lines=93 --test-coverage-functions=90 --test-coverage-branches=75 "test/*.test.js"` | **exit 1** — 91.57 / 74.65 / 88.86 | `evidence/coverage.log` |
| 5 | `node tools/check-style.mjs` | exit 0 (includes WCAG contrast) | `evidence/check-style.log` |
| 6 | `node tools/check-docs.mjs` | exit 0 | `evidence/check-docs.log` |
| 7 | `node tools/check-nav.mjs` | exit 0 | `evidence/check-nav.log` |
| 8 | `node tools/find-unused.mjs` | exit 0 | `evidence/find-unused.log` |
| 9 | `node tools/snapshot.mjs` | exit 0 | `evidence/snapshot.log` |
| 10 | `node tools/check-pages.mjs` | exit 0 — "all 42 pages look structurally sound" | `evidence/check-pages.log` |
| 11 | `node tools/check-site.mjs` | exit 0 | `evidence/check-site.log` |
| 12 | `node tools/demo-synthetic.mjs audit/.../evidence/scratch` | **exit 0** — full journey, incl. 2 encrypted uploads | `evidence/demo-synthetic.log` |
| 13 | `node evidence/probe-live.mjs` | exit 0 — headers, pages, IDOR, traversal, blob inspection | `evidence/probe-live.json`, `.log` |
| 14 | `node evidence/probe-adversarial.mjs` | exit 0 — unauthenticated reach, IDOR, traversal, link abuse, upload refusals, rate limit | `evidence/probe-adversarial.json`, `.log` |
| 15 | `node evidence/probe-enumeration.mjs` | exit 0 — sign-up/sign-in enumeration comparison | `evidence/probe-enumeration.json`, `.log` |
| 16 | `node evidence/probe-signup-verify.mjs` | exit 0 — verify-link takeover test | `evidence/probe-signup-verify.json`, `.log` |
| 17 | `node tools/bench.mjs` (default scale) | exit 0 — 11 ms median board | `evidence/bench.log` |
| 18 | `node tools/bench.mjs 500` | exit 0 — 500 clients / 2 000 documents: 22 ms median board | `evidence/bench-500.log` |

### Commands deliberately **not** run

| Command | Why |
|---|---|
| `docker compose up` / `check:container` | Docker not exercised in this environment; the container job is CI's job. No claim of container verification is made |
| `npm run check:gateway` / `preview:gateway` | Renders hosted signup states; would have been additive. Not run, so no hosted-UI claim is made |
| `npm run drill:stripe`, `reconcile:stripe` | Requires a Stripe account and test-mode keys — explicitly out of scope |
| `npm run backup*`, `restore*` | Runner-safe but would have written outside `audit/`; the behaviours are already covered by the passing suite and by `docs/operations.md`. Not re-executed, so no independent backup claim is made beyond reading the code and tests |
| Any real SMTP/SMS/Xero/QuickBooks call | No credentials; would require registration |

## 3b. Browser phase (BrowserOS neo over MCP)

Added after the first pass, at the owner's request, to replace "no browser is accessible" with a real browser.

### Configuration change

| | |
|---|---|
| File edited | `C:\Users\Casey\.cline\data\settings\cline_mcp_settings.json` |
| Backup written | `cline_mcp_settings.json.backup-2026-11-07T19-04-26-597Z` (same directory) |
| Server added | `browseros-neo` — `transport: { type: "streamableHttp", url: "http://127.0.0.1:9010/mcp" }` |
| Existing servers | Untouched: `proxima` (50 auto-approved tools), `supabase-db` (env preserved), `gitnexus` |
| autoApprove | 15 **read-only/visual** tools only (`name_session`, `tabs`, `tab_groups`, `windows`, `browser_profiles`, `browser_target`, `history`, `navigate`, `snapshot`, `diff`, `read`, `grep`, `screenshot`, `pdf`, `wait`). `act`, `run`, `evaluate_in_page`, `download`, `upload`, `credentials`, `payment_cards`, `request_human_help` still require approval |
| Schema verified against | `saoudrizwan.claude-dev-4.1.26` → `dist/extension.js`: `transport` is a discriminated union on `type` with literals `"stdio"`, `"sse"`, `"streamableHttp"`. **Cline's public docs show a flat `type`/`url` shape and `rooveterinaryinc.roo-cline-3.54.0` expects `"streamable-http"` with a hyphen** — both would silently fail here |

### Endpoint verification

| Check | Result |
|---|---|
| Port 9010 listening | Yes (pid 2876) |
| `initialize` (protocol 2025-06-18) over streamable HTTP | `200`, `text/event-stream`, `mcp-session-id` returned |
| `serverInfo` | `browseros-neo` v0.0.92 |
| `tools/list` | **27 tools** enumerated |
| Sign-in form driven through the real UI (`act` fill + click) | `303 → /requests`; confirmed by reading the page |
| Screenshot capture | **84–104 ms** in a dedicated window; **~61 s** for a backgrounded tab in the shared window |

### Commands / drivers added

| Item | Purpose | Evidence |
|---|---|---|
| `evidence/seed-board.mjs` | Seeded a practice into four states over the real HTTP routes | `evidence/capture.log` |
| `evidence/close-duplicate.mjs` | Closed my own duplicate seeded request via the product's own action (no DELETE) | `evidence/capture.log` |
| MCP client + capture drivers (`%TEMP%\neo-client.mjs`, `neo-capture.mjs`, `neo-*.mjs`) | Handshake, tab/window control, login, screenshots | logs kept in `%TEMP%`; images copied into `evidence/screens/` |
| Local instance | `node src/server.js` on **port 3010**, `TICKMARK_DATA`/`TICKMARK_BLOBS` → the audit scratch dir | `evidence/server.out.log` |

### Screenshots

`evidence/screens/` — 15 captures. Index in [BROWSER_VERIFICATION.md](BROWSER_VERIFICATION.md) §4.
Wide (1282×741): `01b-board-wide.jpg`. Narrow (~575–730 px): board, request detail, chase, clients. Mobile (390 px):
request detail, client checklist ×2, client receipt, invalid link, sign-in.

### What this phase found

Five new findings (B-01…B-05), **two withdrawn claims** (A1 horizontal overflow; my own "account pages unreachable"
hypothesis), and eight earlier assertions upgraded from "structural" to "observed". See
[BROWSER_VERIFICATION.md](BROWSER_VERIFICATION.md) §5–§7.

### Known limits of this phase

Viewport widths are 390 / ~575 / ~730 / 1282 CSS px — **no 1440 px capture** (the roomy window manages 1282 px at
~61 s per shot, and a longer run hung). No screen reader, no real phone, no 2FA/QR capture, plain HTTP only. The
accessibility tree was read, which is evidence about names/roles/live regions but not a screen-reader session.

## 4. Deliverables

| File | Contents |
|---|---|
| `TICKMARK_EXECUTIVE_REVIEW.md` | Overview, strengths, weaknesses, architecture, Supabase verdict, top ten, recommendation |
| `ARCHITECTURE_AND_DATA_CUSTODY.md` | Stack, the 17 questions answered, trust boundaries, lifecycle table, deployment models |
| `FEATURE_AND_WORKFLOW_AUDIT.md` | 70+ feature classifications with evidence; journey findings; the critical question |
| `SECURITY_AND_PRIVACY_REVIEW.md` | Verified properties, 11 findings with severity/exploit/fix/verification, vulnerability matrix, privacy |
| `UI_UX_ACCESSIBILITY_REVIEW.md` | Visual, palette, interaction, WCAG-area assessment, prioritised findings — **from live browser renders** |
| `BROWSER_VERIFICATION.md` | MCP setup, schema trap, capture technique, screenshot index, the 5 new findings and the 2 withdrawn claims |
| `ENGINEERING_AND_TEST_REPORT.md` | Test results, coverage detail, code quality, reliability, measured performance, dependencies |
| `MARKET_AND_POSITIONING.md` | Competitor pricing (cited, dated), differentiation, customer profile, beta plan |
| `PRIORITISED_ROADMAP.md` | P0–P3 with evidence, complexity, risks, acceptance criteria; R1–R4 phases |
| `AUDIT_EVIDENCE_MANIFEST.md` | This file |

### Evidence directory

`audit/2026-11-independent-review/evidence/`

| Kind | Files |
|---|---|
| Test + gate logs | `tests-full.log`, `coverage.log`, `check-style.log`, `check-docs.log`, `check-nav.log`, `find-unused.log`, `snapshot.log`, `check-pages.log`, `check-site.log` |
| Journey log | `demo-synthetic.log` (full workflow with statuses; tokens redacted by the app's own logger) |
| Benchmarks | `bench.log`, `bench-500.log` |
| Live probes (code + JSON + log) | `probe-live.*`, `probe-adversarial.*`, `probe-enumeration.*`, `probe-signup-verify.*` |
| Rendered pages (HTML) | Removed before publication — superseded by the browser screenshots in `screens/` |
| Scratch data | Removed before publication (throwaway SQLite databases and encrypted blobs of a synthetic PDF, regenerable with `npm run demo:synthetic`) |

### Screenshots

Reviewed from the repository (not re-captured — no headless browser is available here):
`docs/visual-review-screenshots/` — practice dashboard desktop + mobile, client checklist desktop + mobile + upload
receipt, hosted sign-up desktop + mobile, marketing desktop + mobile.

## 5. Known verification limitations

Stated plainly, because the value of this audit depends on them:

1. **One Node version only (26.5.0).** CI pins Node 24. The coverage-gate failure (E-01) is measured on 26 and may
   differ on 24. Either way the finding — the gate currently reports failure, and its verdict depends on the runtime
   version — is confirmed.
2. **A real browser was used, but not every surface.** BrowserOS neo over MCP rendered the practice and client
   screens at 390 / ~575 / ~730 / 1282 CSS px and produced 15 screenshots. What is still *not* covered: no screen
   reader, no real iOS/Android device, no 1440 px capture, no 2FA/QR flow. WCAG 2.2 AA **conformance is not claimed**;
   the accessibility tree was read, which is evidence about names, roles and live regions, not a screen-reader session.
3. **No Docker run.** Container behaviour derives from `Dockerfile`, `docker-compose.yml` and CI configuration.
4. **No real SMTP relay, SMS gateway, Xero, QuickBooks or Stripe.** Every integration judgement rests on source, tests
   with local stubs, and the author's documentation. Production provider behaviour is **unverified**.
5. **No real remote backup.** The hosted Restic path is exercised against a fake transport; a real repository restore
   is unproven. Single-tenant `VACUUM INTO` backup/restore is covered by a passing test.
6. **Tenant isolation** was verified by reading the suite's attacks and probing one practice, not by constructing two
   live tenants in hosted mode.
7. **Benchmarks are on one Windows machine.** Indicative, not portable, and stop at 500 clients.
8. **Prior-review duplication.** `review/rediscovery-2026-11-07/` was produced earlier the same day by another pass.
   Where it and this audit overlap they agree (both record 563/563 passing). It was not modified.
9. **Web screenshots come from a local HTTP instance** on port 3010 seeded with fictional data. Two visible artifacts
   are mine, not the product's: a duplicate "Lodge & Co" row (created by a crashed seed run, then closed with the
   product's own action) and one request closed during the session.

## 6. Publication note

This audit is committed to the repository so another agent can read it.

**Scrubbed before publication:**

- `evidence/scratch/`, `scratch2/`, `scratch3/` — disposable SQLite databases and encrypted blobs of a synthetic PDF
  (regenerable with `npm run demo:synthetic`), deleted.
- `evidence/pages/` — raw HTML captured over HTTP, which embedded a client-link token; deleted, superseded by the
  browser screenshots.
- The **locally generated demo password, staff password and key passphrase** printed by `demo-synthetic.log` — replaced
  with `[redacted — generated for this local run only]`. They only ever existed for a throwaway database.
- Client-link tokens (`/r/<token>` and the invite/reset/verify equivalents) in `demo-synthetic.log`, `probe-live.log`,
  `probe-live.json` and `snapshot.log` — replaced with `[redacted]`.
- All logs that PowerShell had written as **UTF-16LE** were converted to **UTF-8**, because a UTF-16 log is
  unsearchable by `grep` — which matters when the point of publishing is that another agent can read it.

Verified afterwards across the whole tree: no UTF-16 files, no client-link tokens, no secret-shaped values. Nothing in
this directory is a credential for any real system.

**Not published:** the local Tickmark instance used for the browser phase (stopped), and the MCP credentials for any
third-party service.

## 7. Acceptance checklist

| Criterion | Status |
|---|---|
| Correct Tickmark repository audited | ✅ `6ff16ff` at `C:\Users\Casey\Web Apps\Tickmark` |
| No new registration required | ✅ Nothing was signed up for |
| No product code modified | ✅ `git diff --stat` empty |
| No user data deleted | ✅ Only audit-created scratch data written |
| No credentials exposed | ✅ Demo-only throwaway values, noted in §6 |
| Supabase usage explicitly verified | ✅ **No Supabase, no Postgres, no hosted DB** |
| Local / self-hosted / hosted clearly distinguished | ✅ `ARCHITECTURE…` §5 |
| Core workflows assessed | ✅ Executed end to end |
| Security findings have concrete evidence | ✅ 11 findings, all with file:line or probe output |
| Actual test results reported | ✅ 563/563 pass; coverage gate exit 1 |
| UI/UX grounded in the running application | ✅ Rendered HTML + repository screenshots; limitation stated |
| Production readiness not overstated | ✅ Four separate readiness ratings, not one |
| Commercial claims separate fact from hypothesis | ✅ Prices cited and dated; demand explicitly called unproven |
| Clear development roadmap exists | ✅ P0–P3, R1–R4, with acceptance criteria |
| Concise recommendation delivered | ✅ `TICKMARK_EXECUTIVE_REVIEW.md` §10 |

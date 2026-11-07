# Engineering and Test Report

All commands were run from the repository root on **Node v26.5.0, npm 11.17.0, Windows**. Raw output is in
`evidence/`. Where the project documents a floor of Node 24, note that my measurements are on 26 — which matters for
one finding (E-01) and one only.

## 1. Test results — current, not reported

```
$ node --test "test/*.test.js"
ℹ tests 563      ℹ pass 563      ℹ fail 0
ℹ cancelled 0    ℹ skipped 0     ℹ todo 0
ℹ duration_ms 75995.2811         → exit 0
```

| Metric | Value |
|---|---|
| Test files | 90 (plus `fake-dom.js`, `helpers.js`, `smtp-relay.js` as support) |
| Tests | **563** |
| Passing | **563** |
| Failing | **0** |
| Skipped / todo | **0** (nothing quietly disabled) |
| Wall time | 76 s |
| Flaky | **None observed.** A second full run (the coverage run) also passed 563/0/0 |

**Cross-check against previous reports.** `docs/phase-5-launch-qualification.md` records "Phase 4 suite passed 544
tests". The prior independent review directory (`review/rediscovery-2026-11-07/tests.log`, same day) records 563/563.
So the count has risen 544 → 563 and the current figure is independently corroborated by two runs I did not perform in
that directory. No test has been deleted to make the numbers better: the count went up.

**What the tests actually attack** (spot-checked, not assumed): `test/security.test.js` runs two practices against each
other's ids and asserts `404`; walks the route table in `test/roles.test.js` and fails when a sensitive address has no
role; defeats a 6-digit code in `test/security.test.js:100-141` and asserts the door shuts within 10 guesses;
`test/stack.test.js` uploads over HTTP and requires the document text not to appear in the stored bytes.

## 2. Coverage — **the project's own gate fails**

```
$ node --test --experimental-test-coverage --test-coverage-lines=93 \
    --test-coverage-functions=90 --test-coverage-branches=75 "test/*.test.js"
all files |  91.57 |  74.65 |  88.86 |
→ exit 1
```

Measured against the floor in `package.json`: **lines 91.57% (needs 93), branches 74.65% (needs 75), functions 88.86%
(needs 90).** Three of the three thresholds are missed, so `npm run coverage` **fails**, and CI runs exactly that
command.

**Caveat, stated honestly:** this is Node **26.5.0**. CI pins Node **24**. V8 coverage instrumentation differs between
majors, so it is *possible* the gate passes on 24. I could not test that — only one Node is installed. Either way the
finding stands in a weaker form: **a quality gate whose verdict depends on the runtime's minor version is not a gate.**
The author's own `docs/phase-5-launch-qualification.md` recorded the same failure at an earlier commit (90.90 / 88.14 /
73.97 against the same floor) and wrote: *"do not claim this gate passes unless `npm run coverage` exits 0."*
Independently reproduced, still true.

### Where the uncovered code is — the important detail

| File | Lines % | Branch % | Why it matters |
|---|---|---|---|
| `web/download.js` | **65.46** | 31.58 | The decryption-and-save path. The single most security-relevant browser file. |
| `web/upload.js` | **78.28** | 41.94 | The encryption-and-send path. Second most. |
| `web/invite.js` | 52.63 | 66.67 | Accepting a staff invitation, which hands over a key copy |
| `web/keys.js` | 76.67 | 88.89 | Passphrase change / recover |
| `web/setup.js` | 79.10 | 42.86 | Making the practice key |
| `src/templates-views.js` | 74.62 | 62.50 | Templates UI (lines 141-228 uncovered — a whole feature branch) |
| `src/xero-views.js` | **57.08** | 31.03 | Xero UI |
| `src/quickbooks-views.js` | **38.54** | 20.00 | QuickBooks UI — lines 256-364 entirely uncovered |
| `src/tenancy/operational-status.js` | 68.09 | 76.47 | Hosted status |
| `tools/finalize-deletions.mjs` | 67.61 | **14.29** | **Deletion finalisation** — a destructive operator tool with 14% branch coverage |
| `tools/reap-pending-tenants.mjs` | 68.42 | 16.67 | Tenant reaping |

Two patterns worth acting on: **(a)** the browser crypto paths, and **(b)** destructive operator tools. Both are the
files where a mistake is least recoverable.

## 3. Other quality gates — all green

| Gate | Command | Result |
|---|---|---|
| Stylesheet integrity + **WCAG contrast** | `check:style` | exit 0 |
| Documents agree with each other | `check:docs` | exit 0 |
| Every page reachable, none a dead end | `check:nav` | exit 0 |
| Marketing site claims | `check:site` | exit 0 |
| Render all pages from the real server | `snapshot` | exit 0 |
| Rendered pages structurally sound | `check:pages` | exit 0 — *"all 42 pages look structurally sound"* |
| No unreferenced exports | `find:unused` | exit 0 |

That is seven gates, five of which are unusual for a project of this size, and all of them pass. This is why the
coverage failure stands out: it is the **only** red light, and the author knew.

## 4. Code quality

**Module boundaries.** Good, and recently and deliberately improved. `src/app.js` was 7,173 lines and is now **523** —
a dispatcher plus a 120-route table plus the two things only it can do (serve allow-listed browser scripts, answer
`/healthz`). Views live in 13 `*-views.js` modules; data access lives in `store.js` (2,537 lines) and `db.js` (894).

**The one structural concern:** `src/store.js` at 2,537 lines holds most of the query surface, and it is the file
where a tenancy slip would hide. It is defended by tests rather than by size. Splitting it by subject (requests /
uploads / members / events) would be the natural next refactor, and is not urgent.

**Strengths worth naming:**

- **Authorisation is structural, not repetitive.** The role requirement is a third element on the route tuple and the
  check happens once, centrally (`src/app.js:500`). A reader can see the whole permission model on one screen, and
  `test/roles.test.js` fails if a sensitive address forgets one. The best engineering decision in the codebase.
- **Comments explain *why*, with the cost of the alternative.** `src/crypto.js` explains why scrypt is `N=2^16` rather
  than OWASP's `2^17`; `src/ratelimit.js` explains why the bucket is the account and not the IP; `src/http.js`
  explains why compressing is safe here (no secret in any response body). That is rare, and it is what makes the code
  reviewable by a stranger.
- **Error handling is uniform.** `RequestError` → status + sentence; anything else → logged with stack, answered with
  "Something went wrong on the server. The operator can find the detail in its log."
- **Type safety: none.** Plain JS, no JSDoc type-checking run. Given zero dependencies and 563 tests this is a
  reasonable trade, but it is the main reason a typo can reach production. **No `tsc --checkJs` gate exists.**

**Weaknesses:**

- **Modest duplication** in the view modules: the "render a reminding page, keep the text on failure" shape appears in
  both `sendOpening` and `sendReminder` (`src/request-actions.js:455-500` vs `600-670`) and could be one helper.
- **Only 2 `CHECK` constraints** in the whole schema; validation lives in application code. Fine, but a hand-edited or
  imported database can hold values the app never produces.
- **No `ON DELETE` clauses** (finding S-09).
- **`finalize-deletions.mjs` at 14% branch coverage** is the least-defended destructive code in the project.

## 5. Data reliability

| Concern | Assessment |
|---|---|
| Migration safety | Migrations run at startup, are additive (columns added, rows adopted), and **report what they did** on the console. Downgrade is explicitly unsupported and documented. |
| Constraints | `PRAGMA foreign_keys = ON`, 40 `REFERENCES`, WAL, `busy_timeout = 5000`. Two `CHECK`s only. |
| File/DB consistency | The row is written after the blob, so a crash between leaves an orphan *file*, never a row pointing at nothing. `reconcile-uploads` sweeps. Covered by `test/reconcile-uploads.test.js`, `test/durability.test.js`. |
| Storage accounting | `upload_reservation` + `BEGIN IMMEDIATE` serialises concurrent reservations (`src/storage.js:28-46`), so two simultaneous uploads cannot both pass the quota check. Correct, and the kind of thing most projects get wrong. |
| Interrupted uploads | A reservation is released on failure; nothing partial becomes a row; the refusal states remaining bytes. |
| Duplicate operations | No general idempotency key. POST-redirect-GET (303 after every write) stops a refresh double-submitting, but **a double-click on a slow link could create two requests.** Low risk. |
| Backup validity | `VACUUM INTO` + `--verify` that the DB opens *and* every named document is present. Drilled in `test/backup.test.js` including a decrypt from the restored copy. |
| Restore integrity | Proven single-tenant (`test/backup.test.js`) and for a fleet (`test/backup-all.test.js`). Hosted *remote* restore uses a fake Restic and is unproven. |
| Tenant isolation during export | `test/tenant-export.test.js`, `test/import-tenant.test.js`, `tools/verify-tenant-export.mjs`. |
| Retention/deletion | Grace periods + tombstones + `finalize-deletions`; `test/removal.test.js` (21.2 KB), `test/restore-tombstones.test.js`. |
| Corruption handling | `verifyPassword` returns `false` for a malformed hash rather than throwing, so a corrupt row cannot become an account-existence oracle. An unrecognised role reads as the *most* capable — the safe direction for availability, and documented. |

## 6. Performance — measured, not estimated

`node tools/bench.mjs 500` → fixture: **500 clients, 2,000 documents requested, 500 files**, built in 3.7 s.

| Page | Median | Worst |
|---|---|---|
| Board | **22 ms** | 33 ms |
| Board, closed tab | 15 ms | 22 ms |
| Board, searched | 16 ms | 16 ms |
| Clients | 15 ms | 19 ms |
| Chase | 24 ms | 31 ms |
| Documents | 16 ms | 19 ms |
| Documents, searched | 15 ms | 16 ms |
| Ask everyone | 15 ms | 20 ms |
| CSV of requests | 15 ms | 22 ms |

Every page a morning's loop touches renders in **under 35 ms** at a firm size 5–10× the target customer. No performance
work is warranted, and **no benchmark was run beyond 500 clients**, so scalability beyond that is not claimed.
Responses are gzip-compressed (`content-encoding: gzip` observed on the wire).

## 7. Dependencies, licences, runtime

| Concern | Finding |
|---|---|
| Outdated packages | **Not applicable** — no packages |
| Known vulnerabilities | **None possible** via dependencies. The runtime itself is the supply chain, and Node 24 is a supported LTS line |
| Abandoned dependencies | **None** |
| Licence obligations | **AGPL-3.0-or-later.** For self-hosting this is a non-issue. For a hosted service it means the operator must offer source to users — which is exactly what the author intends ("the hosted edition can exist without being undercut by a closed copy of itself"). Any commercial plan must be compatible with it, and self-hosters who redistribute inherit copyleft obligations |
| Runtime compatibility | **Node ≥ 24 required**, because `node:sqlite` is not on older LTS lines. This excludes Node 20/22-only hosts and typical shared hosting. `engines` is advisory unless the host enforces it |
| Build reproducibility | **Trivially reproducible** — there is no build. `FROM node:24-alpine` + `COPY src`, `COPY web`, `COPY package.json`. Docker image digest, not source attestation, is the identity. **No signed releases** (acknowledged in `docs/security.md:241`) |
| CI | `.github/workflows/ci.yml`: tests on **ubuntu-latest and windows-latest**, a `checks` job (7 gates incl. coverage), and a `container` job that boots `docker compose up` and probes `/healthz`. Good coverage of real failure modes — including the one that once shipped ("the image builds and then cannot start") |

## 8. Engineering verdict

**A- on craft, B on assurance.** The code is more readable, better reasoned and better tested than most funded products
at this stage, and the zero-dependency posture is a genuine strategic asset. What it lacks is not skill but
*exposure*: the coverage floor is not met, no type checking exists, two destructive operator tools are thinly covered,
and the whole thing has never run against a real mail relay, a real provider or a real user.

### Findings raised by this phase

| ID | Severity | Finding |
|---|---|---|
| E-01 | **Medium** | `npm run coverage` exits 1 (91.57 / 74.65 / 88.86 vs 93 / 75 / 90). Known and recorded by the author; still unresolved; CI runs it |
| E-02 | **Medium** | Lowest coverage sits on `web/upload.js`, `web/download.js`, `src/quickbooks-views.js` (38.5%), `src/xero-views.js` (57.1%) |
| E-03 | **Medium** | `tools/finalize-deletions.mjs` — destructive — is at 67.6% lines / 14.3% branches |
| E-04 | **Low** | No type checking gate at all (no `checkJs`/JSDoc validation) |
| E-05 | **Low** | `src/store.js` is 2,537 lines; the highest-risk file for a future tenancy slip |
| E-06 | **Low** | No idempotency key on create/send routes; a double-click can duplicate |
| E-07 | **Low** | Node ≥ 24 floor narrows hosting options; `engines` unenforced |

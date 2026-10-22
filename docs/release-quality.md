# Tickmark release quality and synthetic demonstration

**Purpose:** close locally actionable verification gaps and support a controlled, fictional-data demonstration. This is not a production launch approval.

## Commits and scope

- Required starting branch: `codex/tickmark-launch-qualification`.
- Starting commit: `f4694ffca8efe0063d2509e57a00ab4738b078ba`.
- Final commit: recorded after the release-quality commits are pushed.
- Delivery branch: `codex/tickmark-release-quality`.
- `main` was not changed. No public deployment, real client information, or billing activation was performed.
- Changed files: this report, the synthetic demo tool and package command, Phase 2/5 evidence corrections, the invite callback wiring, TOTP-aware owner verification, Stripe optimistic reconciliation, operator export/offboarding arguments, and regression tests for the reviewed behaviors. The exact names are listed by `git show --stat` on the final commit.

## Focused security review

The review reproduced the following defects before fixes, then added regression coverage:

1. **Stripe reconciliation raced a webhook.** Reconciliation held a SQLite write transaction while waiting on Stripe, preventing a concurrent webhook from applying. It now performs the remote read outside the write transaction and commits only if the relevant local billing state and event watermark still match its snapshot.
2. **Hosted invitation recovery callback was disconnected.** The gateway passed `reconcileHostedInvite`, while the invite view consumes `onInviteReconcile`; an interrupted cross-database acceptance could remain stuck. The callback is now wired under the expected name, and the test injects a registry failure after the tenant claim then verifies retry recovery.
3. **Sensitive owner export/offboarding accepted only a password when TOTP was enabled.** Owner verification now consumes a fresh TOTP step or single-use recovery code; the operator tools accept a protected code file instead of a command-line code. Replays and missing proof are refused.
4. **Export/restore symlink traversal was insufficiently tested.** Regressions now exercise Windows junctions and verify that export and restore refuse them without writing outside the intended tree. The Restic fixture preserves links so the application guard is reached.

Additional tests cover expired session cleanup, foreign session revocation, unknown Stripe status, stale reconciliation watermark, provider failures, and sensitive billing error-log redaction. Review also considered event ordering, subscription transitions, tenant access, and recovery boundaries. No claim is made that local tests prove every hosting or filesystem property.

## Synthetic demonstration

Use Node 24 or newer. In PowerShell, create a new, disposable data directory and seed it:

```powershell
$demoDir = Join-Path $env:TEMP ('tickmark-synthetic-' + [guid]::NewGuid().ToString('N'))
npm run demo:synthetic -- $demoDir
$env:TICKMARK_DATA = Join-Path $demoDir 'tickmark.db'
npm start
```

The setup prints generated owner/staff passwords, a generated practice-key passphrase, a client link, and the request route. Use `http://localhost:3000` for the printed routes. The fictional practice, owner, assistant, client, checklist, and sample PDF text are visibly labelled synthetic; two PDF files are encrypted through the same browser crypto module used by the product, and a third item remains outstanding after review. The data stays in the selected local directory. Remove only that disposable directory after stopping the app if you want to reset the demo. The app is not connected to Stripe or an external mail relay by this procedure.

## Verification results

Thresholds in `package.json` remain unchanged: lines 93%, functions 90%, branches 75%.

- Baseline at the starting commit: 548 tests passed; coverage was 90.94% lines, 74.04% branches, and 88.10% functions. The configured coverage command exited nonzero because those gates were below threshold.
- Final `npm test`: 556 passed, 0 failed.
- Final coverage command: 556 passed, 0 failed; 91.33% lines, 74.57% branches, and 88.61% functions. It exits nonzero because the unchanged gates remain short by 1.67, 0.43, and 1.39 percentage points, respectively. The remaining uncovered code spans additional production paths beyond the focused review; reaching the line/function gates would require broader work than this release-quality scope. No threshold was lowered and no production code was excluded.
- `npm run check:site`: passed.
- `npm run check:docs`: passed (26 documents linked from README).
- `npm run check:style`: passed.
- `npm run check:nav`: passed.
- `npm run snapshot`: passed; generated 42 pages.
- `npm run check:pages`: passed for all 42 pages.
- `npm run check:gateway`: passed for all 14 generated gateway pages.
- `git diff --check`: passed before final report creation; rerun before commit.
- Synthetic setup: ran successfully against a new temporary local directory and created two encrypted synthetic PDF uploads plus an outstanding item.

## Verification boundaries

### 1. Locally verified software

The listed tests, coverage measurement, static/site/navigation/documentation checks, generated-page checks, and local synthetic setup are software evidence from this workstation. They do not establish production-grade load, filesystem, or tenant-isolation properties beyond the exercised cases.

### 2. Externally verified infrastructure

No production hosting, object storage, email/SMS relay, Stripe account, DNS, TLS, or external backup repository was exercised in this release-quality pass. Docker Engine was unavailable: the Docker Desktop Linux engine named pipe did not exist. Browser automation was unavailable in the earlier Phase 5 environment, where computer-use initialization failed; the demo was therefore not claimed as browser-verified here.

### 3. Unverified production operations

Still requiring an operator in the actual environment: hardened host/network configuration, secrets handling and rotation, TLS/proxy behavior, rate-limit sharing, alert delivery, off-site backup credentials and retention, restore/decryption drills, deletion propagation into backups, filesystem semantics, capacity limits, incident response, and owner identity verification procedures beyond local authentication.

Recommended hosting-validation sequence: provision an isolated staging environment; use only synthetic data; verify configuration and TLS/proxy headers; exercise account/TOTP/invitation and cross-tenant denial paths; run billing in Stripe test mode only after founder approval; verify backup upload, retention and isolated restore/decryption; test deletion and tombstone replay; confirm alert routing and operator access; then obtain independent security and operational review. None of these steps authorizes production documents or paid public launch.

### 4. Commercial and legal work requiring founder decisions

Pricing and tax treatment, legal entity and Stripe contracting details, support commitments, privacy notice/terms/DPA, data location and retention promises, processor/subprocessor disclosures, incident commitments, cancellation/export policy, and customer onboarding remain founder decisions and/or professional legal/accounting review. Draft documents are not final approvals.

## Recommendation

Suitable for a controlled local demonstration using only the documented fictional dataset after the stated checks complete. Do not use real client documents, accept paid public customers, or describe the service as production-ready on the strength of this report. Hosting and commercial gates remain open.

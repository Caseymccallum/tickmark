# Phase 1 — hosted identity and access control

**Status:** implementation complete; verification results are recorded below.  
**Starting point:** `origin/main` at `2d1cd52770dd794986fcfb8a31121a07d91b9630`.  
**Audit evidence:** [FINDINGS_REGISTER.md at audit commit `27aa759`](https://github.com/Caseymccallum/tickmark/blob/27aa759966547fb7ac80420f1e5029e22ff768b1/docs/audits/commercial-readiness-2026-10/FINDINGS_REGISTER.md), with the detailed [security audit](https://github.com/Caseymccallum/tickmark/blob/27aa759966547fb7ac80420f1e5029e22ff768b1/docs/audits/commercial-readiness-2026-10/SECURITY_AUDIT.md), [encryption review](https://github.com/Caseymccallum/tickmark/blob/27aa759966547fb7ac80420f1e5029e22ff768b1/docs/audits/commercial-readiness-2026-10/ENCRYPTION_REVIEW.md), and [remediation roadmap](https://github.com/Caseymccallum/tickmark/blob/27aa759966547fb7ac80420f1e5029e22ff768b1/docs/audits/commercial-readiness-2026-10/REMEDIATION_ROADMAP.md).

## Changes

- **F-01 — hosted login throttling.** Password attempts are limited before password hashing by normalized account email and by source address. Defaults are 10 failures per account and 30 per source in a rolling 15-minute window. A successful password clears the account bucket. Unknown accounts use a dummy scrypt hash and the same error text. Credentials and authentication tokens are not logged. Forwarded addresses are ignored unless the immediate socket peer is listed in `TICKMARK_TRUSTED_PROXIES`; the proxy chain is walked from the trusted end. The limiter is process-local, so multiple app processes require a shared limiter at the gateway boundary.
- **F-02 — hosted TOTP.** On a tenant host, a password for a TOTP-enabled practitioner creates a short-lived, digest-backed challenge cookie and no platform or workspace session. A current TOTP or single-use recovery code completes it; five wrong attempts spend the challenge. Membership and active practitioner state are checked again before both sessions are created. Challenges cannot be replayed. Password-only hosted login and self-hosted TOTP continue to use their existing flows.
- **F-03 — invitation lifecycle.** New invitations bind token, tenant, email, role and expiry in an additive registry table; the raw token remains represented by a digest. New recipients create hosted accounts, while existing accounts must prove the current password. The tenant database remains authoritative for the invitation and practitioner. `pending → accepting → accepted` makes the registry/tenant two-file operation retryable; a later invite-page request reconciles a locally committed claim if registry completion was interrupted. Revocation removes the registry token index and revokes the tenant invite. Roles and key transfer retain the existing tenant schema and browser-sealed key format.
- **Membership enforcement.** Tenant login checks both hosted membership and a live tenant practitioner. Authenticated platform sessions do not authorize every practice. Removing a member ends tenant sessions and removes the corresponding registry membership; existing platform sessions cannot bridge into that practice. Tenant handlers continue to scope operations to the tenant-local session and role.

## Compatibility, migration and limitations

The registry migration is additive (`CREATE TABLE IF NOT EXISTS hosted_invite` plus an index). It does not rewrite tenant rows, password hashes, session data, encryption keys, key wrapping records or document envelopes. New invites are indexed and email-bound at issue time. Legacy invitations predate that binding and remain bearer-token invitations until they expire or are revoked. Back up the registry and all tenant directories together before upgrade; restore them from a consistent point so intermediate invite state remains aligned.

The hosted layer never handles plaintext practice keys. Accountant invitations continue to carry the existing browser-produced wrapped key; assistant invitations carry none. Revocation cannot erase copies of a key or documents that a former member downloaded or decrypted. The in-memory limiter is not shared between multiple app processes. Email password reset and email verification remain outside this phase.

## Verification

Baseline on the isolated worktree before changes: `npm test` — 506 passed, 0 failed.

Post-change verification:

- `npm test` — 515 passed, 0 failed.
- `node --test test/gateway.test.js test/client-address.test.js test/registry-migration.test.js test/browser-invite.test.js` — 23 passed, 0 failed.
- `npm run check:docs`, `npm run check:site`, `npm run check:style`, `npm run check:nav`, `npm run find:unused`, `npm run snapshot`, and `git diff --check` passed.
- `npm run check:pages` reports two existing unlabeled inputs in `ask-everyone-due-pre-ticked.html` and `ask-everyone.html`; this audit did not change those pages.
- `npm run coverage` — 91.04% lines, 75.63% functions, 88.95% branches. Branch coverage clears the 75% threshold; line coverage is 1.96 percentage points below 93%, and function coverage is 14.37 points below 90%, so the command exits 1. The repo-wide report includes existing uncovered paths outside this phase as well as new tenancy paths.
- The default `npm run check:container` endpoint could not be used because the existing process on port 3000 answered HTTP 500 and Docker Desktop's named pipe was unavailable. An isolated app on port 3317 passed `BASE=http://127.0.0.1:3317 node tools/check-container.mjs`, including encrypted upload, key rotation, move, old-key retirement, and reopening both files. This verifies the app flow; a Docker image/container run remains unverified.

Verification used an isolated worktree. The sandbox initially denied Node's test-runner child-process creation; verification commands were rerun with the required elevated execution. No production deployment, Stripe configuration change, or customer data access was performed.

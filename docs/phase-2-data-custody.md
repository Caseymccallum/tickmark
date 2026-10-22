# Phase 2 — data custody, storage limits and customer lifecycle

**Branch:** `codex/tickmark-data-custody`  
**Starting commit:** `33b32907e0fa8d745304e2a8a7b9829ad240a3af` (Phase 1)  
**Ending implementation commit:** `36f6be4` (final report/documentation commit follows)  
**Scope:** synthetic data only; no production deployment or customer data

## Result

Phase 2 adds tenant-wide logical storage quotas, observable physical storage reporting, aged upload reconciliation, a verified ciphertext-preserving practice export and restore path, and an owner-authorised offboarding state machine.

| Finding | Result | Evidence and boundary |
| --- | --- | --- |
| F-05 — tenant storage quotas | **FIXED** | Hosted practice quotas are enforced against committed ciphertext plus atomic active-upload reservations. Two hosted synthetic practices have separate quotas and encrypted files. The free-space check is best-effort across processes; actual ENOSPC is handled safely. |
| F-06 — export and offboarding | **PARTIALLY FIXED** | Owner-verified export, integrity verification, tested restore/decrypt, access suspension and retryable primary-data deletion are implemented. Existing/off-host/immutable backup copies cannot be discovered or expired by this application; Phase 3 must implement that retention contract. |
| F-10 — interrupted upload orphans | **FIXED** | Tenant-scoped dry-run cleanup removes only aged, unreferenced `.incoming`/`.bin` files and stale reservations. Synthetic tests preserve recent/active and referenced files, ignore symlinks, and apply after an interrupted staging fixture. |

Pending-payment tenant retention from F-14 is **partially implemented**: bounded dry-run scheduling is available and retains the normal recovery window; backup expiry remains a Phase 3 dependency.

## Data inventory and custody

| Location | Persistent information | Protection and lifecycle |
| --- | --- | --- |
| `data/saas.db` | Hosted accounts and password hashes, SaaS session digests, tenant names/slugs/plan and billing references, owner/member relationships, host mappings, client-link prefix routing index, invitation metadata, storage quota, lifecycle and deletion tombstone | SQLite; credentials are hashed where they are bearer secrets. Billing IDs and identity metadata are not encrypted. The tenant deletion tombstone retains tenant UUID, a one-way slug digest, timestamps, export manifest digest and an optional hold reason. |
| `data/tenants/<id>/tickmark.db` | Practice/member records, clients, requests, checklist state, document names/MIME/size/hash/path, append-only history, wrapped practice keys, auth/session material, TOTP secrets and integration credentials | SQLite. Client document bytes are not in this database. Wrapped private keys and TOTP secrets are sensitive server-readable metadata; the server does not have the practice passphrase needed to unwrap document keys. Tenant auth and integration secrets are removed from owner export. |
| `data/tenants/<id>/blobs/` | Encrypted document envelopes, arranged under request directories; active upload staging files end in `.incoming` | Document bytes remain encrypted in the browser-created envelope. Filenames, request/client association, byte counts, ciphertext hashes and timestamps remain visible in database metadata. Temporary upload bytes are ciphertext and use mode `0600`. |
| `data/tenants/.retired/<id>/` | A tenant directory temporarily isolated during final deletion or a retry | Access is already denied by the registry lifecycle state. The finalizer removes this tree without following symlinks. It is a transient deletion workspace, not a backup. |
| Backup destinations | Snapshot database, referenced blobs and manifests created by `tools/backup*.mjs` | Operator-chosen paths. Phase 2 export bundles are separate, owner-directed outputs. Neither the app nor the deletion CLI can discover arbitrary backup copies. |
| Logs and delivery | Operational JSON events and transport/access logs; outbound mail/SMS is sent directly by configured adapters | No persistent app queue was found. Logs can contain routes, identifiers and error details but not document contents or bearer tokens. SMTP/SMS providers and reverse-proxy logs have their own retention settings. |

The platform registry and each practice directory form a relationship: registry rows route an account, host or client-link prefix to one tenant UUID, while the tenant database contains the actual practice rows and each ciphertext path. A complete hosted recovery needs the registry plus every tenant database/blob directory. A single-practice export deliberately excludes the registry and can be restored as a self-hosted practice with newly provisioned credentials.

## Storage policy

- Hosted practices default to **5 GiB** logical storage, configurable per tenant in `tenant.storage_quota_bytes`. Provisioning defaults can be changed with `TICKMARK_HOSTED_STORAGE_QUOTA_BYTES`; operators can set an individual value with `tools/set-storage-quota.mjs`.
- Logical usage is committed upload ciphertext bytes plus current upload reservations. Repeated uploads are separate documents and all count. Each incoming ciphertext chunk reserves bytes under a SQLite `BEGIN IMMEDIATE` transaction before it reaches disk, so concurrent requests and processes share one serialized quota boundary. Usage queries cap their row scan at 100,000 uploads/reservations and fail closed beyond that limit.
- Incoming upload reservations are removed when an upload record commits or a request is refused. A crash leaves a reservation for the reconciler. Staging and orphan files are included in physical blob-tree reporting, not silently counted as committed document usage.
- Physical usage is an apparent byte/file scan of the tenant `blobs/` tree. It includes staging and aged orphans, skips symlinks, and is bounded by a file-count limit. It excludes SQLite files/WAL, logs, backup destinations and filesystem allocation overhead. It is an operational measure, not a quota number.
- Upload admission checks a configurable free-space floor (`TICKMARK_MIN_FREE_BYTES`, default 512 MiB) and reports disk-full failures as HTTP 507. The filesystem check is best-effort across tenants and processes; actual writes still handle ENOSPC. The per-tenant quota is atomic.
- At 80% of the tenant quota, the upload path emits `storage.quota-approaching`. Falling below the free-space floor emits `storage.disk-low`. Logs contain byte counts and event types, not document data or tokens.
- Self-hosted installs have no tenant quota by default. Their operators can use the same physical report and free-space floor. The application does not advertise unlimited hosted document storage.

Inspect one tenant:

```sh
node tools/storage-report.mjs --data data --tenant <tenant-uuid>
node tools/set-storage-quota.mjs --data data --tenant <tenant-uuid> --bytes 10737418240
```

## Interrupted upload reconciliation

`tools/reconcile-uploads.mjs` is tenant-scoped, bounded, and dry-run by default. It considers only unreferenced `.incoming` and `.bin` files older than the configured age (24 hours by default). Recent files and reservations are preserved. Referenced database paths are never removed; symlinks are skipped and not followed. Stale reservations are removed only in `--apply` mode. The tool reports relative paths, byte counts, and file kind; it never reads document content.

```sh
node tools/reconcile-uploads.mjs --data data --tenant <tenant-uuid>
node tools/reconcile-uploads.mjs --data data --tenant <tenant-uuid> --apply
```

The database snapshot/backup tools copy only database-referenced blobs for practice exports. A reconciliation run should still be scheduled away from maintenance that is actively changing paths; neither tool takes a global lock against a separate export process.

## Export, verification and restore

Owner export requires the exact tenant UUID, the owner's platform email and password, and a new destination path. Passwords are read from a file so they do not appear in the process argument list. The bundle is a directory, not a ZIP archive; keep it in access-controlled storage because its metadata can identify clients.

```sh
node tools/export-tenant.mjs --data data --tenant <tenant-uuid> --confirm <tenant-uuid> \
  --email owner@example.test --password-file /secure/owner-password.txt --to /secure/exports/practice-2026-10-22
node tools/verify-tenant-export.mjs --from /secure/exports/practice-2026-10-22
node tools/restore-tenant-export.mjs --from /secure/exports/practice-2026-10-22 \
  --to /srv/tickmark-restored --confirm <tenant-uuid> --owner-email owner@example.test \
  --password-file /secure/new-owner-password.txt
```

Format `tickmark-practice-export` version 1 contains a consistent `tickmark.db` snapshot, `practice.json`, an integrity manifest and the ciphertext blobs referenced by upload rows. The database preserves clients, requests, checklist/status, history, practice settings and wrapped practice keys. The manifest hashes every bundled file and the verifier checks each upload row against its corresponding blob path, size and ciphertext digest. Restore verifies first, rewrites blob paths, sets a new owner password and clears old TOTP state.

The export removes platform registry/billing identifiers, practitioner password hashes, sessions, login challenges, recovery/reset/signup tokens, live access links, invitations, OAuth credentials and TOTP secrets. It contains no plaintext documents. An owner can restore and decrypt documents with the practice's existing encryption passphrase or recovery key. This is an encrypted archive suitable for migration; it is not a human-readable plaintext export. The server cannot produce plaintext document content because it does not possess the passphrase. Each additional practice member must be provisioned again after restore.

## Offboarding and retention

The owner initiates deletion after strong password verification, email match and exact UUID confirmation. The CLI requires an export by default; the owner must explicitly confirm `--confirm-no-export <uuid>` to continue without one. A verified export's manifest digest is kept in the deletion record. Initiation sets `deletion_requested`, which blocks tenant workspace and client-link access through the resolver, clears tenant sessions/challenges, revokes client links and unused invitations, and records the minimum deletion date. The default retention period is 30 days (configurable from 0 to 3650 days).

```sh
node tools/offboard-tenant.mjs --tenant <tenant-uuid> --confirm <tenant-uuid> \
  --email owner@example.test --password-file /secure/owner-password.txt \
  --totp-code-file /secure/owner-totp.txt --to /secure/exports/practice
node tools/offboard-tenant.mjs --action hold --tenant <tenant-uuid> --confirm <tenant-uuid> \
  --hold-until 2027-01-01T00:00:00.000Z --reason 'contractual retention'
node tools/offboard-tenant.mjs --action purge --tenant <tenant-uuid> --confirm <tenant-uuid>
```

When a practice has confirmed TOTP, owner exports and deletion requests require a current, unused authenticator code or a single-use recovery code. Supply it through `--totp-code-file`; the code itself is never an argument or a log value. The accepted TOTP step or recovery code is consumed. Practices without confirmed TOTP continue to require the owner email/password checks. Purge is refused before the deletion date or while a retention hold is active. It first changes lifecycle state to `deleting`, moves the practice directory under `.retired`, removes it without following links, and then removes registry relationships, hosted invitations, accounts no longer used by another practice, and sessions. A tombstone prevents slug reuse and records completion without retaining personal identifiers. A retry resumes from `.retired` and is idempotent. Pending-payment practices older than 30 days can be listed/scheduled with `tools/reap-pending-tenants.mjs`; dry-run is the default and its deletion still receives the normal 30-day retention window.

Retention behavior currently implemented:

- Active data remains until the owner requests deletion or an operator acts on an aged pending-payment tenant.
- Closed requests and expired/revoked client links remain in the practice database until practice deletion; public link lookup rejects expired/revoked tokens.
- Temporary/orphan ciphertext is retained at least 24 hours before it can be considered by reconciliation.
- Revoked invitations are removed during tenant purge. Pending-payment tenant directories remain through the lifecycle retention period.
- Deleted-practice registry tombstones remain for slug non-reuse and audit of the lifecycle action.
- Backup snapshots are outside the app's discovery and deletion boundary. Phase 3 must define encrypted off-host backup destinations, access restrictions, expiration windows, deletion propagation, and restore drills. Do not promise instant erasure from immutable or operator-held backups.

These are technical controls to inform privacy and DPA drafting; they are not a statement of legal compliance.

## Migration and security limits

The practice schema adds an `upload_reservation` table. The hosted registry adds quota/lifecycle/hold columns and a `tenant_deletion` table/index. Migrations are additive and repeatable at database open; existing upload rows remain the source of committed-byte usage, so no backfill rewrites document metadata, key material or ciphertext. No encryption envelope or key format changed.

The export snapshot holds a tenant SQLite writer lock while the snapshot and referenced blob files are copied, preventing path changes during the bundle. This can delay writes to that practice for the duration of a large export. Billing/member registry snapshot collection uses the current owner/member rows; the export itself is a sensitive operator artifact and should not be placed in a web-served directory.

Phase 3 prerequisites: scheduled off-host `backup-all`, restricted backup credentials, immutable retention/expiry policy, monitoring of backup failures and free space, periodic isolated restore plus decryption drills, a supported lifecycle for deleting/expiring backups, and a production concurrency/load run on the actual storage filesystem. The current workspace had no Docker daemon available in earlier checks; any container result below must be read as such, not as a deployed-container verification.

## Files changed

- Storage enforcement and accounting: `src/storage.js`, `src/app.js`, `src/client-portal.js`, `src/db.js`, `src/http.js`, `src/keys-views.js`, `src/store.js`, hosted tenancy entry/gateway/registry/resolver, `tools/storage-report.mjs`, `tools/set-storage-quota.mjs`, and quota/storage/schema tests.
- Reconciliation: `src/tenancy/reconcile-uploads.js`, `tools/reconcile-uploads.mjs`, and `test/reconcile-uploads.test.js`.
- Export and restore: `src/tenancy/practice-export.js`, `tools/backup-lib.mjs`, export/verify/restore CLIs, and `test/tenant-export.test.js`.
- Offboarding: `src/tenancy/offboarding.js`, `tools/offboard-tenant.mjs`, `tools/reap-pending-tenants.mjs`, and `test/offboarding.test.js`.
- Accessibility: `src/bulk-ask-views.js` and `test/ask-everyone.test.js`.
- Product and operator documentation: `.env.example`, `README.md`, `docs/operations.md`, `docs/saas.md`, and this delivery report.

## Verification record

- Starting commit: `33b32907e0fa8d745304e2a8a7b9829ad240a3af`.
- Ending functional implementation commit: `36f6be4`; the final report/documentation commit is the next commit on this branch.
- Baseline from Phase 1: 515 passing tests. Final `npm test`: **527 passed, 0 failed**.
- Targeted synthetic tests cover two hosted tenants with clients, requests and encrypted documents; tenant-specific quota separation; concurrent quota boundaries; exact ciphertext bytes; insufficient disk; aged interrupted staging cleanup; export completeness/integrity; restoration and decryption; non-owner denial; session/link revocation; retention/holds; interrupted purge retry; unrelated tenant preservation; and self-hosted compatibility through the existing full suite.
- `npm run check:docs`, `check:style`, `check:nav`, `check:site`, `snapshot` plus `check:pages`, and `check:gateway` all pass. The snapshots contain 42 core pages and 14 hosted gateway pages; every page passes structural/accessibility checks.
- `npm run coverage`: **90.93% lines, 74.89% branches, 88.92% functions**. The unchanged configured thresholds are 93%, 75%, and 90%; the gate therefore fails by 2.07, 0.11, and 1.08 percentage points respectively. The baseline was already below the line/function thresholds. Remaining gaps are concentrated in broader existing routes and CLI error paths; coverage thresholds were not lowered.
- `npm run check:container` did not verify a container: the local Docker Desktop API pipe was absent, and the script's default `localhost:3000` returned HTTP 500. This is not a Docker deployment result. The HTTP application flows did pass in the 527-test suite, including hosted authentication, TOTP, invitations, uploads, export and restore.
- `docker info` confirms the daemon is unavailable in this environment. No production deployment or customer data was used.
- The original checkout remains on its prior branch with its pre-existing `docs/go-succeed-prep.md` change untouched.

The final report commit SHA, pushed branch head and remote verification are recorded by the task completion response because a commit cannot embed its own SHA without changing that SHA.

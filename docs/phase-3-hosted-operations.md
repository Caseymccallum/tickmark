# Tickmark hosted operations, backup and recovery

**Scope:** Phase 3 operational foundation. This is a single-host design for the hosted Node/SQLite service. It records local synthetic evidence and external checks that remain outstanding; it does not claim a production deployment.

## 1. Architecture and deployment decision

Hosted Tickmark is one Node.js process. The SaaS registry is a synchronous `node:sqlite` database. Each tenant has its own SQLite database and encrypted-blob directory beneath the data root. The application opens databases synchronously and its authentication limiter is process-local. Phase 2 storage admission checks available disk space, but concurrent processes can race those checks. SQLite WAL improves normal operation, but a recursive live file copy is not a cross-database snapshot.

Run one Linux VM, one app process, and one durable local filesystem volume for `saas.db` and `tenants/`. A reverse proxy on the same host provides public TLS and forwards only to loopback. Use systemd for app supervision and the supplied timers for backup and maintenance. Do not run multiple app processes, replicas, or hosts against a shared SQLite filesystem. Horizontal scale needs a shared rate limiter, atomic storage reservations, and a database/storage redesign first. Stripe webhooks need a stable public HTTPS route to this process; SMTP egress is an external dependency. There are no application background workers that must run continuously.

Keep registry and tenant files on one durable ext4/XFS data volume; mount it with restrictive ownership and a tested filesystem. Use filesystem snapshots only as an additional layer, never as the off-host backup. Put temporary backup staging on a private filesystem with enough free space. Never put credentials in the source tree or a container image.

## 2. Host and network requirements

- Supported Node.js: 24 or later. Install security updates for the OS and Node runtime on a maintenance window; rebuild and redeploy the container image from a reviewed source revision when using containers.
- Create a dedicated `tickmark` Unix user/group. App files are root-owned and read-only to the service; `/var/lib/tickmark` is owned by `tickmark`, mode 0700. Unit files use `UMask=0077`, `NoNewPrivileges`, a private `/tmp`, and systemd filesystem protection.
- Permit inbound 80/443 only to the proxy and SSH only from the operator's restricted administration path. Bind the app to loopback or a private container network. Do not publish port 3000 to the Internet.
- Set `MULTI_TENANT=1`, `TICKMARK_DATA=/var/lib/tickmark`, `PORT=3000`, the public URL/domain, Stripe secrets only when billing is intentionally configured, and SMTP settings only when mail is configured. Use root-readable `/etc/tickmark/tickmark.env` with mode 0600; systemd loads it. Backup credentials live separately in `/etc/tickmark/backup.env`, mode 0600, readable only to root. The backup wrapper imports it and passes credentials by environment, never by command-line arguments.
- Configure exactly the immediate trusted proxy peers in `TICKMARK_TRUSTED_PROXIES`. The proxy must replace forwarded client headers; never trust arbitrary client-supplied `X-Forwarded-For`.
- Encrypt the host's data volume or use provider block-volume encryption; application ciphertext does not encrypt email addresses, billing references, TOTP configuration, sessions, or other metadata. Restrict SSH and console access, keep host security updates current, and monitor provider maintenance notices.
- Set an incident contact and keep recovery instructions plus the Restic password/repository recovery material in a separate, access-controlled password manager or offline escrow. The only operator must have a recovery delegate or a tested way to regain those credentials. Losing the Restic password can make every backup unrecoverable.

### Reverse proxy and TLS

Prefer Caddy with automatic HTTPS and no access-log directive for the smallest deployment. If using nginx, do not log bearer-link paths, cookies, request bodies, or full query strings. A minimal HTTP-to-HTTPS and proxy shape is:

```nginx
map $uri $tickmark_loggable {
    default 1;
    ~^/(r|invite|verify|reset)/[^/]+ 0;
}
server {
    listen 443 ssl http2;
    server_name tickmark.example.com;
    # Install/renew certificates with the host's supported ACME client.
    access_log /var/log/nginx/tickmark.access.log combined if=$tickmark_loggable;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
```

Also omit request bodies and authorization/cookie headers from proxy error logs and third-party monitoring. Validate the configuration before reload (`nginx -t`); monitor certificate expiry and verify renewal with the ACME client. TLS termination, HSTS policy, DNS, and certificate renewal are host responsibilities and have not been exercised against a public hostname in this phase.

## 3. Container build and verification status

`Dockerfile` uses `node:24-alpine`, copies only package metadata, `src/` and `web/`, and runs as the non-root `node` user. `.dockerignore` excludes local data, secrets, tests, docs and repository metadata. Compose binds to loopback, mounts a persistent volume, enables a read-only root filesystem, provides a small no-exec `/tmp`, drops capabilities, blocks privilege escalation, and has a database-aware `/healthz` check. SIGTERM shutdown is supported by the app and compose allows 30 seconds.

Build and run locally:

```sh
docker compose build
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
docker compose stop
docker compose start
```

For hosted mode, set `MULTI_TENANT=1` and `TICKMARK_DATA=/data` in an untracked `.env` file before start. A writable `/data` volume is required. Do not place hosted backup credentials in the app container. Image scanning, migration-from-old-image testing, volume persistence, and container backup/restore are required checks before adopting this optional container path.

**Docker result: NOT VERIFIED.** The Docker CLI is installed, but Docker Desktop's engine pipe was absent, so no image build, container start, volume persistence, or container shutdown test could run. This is an environment limitation, not a reported application defect. The real HTTP application fallback and synthetic hosted restore drill are tested below. Do not advertise the container checklist as passed.

## 4. Off-site backups

### Mechanism and consistency

Use Restic, an established backup program with repository encryption and authenticated data, targeting an operator-selected supported repository (for example, a separate machine or object-storage provider). No provider is mandatory. Configure `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, and the selected backend's credentials in `/etc/tickmark/backup.env`. The password file must be a non-empty regular file and, on POSIX, mode 0600 or stricter. Keep repository access credentials and the password recovery copy separate from the primary host. Rotate access credentials using the provider's documented process; rotate the Restic password only with a tested repository migration procedure and retain the old recovery key until migration verification.

`tools/hosted-backup.mjs` refuses to run while `/healthz` answers, takes an exclusive lock, checks staging free space, creates a private temporary local fleet backup with `tools/backup-all.mjs`, confirms the manifest is complete, uploads the directory through Restic, applies retention only after upload succeeds, checks the repository, and confirms the new snapshot before writing success status. It stores no Restic secret in argv. The fleet tool takes SQLite-safe snapshots of the registry, every active tenant DB, and every referenced encrypted blob; manifests contain format/version, database/blob integrity metadata, tenant IDs and deletion/hold metadata.

The scheduled wrapper stops the app service before invoking the fleet snapshot and restarts it if it was running. Maintenance follows the same stop-and-restart approach. This creates a short write outage but gives one cross-file recovery point: uploads, invitations, membership, quotas, key envelopes, and deletion cannot change between individual database snapshots. A direct `backup-all` copy is useful as a local diagnostic, but it does not establish this cross-database quiescence guarantee. A host crash during backup produces a failed job or no fresh status; the previous off-site snapshot remains available, but RPO increases.

### Schedule and commands

The supplied systemd timers schedule backup daily at 02:00 with a randomized delay up to ten minutes and maintenance at 03:00 with the same delay. Persistent timers catch up after host downtime. Both wrappers take `/run/lock/tickmark-hosted-operations.lock`; the Node tools also use a data-volume exclusive lock, so overlapping jobs fail visibly rather than interleave. The common 26-hour freshness check tolerates the scheduled random delay but alerts after a missed cycle.

```sh
# Manual, while the service is stopped; source credentials from the protected environment file.
sudo systemctl stop tickmark.service
sudo bash -lc 'set -a; . /etc/tickmark/backup.env; set +a; runuser -u tickmark -- node /opt/tickmark/tools/hosted-backup.mjs'
sudo systemctl start tickmark.service

# Preferred manual wrapper: it locks and stops/restarts an active service itself.
sudo /opt/tickmark/ops/tickmark-hosted-backup.sh
sudo systemctl start tickmark-hosted-backup.timer tickmark-hosted-maintenance.timer
sudo systemctl list-timers 'tickmark-hosted-*'
sudo journalctl -u tickmark-hosted-backup.service --since today
```

The first command is for supervised manual use; use the wrapper to avoid forgetting service restart. Check the service state after any failed run. A failed upload or verification never prunes snapshots. The backup staging directory contains a temporary *plaintext* backup bundle of databases and ciphertext blobs; it is private, same-host, short-lived, and must be removed before success is reported. Staging capacity preflight currently requires 1.1× the source tree plus 256 MiB. Provider quota/capacity is not a portable Restic API, so monitor remote repository/provider capacity separately; alert on provider quota and on any Restic command failure.

### Verify status and snapshot integrity

```sh
sudo systemctl status tickmark-hosted-backup.service
sudo -u tickmark node /opt/tickmark/tools/hosted-backup.mjs --check-status
sudo -u tickmark node /opt/tickmark/tools/hosted-status.mjs --data /var/lib/tickmark
# With credentials from the protected environment file:
node tools/backup-all.mjs --verify <restored-or-exported-fleet-directory>
restic -r "$RESTIC_REPOSITORY" check
```

The hosted backup status is written atomically to `/var/lib/tickmark/hosted-backup-status.json`; it records success/failure, time, duration, snapshot id, aggregate counts and retention deferral. Alert on a nonzero timer/service result, missing/failed status, status older than 26 hours, repository check failure, insufficient local staging/data disk, or provider capacity warning. Keep host monitoring outside Tickmark; the tool emits machine-readable JSON on stdout/stderr and systemd captures it in the journal.

## 5. Restore and disaster recovery

### Restore procedure

Use a clean, patched replacement host and a fresh data path. First restore Restic access from the protected recovery store; verify the repository without exposing secrets. Stop public traffic and keep the app stopped. The target directory must not exist, and staging must be on the same filesystem as its parent for atomic promotion.

```sh
sudo systemctl stop tickmark.service
sudo install -d -o tickmark -g tickmark -m 0700 /var/lib/tickmark.restore-parent
# Set RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE and provider variables via protected env.
sudo -u tickmark node /opt/tickmark/tools/restore-hosted.mjs \
  --snapshot latest \
  --to /var/lib/tickmark.restore-parent/data \
  --staging /var/lib/tickmark.restore-parent
# Inspect restore.completed fields and application configuration; keep public traffic blocked.
# Move/promote the restored directory to the configured data path only after review.
sudo -u tickmark node /opt/tickmark/tools/hosted-status.mjs --data /var/lib/tickmark.restore-parent/data
```

`restore-hosted.mjs` lists only tagged hosted snapshots, selects one explicit snapshot, restores into private staging, rejects symbolic links/ambiguous fleet roots/unsupported manifests, runs the local fleet integrity verifier, copies into a fresh data layout, and reads the **latest** snapshot's deletion ledger even when restoring an older point. It merges tombstones first, marks matching tenants as deleted, and idempotently finalizes completed deletions before atomically promoting the new data directory. It never starts the service. Review output and prove health/login before directing traffic. For an older snapshot, recovery point age is measured from its timestamp; the newest deletion ledger prevents resurrection but cannot recover later active-tenant writes.

Do not restore over a populated live directory. Retain the failed primary disk read-only for investigation and evidence. Record incident time, selected snapshot ID/time, recovery-point age, restore duration, schema/runtime version, operator, and validation results. Require a second operator's authorization before using a snapshot that predates a deletion or legal hold; keep the service offline until the newest deletion ledger has been applied and the affected tenant list has been reviewed. Normal tool flow is fail closed if the latest ledger is unavailable or malformed.

### Synthetic recovery evidence and limits

`test/hosted-restore.test.js` creates a two-practice hosted registry and tenant files, takes a complete local fleet snapshot, offboards one synthetic tenant, takes a later snapshot, restores the earlier one through a Restic-compatible fake adapter, and applies the newest deletion ledger. It asserts the erased tenant and its directory are absent, the surviving registry relationship and database remain, and the tenant-history tool identifies the earlier containing snapshot. The recorded final focused run selected synthetic snapshot `11111111` at `2026-10-21T05:00:00Z`; its recovery-point age was **88,325,035 ms (about 24.5 hours)** and restore-wrapper duration was **406 ms**. These figures describe a tiny local fixture and fake adapter only; they are not an RPO/RTO or throughput guarantee. The test separately exercises full restore flow, manifest/blob verification, and delete replay. It does **not** yet exercise real hosted sign-in, TOTP, invitation/request-history replay, or owner decryption after full-host promotion; these remain an additional drill before launch. A separate fleet backup test creates a real encrypted document in each of two practices, verifies the bundle, and decrypts one copied envelope with the practice's private key, but that is not the same as decrypting after the hosted restore tool runs.

No production RPO or RTO is promised. With a successful daily backup, the nominal worst-case recovery point is near one day plus outage/verification time, but an outage or failed backup extends it and the 26-hour alert is an operational threshold, not a guarantee. Restoration time depends on repository size, network, provider throttling, disk, and operator response; it has not been measured against a real remote repository. Run quarterly restore drills (and after storage, schema, or backup changes) and record real durations.

## 6. Retention and deletion propagation (F-06/F-14)

Normal Restic retention is 35 days, with `forget --keep-within 35d --prune`; older snapshots can be removed only after a successful new off-site backup. An active retention hold in any fleet record disables expiry of the **entire shared repository**. Invalid hold metadata fails closed before expiry. A failed/incomplete backup never runs prune. A hold is therefore safe but can grow remote storage without bound; alert and require operator review of holds and repository capacity. Clear a hold only through the existing authorized lifecycle workflow and documented approval.

`node tools/backup-tenant-history.mjs --tenant <uuid>` reads each tagged snapshot's encrypted fleet manifest and reports earliest/latest snapshots containing the tenant, active hold state, and whether copies fall outside the normal window. It is read-only. A snapshot holding the deleted tenant cannot be selectively edited without replacing a full shared recovery set and potentially harming recovery of other tenants. Deleted customer ciphertext therefore remains in shared backups until the normal retention window expires; any active legal/retention hold extends it. The intended contract description is bounded *eventual* deletion, normally no later than 35 days after the last containing successful snapshot ages out, plus any hold or backup failure delay. It is not immediate erasure. Validate provider versioning/soft-delete policies separately because provider-side retention can extend this period.

Irreversible tenant purge now requires a readable, successful off-site status no older than 26 hours. If the status is absent, malformed, stale, or failed, deletion does not proceed. This creates a safe dependency on a fresh fleet recovery point, while Restic's existing snapshots still retain the deleted data. The latest deletion ledger is retained in future fleet manifests; a restore uses it before starting service. A tenant-history lookup is evidence for an operator and never performs expiry by itself. Keep at least one recent complete snapshot of all surviving tenants; never use per-tenant deletion as a reason to prune shared snapshots early.

For exceptional recovery: pause service and public traffic, obtain two-person approval where available, choose the target snapshot, restore through the guarded tool, verify the newest deletion ledger and tenant status, confirm legal holds, and document why a deleted tenant must remain absent or be reactivated. This tool intentionally does not provide an override that silently changes deleted state.

## 7. Monitoring and structured logs (F-12)

Run `node tools/hosted-status.mjs --data /var/lib/tickmark` from host monitoring. It checks HTTP `/healthz`, registry reachability reported by the app, free bytes on primary storage, backup freshness/status (26-hour default), and latest successful maintenance status (30-hour default). It returns no tenant IDs, names, document metadata, or document contents. Existing quota reports are run per tenant by maintenance; the aggregate maintenance status records a count of tenants at or above 80% quota, not their identities.

Alert on:

| Signal | Severity | First response |
| --- | --- | --- |
| `/healthz` fails or registry cannot be read | Page | Check `tickmark.service`, recent deploy, DB/disk errors; keep traffic closed until healthy. |
| Primary free space below 512 MiB or volume alert | Page | Stop uploads if necessary, expand/repair the volume, preserve database and WAL files; never delete tenant data to free space. |
| Backup status failed/unknown or age >26 hours | Page | Read systemd journal and status; confirm destination credentials/capacity; restore backup schedule only after integrity passes. |
| Maintenance service failed or status older than 30 hours | Urgent | Review status/journal, inspect lock owner, retry dry run; use `--apply` only after reviewing pending lifecycle actions. |
| Tenant quota at/above 80% | Warning | Contact the tenant through the normal support process; inspect aggregate quota report without opening document contents. |
| TLS certificate due within 14 days/renewal failed | Urgent | Check DNS, ACME logs and proxy config; renew and verify HTTPS before expiry. |
| Repeated authentication failures / rate limiting | Warning or page by volume | Inspect aggregate counts/source IP controls; do not log passwords, cookies, or bearer tokens. |
| SMTP delivery failure | Warning | Check relay reachability, TLS/auth configuration and journal; log kind/error only, never address or message body. |
| Restore drill overdue or failed | Urgent | Schedule a synthetic or provider-backed restore before asserting recoverability. |

The app's `src/log.js` writes one structured JSON event per line and strips credential-keyed fields, bearer-token route paths (`/r`, `/invite`, `/verify`, `/reset`) and common secret query parameters. Access logs omit `/healthz`; proxy examples omit token-bearing paths. Do not enable request-body, cookie, authorization, or document logging in proxies, APM, mail relay, or support tooling. The app does not inspect encrypted documents for monitoring. Email recovery-mail send failures now produce `mail.delivery.failed` with mail kind and failure category, without recipient, relay response text, message body, or link.

Incident response: (1) stop public traffic and preserve host/disk/log state; (2) determine scope without opening customer documents; (3) rotate compromised host/provider credentials from a clean host and revoke sessions where required; (4) restore into a fresh isolated volume and apply the newest deletion ledger; (5) validate health and obtain owner/operator review before traffic resumes; (6) record facts, customer impact, notification decisions, and corrective actions. Incident contact: the named Tickmark operator in the private deployment record. Configure an external contact and escalation route before the first paying customer.

## 8. Maintenance and lifecycle jobs

The 03:00 timer runs the same exclusive-lock, stop-the-app wrapper and calls `tools/hosted-maintenance.mjs --apply`. It runs pending-payment retention reaping, deletion finalization, upload reconciliation for each tenant (24-hour orphan age), and quota reports sequentially. Each CLI's own safe/dry-run behaviour remains available; direct `node tools/hosted-maintenance.mjs` defaults to dry-run. Use `--apply` only after inspecting the dry-run result. Each run atomically writes `/var/lib/tickmark/hosted-maintenance-status.json` and emits a summary. Failed jobs yield nonzero status and a monitorable failure event; retries are designed to be idempotent. Tenant deletion holds are respected by finalization. Purging is gated on a fresh off-site backup; external backup unavailability never triggers deletion.

There are two locks: host-level `flock` serializes systemd wrappers across hosts only if they share that lock filesystem (this recommended topology is one host); a data-directory exclusive file lock prevents overlapping Node operations on that data root. Do not mount one SQLite data volume concurrently on multiple hosts. A stale lock is not automatically removed: verify that its process is gone and no job remains before manual cleanup. Manual use: `sudo /opt/tickmark/ops/tickmark-hosted-maintenance.sh`; inspect `systemctl status`, journal, and status JSON; then dry-run again before retrying a failed destructive operation.

Pending-payment cleanup must be reviewed against its existing grace-period/legal-hold settings. Upload reconciliation only removes aged unreferenced temporary upload files. The scripts never send mail or contact customers. The maintenance status stores outcome details for operator audit and is mode 0600; restrict access to that volume.

## 9. Security and threat boundaries

| Threat | Main control and remaining exposure |
| --- | --- |
| Host compromise/ransomware | Dedicated least-privilege service user, read-only app filesystem, encrypted off-host repository, separate credentials and volume encryption. A fully compromised live host can still read registry metadata and delete local data; off-host credential separation and provider immutability/versioning are operator choices. |
| Stolen backup credential | Repository password plus provider credential live outside repo/source and are least-privileged. Use provider-side MFA, restricted repository access, and immutable/versioned storage where available. |
| Lost recovery credentials | Offline/password-manager escrow and periodic recovery drill. Without the Restic password data is lost even if the repository survives. |
| Corrupt/tampered snapshot | Restic repository check, authenticated chunks, fleet DB/blob hash manifest and verification during restore. Real provider integrity checks remain to be exercised. |
| Disk exhaustion | Storage admission, staging preflight, status monitor, host capacity alerts. Phase 2 admission remains best-effort under concurrent writes; one process and a safety margin are required. |
| Bad migration/deployment | Keep prior reviewed source/image, backup before upgrade, test representative migration in disposable environment, retain prior data volume read-only for rollback. Docker migration test is outstanding. |
| TLS/proxy/log mistake | TLS-only public route, loopback app binding, explicit trusted proxy peers, bearer path log omission, renewal alert and external TLS check. Public proxy not verified in this phase. |
| Unauthorized restore/deleted tenant resurrection | Offline restore, fresh target, latest deletion-ledger replay, fail-closed manifest validation, operator approval and no auto-start. Restoring active tenants to an older point still loses later writes. |
| Admin route or account abuse | Existing role checks, TOTP and rate controls; process-local limiter is why one app process is required. Keep administrative shell access limited. |

Backups contain the registry, account email/session hashes, billing references, TOTP metadata, tenant DB metadata, and encrypted documents. Restic encryption is mandatory; app-level encryption alone is not an adequate backup protection claim.

## 10. Capacity findings and initial guardrails

Phase 3 uses bounded preflight rather than claiming throughput from tiny restore fixtures. Backup traversal rejects symbolic links and more than 100,000 files; staging requires source size ×1.1 plus 256 MiB. The service status threshold defaults to 512 MiB free, and deletion batches default to 100. The existing single-tenant `node tools/bench.mjs 100` was run locally: creating 100 synthetic clients/requests and 100 placeholder file rows took 703 ms; page medians ranged from 11 ms to 16 ms and worst samples from 15 ms to 21 ms on this workstation. This benchmark measures UI reads only and does not measure encrypted upload throughput, hosted concurrency, SQLite contention, backup duration, resource use, or remote storage growth. Existing tests cover isolated concurrent quota reservations and insufficient-space refusal. These are safety rails, not a tested production capacity limit. SQLite writes remain serialized per database; large exports and backup stop windows grow with dataset size. The test restore uses two synthetic tenants and tiny fixtures and is not representative of tenant throughput or repository growth.

For a first host, start with a single modest VM (at least 2 vCPU, 4 GiB RAM, and separately expandable durable storage) and a separately capacity-monitored off-host Restic repository. This is a cautious starting configuration, not a validated sizing guarantee. Set an operator-defined initial ceiling (for example, 50 active practices and 100 GiB of primary data) and revisit it using real resource telemetry before raising it. Do not promise upload throughput, export latency, maximum fleet size, backup duration, or restore time yet. Before launch, benchmark concurrent encrypted uploads, reservation contention, quota scans, large exports, tenant-count maintenance, backup window, and restoration on the actual selected VM/filesystem/provider. Capture CPU, RSS, I/O, disk growth, and failure/retry behaviour.

## 11. Verification record and launch dependencies

Final `npm test` passes **538 tests, 0 failed**. `npm run coverage` leaves the existing 93% line / 90% function / 75% branch gates unchanged and reports **90.93% lines, 88.19% functions, 73.58% branches**, so the coverage gate remains below all three thresholds. The focused operational tests, docs/style checks, 42-page HTTP snapshot check, synthetic hosted `/healthz` HTTP smoke, and fake-adapter restore drill pass. The 100-client benchmark is reported above. Docker/Restic remote-provider validation and public TLS checks are not run because the Docker daemon and provider credentials/backend were unavailable. No production host, customer data, paid provider account, or live Restic installation is used in this phase.

### Phase finding classification

- **F-08 — PARTIALLY FIXED.** Quiescent fleet capture, Restic wrapper, integrity verification, freshness state, restore tooling, and synthetic deletion-aware restore pass locally. Real remote-provider backup, actual encrypted remote restore/decryption after promotion, and Docker deployment remain unverified.
- **F-12 — PARTIALLY FIXED.** Sensitive structured-log redaction, recovery-email failure categories, service/storage/backup/maintenance status and alert guidance are implemented. External alert delivery, public TLS expiry monitoring, and a production restore-drill register still require operator setup.
- **F-06 — PARTIALLY FIXED.** 35-day shared expiry, tenant snapshot inventory, hold-aware prune suppression, fresh-backup purge gate, and tombstone replay are implemented and tested with synthetic metadata/fake Restic. Real repository expiry and provider-side versioning/soft-delete behavior remain to validate; deletion from backups is eventual, not immediate.
- **F-14 — PARTIALLY FIXED.** Scheduled maintenance wrapper/timer runs conservative lifecycle and reconciliation jobs with locking/status, but the timer has not been installed or exercised on an operator Linux host.

Remaining before hosted commercial launch:

1. Choose a Linux host, public domain, reverse proxy/TLS and incident contact; configure least-privilege access and host/volume encryption.
2. Choose an off-host Restic backend, install and pin Restic, provision MFA/restricted credentials, test provider capacity alerts and credential rotation, and complete a real remote restore/decryption drill.
3. Extend synthetic full recovery evidence to real app sign-in, TOTP recovery semantics, staff invitations/membership, request history and owner-side ciphertext decryption.
4. Verify old-schema migration and volume restart using the selected container/host method; complete Docker build/smoke tests if container deployment is selected.
5. Configure external process, storage, backup-age/failure, maintenance, quota, TLS expiry and SMTP alerts; rehearse incident response and confirm the contact route.
6. Run representative capacity/backup-growth benchmarks and set contractual retention wording, restore objectives and support commitments from observed operation.

Until these steps have evidence, Phase 3 is an operational foundation, not a production assurance or a commercial recovery SLA.

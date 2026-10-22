# Deployment readiness

Self-hosted mode is one Node process, SQLite DB and local blob directory; the practice owns TLS, backups, restore, mail, monitoring, disk and upgrades. Hosted mode shares process, host, disk, operator and outage domain across tenants despite separate per-tenant DB/blob directories.

Dockerfile uses Node 24 Alpine, copies web assets, runs as unprivileged node. Compose defines volume, restart policy and database-aware healthcheck. Docs provide reverse proxy/TLS, health monitoring, logs and cron backup recipes. These are guidance, not configured infrastructure.

No verified hosted domain/DNS/TLS, Stripe account/price, email DNS, alert route, remote backup, restore drill, storage threshold, status/support channel or incident process was evidenced. Container probe failed to establish a valid local run. Local SQLite/files are not a multi-instance/rolling deployment protocol. Process-local throttles do not coordinate. Must set canonical TICKMARK_PUBLIC_URL and constrain proxy headers. Secrets require secret manager/access rotation. Upgrades are forward-only; backup before migration.

Before real documents: HTTPS origin/cookies, log redaction of token paths, backups/alerts/restore, aggregate quotas, incident/support contact, DPA/privacy/subprocessor/location/retention terms, and real provider test-mode billing/mail. Do not test with production customer data.

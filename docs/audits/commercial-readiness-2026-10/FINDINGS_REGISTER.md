# Findings register

Effort estimates assume prerequisites and are not promises. Source fixes were not implemented.

| ID | Priority | Evidence / reproduction | Impact | Fix and verification | Effort |
|---|---|---|---|---|---:|
| F-01 | P1 auth | **src/tenancy/gateway.js:handleLogin** has no limiter; repeated invalid /login POST runs password verification. | Credential guessing and CPU/memory exhaustion affects all tenants. | Account+source throttle; test threshold, expiry, success and multi-instance model. | 1–2 d |
| F-02 | P1 access | **bridgeIntoTenant** refuses session if TOTP on, then directs to /signin; gateway redirects /signin to /login and has no challenge. | Enrolled hosted member cannot re-authenticate. | Implement tenant-bound challenge/recovery; test TOTP/replay/removal/session. | 2–4 d |
| F-03 | P1 onboarding | **members-views.js** creates tenant practitioner only; no SaaS account/member; resolver index gets request links only. | Invite may not resolve; accepted user cannot later log in normally. | Transactional hosted invite/account/membership claim; test mapped/path host, replay, expiry, roles and repeat login. | 2–4 d |
| F-04 | P1 commercial | Stripe checkout lacks trial config while site/README promise 14-day no-card trial. | Unexpected immediate charge/misleading offer. | Implement exact trial or remove claim; test with Stripe test account. | 1–2 d + external |
| F-05 | P1 availability | Per-file/request limits only; no tenant/global disk cap. | Shared disk exhaustion disrupts every tenant. | Aggregate quota/alerts and refusal tests. | 2–4 d |
| F-06 | P1 data rights | No hosted tenant export/delete/offboarding/backup-retention flow. | Cannot reliably meet customer retrieval/deletion expectations. | Verified export/offboarding/expiry runbook and tests. | 3–6 d |
| F-07 | P1 legal | No hosted privacy/DPA/subprocessor/location/incident package found. | Firms may not be able to approve processing. | Legal review and publish terms/process. | 1–3 weeks |
| F-08 | P1 recovery | Backup scripts exist but no configured off-host schedule/alerts or deployed restore evidence. | Server failure may lose customer records. | Configure, alert, protect and rehearse restore; record RPO/RTO. | 1–3 d + drill |
| F-09 | P1 billing | Webhook has no event-ID ledger/order guard; invoice success sets active directly. | Replayed/stale events can misstate subscription access. | Idempotency/order-aware updates; replay/out-of-order tests and Stripe drive. | 2–4 d |
| F-10 | P2 data | Blob rename precedes DB insert; interrupted operation leaves orphan. | Storage waste/cleanup burden, not demonstrated data loss. | Orphan reconciliation with age guard/tests. | 1–2 d |
| F-11 | P2 security | Browser preflight is advisory; ciphertext cannot be malware-scanned server side. | Unsafe/incorrect content may reach staff endpoint. | Clear claim and safe opening/endpoint procedures; test attachment handling. | 1–2 d |
| F-12 | P2 observability | Process-local limits; no host alert wiring; proxy may log bearer URLs. | Incidents/links may be missed or exposed in logs. | Redaction, shared limiter if replicated, alerts. | 1–3 d |
| F-13 | P2 UX | Static checks pass; no manual screenreader/mobile audit. | Barriers may remain. | Manual WCAG/mobile tests with users. | 2–3 d |
| F-14 | P2 lifecycle | Abandoned pending-payment tenant directories are not reaped. | Orphaned metadata/storage accumulates. | Retention/reaper aligned to export/deletion policy. | 2–4 d |

No confirmed cross-tenant document disclosure or crypto plaintext exposure found. No P0 exploit confirmed. Real-document pilot remains blocked by combined P1 issues.

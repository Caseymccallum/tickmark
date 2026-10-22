# Security and privacy audit

Scope is source review and existing tests at audited commit. No production scanning, customer data access, independent penetration test, or crypto certification.

Assets include endpoint plaintext, encrypted envelopes, wrapped keys, credentials/session tokens, visible metadata, tenant registry/billing, OAuth credentials and backups. Actors include internet user, client link holder, removed/malicious member, other tenant, compromised operator/browser, host/provider and external service account.

## Controls observed

Tokens are random and stored hashed; sessions expire/revoke; cookies are HttpOnly, SameSite=Lax and Secure by default. Passwords use scrypt; recovery links are single-use; TOTP and recovery codes have replay/attempt protections. **src/app.js** centrally checks route roles. Store queries scope by practice; SaaS opens per-tenant DB/blob files. Uploads stream, use generated paths, validate envelope and enforce per-file/request limits. HTML escaping, security headers and CSV formula guarding exist. SMTP TLS is tested.

## Findings

See FINDINGS_REGISTER.md for reproduction, impact, fix and regression checks.

1. Hosted login has no throttle: **src/tenancy/gateway.js:handleLogin** runs password verification without budget.
2. Hosted TOTP re-authentication dead-ends: gateway suppresses tenant session when TOTP is armed, then directs user to /signin; gateway redirects /signin to /login and exposes no challenge.
3. Hosted invitations are not integrated with account/membership registry: core creates practitioner, but no SaaS account/member; public invite resolver index only records request links.
4. No tenant-wide storage quota: a tenant can consume shared disk through many bounded requests.
5. No customer-specific hosted export/delete/retention workflow.
6. No hosted DPA/privacy/subprocessor/incident package was located; processor/controller roles depend on actual purposes and contract.
7. Trial is not configured in Stripe checkout although advertised.
8. Backup schedule/alerts/remote retention are instructions, not provisioned service.

## Cross-tenant assessment

**src/tenancy/resolve.js** resolves token/host to tenant; **pool.js** opens only that tenant’s database; store calls scope queries by practice. Existing **test/tenancy.test.js** and **test/saas.test.js** test two-practice isolation; full suite passed. No user-controlled DB/blob path was found. This is credible design evidence, not proof against host compromise or a penetration test.

## Important limitations

Anyone holding a live client link can upload; filename, MIME, size, request association and time are visible. Server cannot malware-scan encrypted plaintext. Browser extensions, injected JS or malicious origin can see plaintext/passphrase. Provider OAuth tokens are stored readable. Proxy access logs should redact bearer URLs. TICKMARK_INSECURE_COOKIES=1 is not for public service. Rate limits are process-local.

## UK privacy obligations

Practice typically determines purposes for client accounting records; hosted operator may process those records as processor and is controller for its own accounts/billing/security. Confirm actual roles with legal advice. Before hosted real data, prepare contract terms, instructions/security, subprocessor and location disclosure, rights assistance, breach cooperation, retention/deletion/return, backup expiry and access review. ICO sources are in SOURCES.md. No statutory compliance claim is made.

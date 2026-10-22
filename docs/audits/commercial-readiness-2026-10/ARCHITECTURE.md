# Architecture

## Shape

Browser practice/client ⇄ built-in Node HTTP server ⇄ SQLite practice database and local blob files. Browser performs ECDH/AES-GCM encryption; server stores encrypted envelope plus readable metadata. Hosted mode adds Stripe gateway, a registry DB and resolver/pool selecting an isolated tenant DB/blob directory.

## Components

- Runtime: Node 24, built-in http/sqlite/Web Crypto; **package.json** has no dependencies.
- Entry/routing: **src/server.js**, optional **src/tenancy/entry.js**, explicit route table and role check in **src/app.js**.
- Schema/migrations and queries: **src/db.js**, **src/store.js**; WAL enabled.
- Uploads: streamed to disk in **src/client-portal.js**, random path IDs, filename as metadata.
- Auth: scrypt, digest-stored bearer sessions, secure HttpOnly/SameSite=Lax cookies, recovery links, TOTP.
- Tenancy: **src/tenancy/registry.js**, **resolve.js**, **pool.js**. Host or token selects one tenant DB; up to 64 DB handles are pooled LRU.
- Crypto: **web/tickmark-crypto.js**, **src/crypto.js**, key flows in **src/keys-views.js**.
- Mail/SMS: **src/mailer.js**, **src/sms.js**; tests use local protocol servers. External delivery is not proven.
- Billing: custom Stripe REST via **src/tenancy/stripe.js**, status mapping in **billing.js**.
- Operations: Docker files, health route, logs, benchmarks, backup/verify scripts; no app-provisioned scheduler/monitor/remote backup.

## Strengths

Per-practice files add a filesystem boundary in hosted mode; store methods also scope by practice ID. Route permissions are centralized. Ciphertext storage matches the key architecture. The app has thoughtful failure messages, migrations, streamed uploads, WAL-aware snapshot/verification and restore tests that decrypt a file. No dependency tree or rewrite need is apparent.

## Constraints

Tenants still share process, host, disk, operator and backups. Local SQLite/filesystem is reasonable for one practice and perhaps a controlled small pilot, not a multi-instance/high-availability design. Synchronous SQLite can block the event loop. Per-file and per-request caps do not cap aggregate tenant storage. Local rate limits do not coordinate across replicas. Host/proxy headers must be canonicalized; configure TICKMARK_PUBLIC_URL. Tenant path redirects do not preserve /t/slug prefixes; docs expect mapped production hosts. Xero/QuickBooks credentials are stored readable because server must call provider. Do not rewrite; fix readiness seams.

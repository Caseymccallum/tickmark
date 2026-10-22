# Tickmark commercial readiness audit

**Audit date:** 22 October 2026
**Repository:** Caseymccallum/tickmark
**Audited baseline:** main / origin/main, commit 2d1cd52770dd794986fcfb8a31121a07d91b9630
**Decision:** **REMEDIATION REQUIRED**

## Verdict

Tickmark is a capable, unusually well documented early product. Its core loop works: a practitioner creates a client request, shares a no-account link, receives an encrypted file, checks it, and chases outstanding items. The implementation has 506 passing tests, no runtime dependencies, browser-side ECDH/AES-GCM encryption, practice-scoped storage queries, separate SQLite/blob directories per hosted tenant, and backup/verification tools with restore tests.

It is **not ready to accept real sensitive documents as a paid hosted multi-tenant service**. Hosted sign-in has no rate limit; the advertised 14-day no-card trial is not configured in Checkout; hosted invitations do not provision platform accounts/memberships and cannot support normal repeat sign-in; and users with two-factor enabled are directed to a sign-in route that the hosted gateway redirects back to itself. Hosted service also lacks tenant-wide storage quota, customer export/deletion and retention operations, scheduled/monitored off-host backups, and a published privacy/DPA/subprocessor package. These are readiness gaps, not proof that one practice can read another’s data.

**Synthetic-data demo:** suitable now on a disposable local instance or verified TLS demo host.
**Private pilot with real client documents:** only after P1 controls in FINDINGS_REGISTER.md and LAUNCH_DECISION.md are resolved.
**Paid public launch:** after pilot evidence, operating/legal setup, and billing behaviour are verified against the actual Stripe account.

## Product today

A single-process Node 24 application with SQLite practice database and local blob files. It supports clients, requests/templates, public bearer links, encrypted uploads, item review, history, email/SMS reminders when configured, CSV exports, member roles/invitations, TOTP, key recovery and key rotation. Hosted mode adds a registry, separate DB/blob directory per practice, and Stripe gateway.

The strongest purchase hypothesis is: **“Stop chasing clients for paperwork: see what is missing, and give clients one simple link to send it.”** Browser-side encryption may differentiate for some buyers, but does not substitute for operational evidence.

## Shortest route to three customers

1. Use synthetic data to demonstrate and conduct ten discovery conversations with sole/small bookkeeping and accounting firms in County Down/Belfast.
2. Invite at most three qualified practices into a time-boxed pilot only after remediation gates. Start with synthetic/low-sensitivity documents; do not use genuine sensitive records until operator, contracts, backup and access controls are demonstrated.
3. Charge after a practice completes a real workflow, returns for a second request, confirms value and accepts written service/data terms. Test £19–£29/month first; validate £49 only after recurring use.

Three at £49 generate £147 MRR / £1,764 ARR before payment fees, VAT, hosting, storage, backups, support labour, acquisition, legal/accounting and tax. This is validation revenue, not founder income.

## Main evidence

- Hosted invitations: **src/tenancy/gateway.js**, **src/members-views.js**, **src/tenancy/resolve.js** and **src/tenancy/entry.js**.
- Missing trial: **src/tenancy/stripe.js:createCheckoutSession** has no trial parameter, despite README/site claims.
- Hosted login: **src/tenancy/gateway.js:handleLogin** verifies passwords without an attempt limiter.
- Customer lifecycle: backup tooling is strong, but tenant-wide export/deletion and storage quota are absent.
- Tests: 506 pass. Static checks pass. Container probe returned HTTP 500 from its assumed localhost endpoint, so Docker deployment remains unverified.

## Scope

Audit documentation only under this directory. No application source, production settings, customer data, deployment, release or billing account was changed. Existing edit docs/go-succeed-prep.md was preserved. Latest main SHA and remote were checked. No legal compliance determination or independent cryptographic certification is claimed.

## Documents

PRODUCT_MAP.md; ARCHITECTURE.md; SECURITY_AUDIT.md; ENCRYPTION_REVIEW.md; DATA_RELIABILITY.md; TEST_REPORT.md; DEPLOYMENT_READINESS.md; BILLING_AUDIT.md; COMPETITOR_RESEARCH.md; UX_ACCESSIBILITY.md; COMMERCIAL_MODEL.md; CUSTOMER_ACQUISITION.md; OUTREACH_DRAFTS.md; FINDINGS_REGISTER.md; REMEDIATION_ROADMAP.md; LAUNCH_DECISION.md; OPEN_QUESTIONS.md; SOURCES.md.

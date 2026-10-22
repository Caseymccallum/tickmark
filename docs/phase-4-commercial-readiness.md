# Tickmark Phase 4: commercial readiness and customer onboarding

**Status:** implementation and review draft; not a production launch approval. No live Stripe account, real customer, customer document, production host or outreach was used.

## Starting point and delivery

- Repository: `Caseymccallum/tickmark`
- Source branch and commit: `codex/tickmark-hosted-operations`, `5b88a4ca7929bf8f35113ca66616d2c9adf2b052`
- Work branch: `codex/tickmark-commercial-readiness`
- Audit branch remains unchanged at `codex/tickmark-commercial-audit`, `27aa759`
- Original checkout's pre-existing edit to `docs/go-succeed-prep.md` was preserved.
- New commits: `df10998` (durable Stripe event processing), `0d993b3` (hosted commercial claims), and the final documentation commit containing this report.
- Final branch head: this report's commit at the tip of `codex/tickmark-commercial-readiness`.

## Customer journey: implementation evidence

| Step | Current implementation | Customer-facing consequence / remaining gap |
|---|---|---|
| Marketing and price | `site/index.html` describes a checklist workflow, £49/month, payment at checkout, no trial and a 5 GiB hosted quota. | Customer demand and willingness to pay remain hypotheses. Hosting, support, provider and tax facts are still operator gates. |
| Signup | `/signup` creates a platform account and one pending tenant. The hosted page explains the recurring price and that the first charge is due at checkout. | With incomplete billing configuration, access remains pending and the page discloses that payments are unavailable. No customer gets an active workspace from browser state. |
| Checkout | Server verifies the active Stripe Price is GBP 4,900 pence recurring monthly before creating Checkout. Checkout explicitly collects payment details and requests no trial. | Requires valid test/live server keys and webhook secret; actual Stripe account setup was not independently tested. No live key was used. |
| Return from Checkout | Browser return only shows a “confirmation is still processing” notice. | Return URLs do not activate an account. Subscription webhook state controls access. |
| Subscription state | Signed subscription created/updated/deleted events drive pending, active, past-due and cancelled states. | No client-side field or return URL can grant access. An unexpected `trialing` state stays pending. |
| Encryption setup | Practice creates its private key in the browser. The practice needs to save its recovery information before sending requests. | Losing every usable key can make files permanently unreadable. The server sees names, contacts, filenames, request history, sizes and security metadata. |
| First request and client upload | Core workflow supports client records, checklists and a link that a client can open without a Tickmark account; uploads are encrypted in the client browser. | A link is a bearer capability. Client-device and browser integrity remain part of the protection. Mobile upload and browser compatibility require the selected-host test pass. |
| Staff | Invited practice members have their own membership and authentication; membership remains per tenant. | TOTP-protected users must complete the tenant-side second factor. Subscription state does not change membership or encryption keys. |
| Renewal / payment failure | Stripe subscription snapshots provide the canonical state. `past_due` has a 14-day grace period by default. | The period is read from `TICKMARK_PAST_DUE_GRACE_DAYS`; publish the operator's actual configured value. Invoice events alone do not reopen or close access. |
| Cancellation | Stripe subscription deletion closes practice access. A cancellation scheduled for period end stays active until Stripe sends the ending state. | Phase 4 left public client links active; Phase 5 closes that gap by suspending links outside the paid/grace window, retaining prior ciphertext, and allowing only unexpired/unrevoked links to resume after re-subscription. |
| Export / deletion | Operator-run ciphertext-preserving export, verification, restoration and offboarding tools exist. The deletion helper defaults to 30 days and Phase 3 backup retention is designed for 35 days. | There is no customer-facing export button on the billing wall. A support route, requester verification, delivery procedure, final retention window and backup deletion exceptions must be established before launch. |

## Claims-to-implementation review

| Claim | Source evidence | Phase 4 action / truth to publish |
|---|---|---|
| £49/month | `src/tenancy/commercial-config.js`; test/live Stripe Price is retrieved before Checkout. | Kept at £49. Checkout fails closed unless Stripe reports active GBP 4,900 pence/month recurring. No lower price or extra tier was introduced. |
| 14-day free trial; no card | Checkout previously used a normal paid subscription without trial configuration. | Removed from README and landing page. Payment details are required; first payment is due immediately; no free trial is offered. |
| Unlimited clients/requests/storage | Hosted default quota is 5 GiB per practice; upload ceiling is 25 MiB. No separate client or seat price is coded. | Removed “unlimited storage” and count-limit comparisons. State no per-client/seat charge only; state the 5 GiB hosted quota and file ceiling. |
| Encryption | `docs/encryption.md` and browser crypto paths show client-side encryption and practice-held key. | Public copy now describes encrypted document bytes, server-visible metadata, and browser/device limitations. It does not claim all hosted data is unreadable. |
| Cancellation | Stripe portal creates billing sessions; subscription state gates practice routes. Past-due grace is 14 days by default. | Explain paid-through cancellation timing, grace, paused access and that data is retained under the still-to-be-confirmed retention schedule. |
| Export and deletion | `tools/export-tenant.mjs`, `tools/verify-tenant-export.mjs`, `tools/offboard-tenant.mjs`; no self-serve route at billing wall. | Explain operator-assisted export/deletion after access ends. Publish a support contact and workflow before launch; a placeholder remains in marketing draft. |
| Support | No verified customer support address, hours, coverage or response target is configured. | No support SLA is promised. Fill the operator checklist and then publish the real route and hours. |
| Backups | Phase 3 designs coordinated Restic off-site backup and 35-day retention. Local synthetic/fake-tool drills passed; provider credentials and remote restore were unavailable. | Describe as an operational design, not a tested service guarantee. Real provider and restore checks remain a launch gate. |
| Self-hosted | Core installation and tenant import/export tools exist. Container image and volume lifecycle were not run because Docker engine was unavailable. | Landing page distinguishes core workflow from optional providers and identifies Docker as unverified. |
| VAT / invoices | Stripe/accountant configuration and supplier registration facts are unknown. | Removed the “no UK VAT” and USD pricing assertions. State that tax presentation must be confirmed before publication. |
| Competitor features and pricing | No primary-source competitor substantiation was part of this phase. | Removed unsupported competitor price, feature, purchasing and security comparisons. |
| Legal / GDPR | Code and operational docs exist; final entity, provider, region, transfers, support and deletion details are unknown. | Drafts are labelled for legal review. Do not call Tickmark compliant, certified, audited or production-tested. |

## F-04: trial and price decision

| Option | Assessment |
|---|---|
| A. Genuine 14-day no-card trial | Not currently supported safely: Checkout has no trial configuration or expired-trial state; pending/active access, payment collection and transition behaviour are not implemented as a trial. |
| B. 14-day trial with a card | Possible only after a fully validated Stripe trial, cancellation, expiry and invoice lifecycle. It adds an automatic-charge risk that the current system does not explain or test. |
| C. Synthetic-data demo | Safe offer for a later controlled evaluation, but there is no separate demo tenant/reset flow yet. Do not call a paid Checkout a demo. |
| D. Remove trial claim | **Chosen for this phase.** It matches existing Checkout with the fewest new account and payment states. |

`COMMERCIAL_PRICE` remains £49 per practice per month. The server retrieves and checks the Stripe Price immediately before Checkout. It requires all Stripe settings; invalid or missing configuration prevents Checkout and no browser state can mark a tenant active. There is no request for or use of live account credentials in this work.

**F-04 classification: PARTIALLY FIXED.** The unsupported no-card trial promise is removed and Checkout configuration now verifies the stated recurring price and requires a payment method. The real Stripe test-mode lifecycle has not been independently run, so the connected Stripe experience remains unverified.

## F-09: event-processing model

`src/tenancy/stripe.js` reads and verifies the raw request body, checks the `Stripe-Signature` HMAC in constant time, enforces the 300-second timestamp tolerance and parses only after verification. Events must include an id, creation time, type and object.

`src/tenancy/billing.js` applies subscription state in the platform SQLite registry. The registry's `stripe_event` table stores event id, type, created time, outcome, optional tenant id and receipt/application time; raw event bodies and secrets are not stored. An immediate SQLite transaction surrounds association checks, the tenant update and receipt insertion. Duplicate delivery commits a no-op and reports a duplicate. If the update or receipt insert fails, the transaction rolls back and the HTTP handler returns 500 so Stripe can retry. Receipt/state cannot be split across a process restart.

Customer and subscription IDs must match the tenant's established association and cannot already belong to another tenant. A new subscription id is accepted only for an explicitly cancelled tenant re-subscribing under the same Stripe customer. Older subscription snapshots are recorded stale and do not change access. A same-second update cannot reopen a cancelled subscription. Checkout completion only binds identifiers; it never grants access. Signed subscription snapshots are authoritative. Invoice events are recorded as diagnostic hints; a paid invoice cannot reactivate a cancelled practice. Stripe must send a subsequent subscription update for payment recovery.

If a registry operation is uncertain, the processing transaction either committed both state and receipt or rolled both back. A rollback returns a retryable 500. A stale event is recorded and ignored; the later authoritative subscription snapshot must be present. If current Stripe state and local state disagree, the operator must reconcile through Stripe test/live dashboard and an audited support procedure before changing tenant state. A dedicated operator reconciliation command remains a Phase 5 improvement.

**F-09 classification: FIXED for ordinary webhook replay, order and tenant-association threats.** This is verified by synthetic fixtures, HTTP integration tests and registry reopen tests. It is not independent Stripe delivery verification. Same-second cancellation is fail-closed; an operator still needs a documented reconciliation route for exceptional state divergence.

## Subscription access, cancellation and customer data

- `active` permits practice routes; `past_due` allows configured grace, 14 days by default; `pending_payment` and `cancelled` block practice routes before a tenant database is opened.
- An invoice-success event cannot restore access. Stripe must emit an authoritative active subscription snapshot. A stale active event after a later cancellation is ignored.
- Cancellation and payment failure do not erase an encrypted document or its practice key. Subscription removal is separate from lifecycle deletion and retention.
- Re-subscription under the same Stripe customer accepts a newly created subscription id and reuses the retained practice row. Its documents and keys remain in the same tenant file.
- The billing wall links to account/billing recovery but has no self-serve export control. A trained operator can use the existing export and verification commands; after access ends, the customer will require a published support contact and verified identity process.
- Refunds, disputes and manual corrections should be handled in Stripe by an authorised operator with a matching local registry correction documented. Do not alter rows by matching email or return URL. Customer support must not access document plaintext or ask for keys, passphrases, recovery codes, card data, session tokens or webhook secrets.
- Phase 4 observation, superseded by the Phase 5 change: public links used to continue during retained tenant state. They now follow paid/grace access, pause on cancellation or after grace, and retain prior ciphertext. Re-subscription resumes only valid, unrevoked links.

## First use and commercial positioning

The strongest supported proposition is: **“Stop chasing clients for paperwork. Send one checklist, see what is missing, and collect files through a link clients can open without an account.”** Reduced admin is the lead benefit. Browser encryption is a concrete supporting property, with key loss, visible metadata and browser integrity stated clearly.

`site/index.html` and the hosted signup page now remove the false trial and unlimited-storage statements, describe immediate monthly billing and state the 5 GiB quota and 25 MiB per-file ceiling. Signup says where files are encrypted, what metadata the server can see, and that payment details are required. The first-use page already explains key recovery. A full visual redesign was not needed. Existing test coverage exercises first-run key setup, link issuance, upload, download and cross-tenant isolation; keyboard, mobile-device and assistive-technology behavior still needs a manual browser pass against the chosen host and device set.

### One-line proposition

Stop chasing clients for paperwork: send one checklist, see what's missing, and collect encrypted files through a link clients open without an account.

### 30-second pitch

Small practices spend time remembering who still owes which records. Tickmark gives each client a checklist and a link that opens without a client account, then shows the practice what has arrived and what is still outstanding. The files are encrypted in the browser to a key the practice keeps. Hosted service is currently priced at £49 per month, billed immediately at Checkout, with a 5 GiB storage quota. It is for practices that want a focused collection workflow and do not already have a portal that works for them.

### Five-minute synthetic-data demonstration

1. **0:00–0:30:** Explain the buyer problem and price/checkout terms; no trial claim.
2. **0:30–1:15:** Create a sample practice and key. Show the recovery reminder; use a synthetic passphrase and keep the recovery key only in the demo environment.
3. **1:15–2:15:** Add synthetic client “Northstar Design Ltd” and create “2025 year-end” with three items: bank statement, sales invoices and payroll summary.
4. **2:15–3:15:** Issue the client link. Open it in a private browser window and show that the client does not create an account. Upload clearly synthetic PDFs under 25 MB.
5. **3:15–4:15:** Return to the practice, show arrived/outstanding items, open the file in the browser and explain the key and metadata boundary.
6. **4:15–5:00:** Show cancellation/account controls and explain export, recovery-key responsibility, support and infrastructure review requirements. Do not present the local demo as proof of remote backups or production security.

### Pricing explanation

£49 per practice per month in GBP. Stripe Checkout requires payment details; the first payment is due immediately. There is no free trial. No separate client or staff seat price is currently configured. The hosted practice has a 5 GiB storage quota and each file is capped at 25 MiB. VAT treatment and invoice details must be confirmed by the operator before accepting subscriptions. Cancellation is managed in Stripe's customer portal; a scheduled end-of-period cancellation remains active until Stripe reports the subscription ended. Payment failure has a 14-day default grace period. Data retention and operator-assisted export/support details need final operator values before launch.

### First-contact email draft — do not send from this repository task

**Subject:** How do you keep track of client paperwork?

Hi [Name],

I’m testing a simple document-request workflow for small bookkeeping and accountancy practices. It lets you send a client one checklist, give them a link that does not require an account, and see what is still missing.

Would you be open to a 15-minute conversation about how your practice chases paperwork today? I’m looking for honest workflow feedback, not asking you to change systems.

Thanks,
[Founder name]

### Follow-up email draft — do not send

**Subject:** Re: client paperwork workflow

Hi [Name],

Just following up once in case this is relevant. I’m trying to understand which parts of document collection take the most time for small practices. If a short conversation is useful, I can work around your schedule; if not, no reply is needed.

Thanks,
[Founder name]

### Discovery-call agenda

1. Ask how a typical document request starts and who maintains the checklist.
2. Ask what creates the most chasing, rework or uncertainty.
3. Ask what tools and client portals are already used, and why they are adequate or inadequate.
4. Ask what a client needs to do from a phone and where uploads fail.
5. Show the synthetic workflow only after listening; ask what would not fit.
6. Ask how the buyer evaluates £49/month, a 5 GiB hosted quota, browser-held keys and support expectations.
7. Ask what evidence/legal documents are needed before any real client data could be considered.
8. Record a next step only if the participant requests it. No outreach is sent by this task.

### Customer FAQ draft

- **Do clients need an account?** No. They open the request link. Anyone holding that link can submit; the link is not identity proof.
- **What does it cost?** £49 per practice per month in GBP, billed through Stripe. Payment details are required and the first charge is immediate. There is no trial.
- **How much can I store?** Hosted limit is 5 GiB per practice, with a 25 MiB per-file limit.
- **Can Tickmark read the uploaded documents?** The app server does not receive the practice private key, so stored file bytes are encrypted. The server does see workflow metadata. A compromised browser/device or unsafe key handling can expose plaintext.
- **What if I lose the key?** The server cannot recover it. Losing every usable copy can make documents permanently unreadable. Keep the recovery material separate and controlled.
- **What happens if payment fails?** Practice access remains during the configured grace window, 14 days by default, then pauses if Stripe still reports a payment problem. Data is not immediately deleted.
- **How do I cancel or export?** Cancel in the billing portal. Before access ends, use the active workspace export tools. Afterward, request an operator-assisted export/deletion through **[support contact to publish]**. This is not yet a self-serve workflow.
- **Are you certified or independently audited?** No such certification or independent audit is represented by this Phase 4 work. Real hosting, backup and legal review gates remain.

### Trial/pilot feedback template

- Practice size, role and current portal/process: **[do not record client personal data]**
- How requests are made today:
- Biggest time sink and how often it happens:
- Which workflow step felt unclear or slow:
- Client mobile experience observed with synthetic records:
- Security/key concern raised:
- Quota and expected monthly storage estimate:
- Reaction to £49/month billed immediately/no free trial:
- Support and legal evidence expected:
- Willingness to use a synthetic pilot / what must be true first:
- Requested follow-up (only if participant asked):

## F-07: legal and privacy materials

The draft terms, privacy notice, Article 28 DPA schedule, subprocessor schedule, security summary, backup/retention, cancellation/refund, incident, support/cookie and hosted/self-hosted boundaries are in [`hosted-legal-drafts.md`](hosted-legal-drafts.md). The drafts deliberately use placeholders for unknown operator facts. They are not final contracts and have not been reviewed by a UK solicitor or accountant.

Current authoritative sources were checked on 22 October 2026: ICO controller/processor contract guidance, breach guidance, security and international-transfer guidance; ICO's DUAA update says all data-protection provisions are in force from 19 June 2026; legislation.gov.uk UK GDPR and Data Protection Act 2018; current ICO storage/access-technologies guidance; Consumer Rights Act 2015; and HMRC digital-services VAT and VAT registration guidance. Some ICO Article 28 pages state that guidance is under review after DUAA, so recheck before publication. This is a source review, not a legal conclusion.

**F-07 classification: PARTIALLY FIXED.** Practical drafts and a specific operator fact list are prepared. Provider locations, entity/contact details, transfer analysis, support, deletion/backup behavior, tax treatment and legal review are unresolved. Do not publish the drafts as final customer contracts.

## Commercial configuration and test-mode checklist

- [ ] Test mode selected in Stripe; confirm the account header and `sk_test_` key, never paste a live key into local checks.
- [ ] Create or select one active recurring GBP £49/month Price; set `STRIPE_PRICE_ID`; Checkout preflight must retrieve and match its amount, currency, interval and active flag.
- [ ] No trial days or trial policy are configured. `payment_method_collection=always` is sent.
- [ ] Set `TICKMARK_PUBLIC_URL` to the test app's HTTPS public URL; local-only HTTP is allowed only on localhost.
- [ ] Confirm success route only reports “confirmation processing” and never grants access on redirect.
- [ ] Forward signed test events to `/webhooks/stripe`; use the test endpoint's `whsec_` secret. Confirm raw-body signature, expiry and malformed-event rejection.
- [ ] Enable the customer portal for payment-method update/cancellation; confirm a cancellation scheduled at period end and an immediate cancellation in test mode.
- [ ] Verify invoice/payment-failure, retry and invoice receipt behavior; verify the subscription snapshot drives local status.
- [ ] Choose tax behavior and invoice/receipt settings with the operator's accountant. Confirm Stripe account entity, VAT registration and customer-facing tax wording.
- [ ] Check service email receipt settings and the exact sender/contact seen by a test customer.
- [ ] Confirm a provider failure logs only a safe generic diagnostic; test logs do not contain API secrets, webhook secrets, card data, customer documents or full event bodies.
- [ ] Confirm account-to-customer/subscription associations in `tenant` and ensure repeated events do not create a second tenant or session.
- [ ] Record test account, price ID (non-secret), webhook endpoint ID, evidence, operator and date. Do not store test secrets in this document.

## Regression evidence and quality gates

New tests cover failed/missing billing configuration, exact Price match, Checkout payment method/no-trial parameters, mismatched catalog rejection before session creation, signature rejection, checkout completion not activating, duplicate event id, durable registry restart, atomic rollback, stale out-of-order event, wrong customer, re-subscription, cancellation, payment recovery, grace, and existing core workflow/link behavior. Gateway tests use an actual local HTTP server and synthetic signed events. They are not Stripe account/CLI verification.

Phase 3 test baseline: 538 passing. Baseline coverage was 90.93% lines, 88.19% functions, 73.58% branches; thresholds remain 93% lines, 90% functions, 75% branches. Final full suite: **544 passed, 0 failed**. Final coverage: **90.90% lines, 88.14% functions, 73.97% branches**. The full suite passes; the coverage command exits nonzero because all three coverage thresholds remain unmet. Coverage is close to the Phase 3 baseline and does not meet the requested launch gate.

Tests intentionally preserve the existing coverage thresholds. Synthetic test data only; no customer files or live billing. Docker/Restic/host TLS and post-restore owner/TOTP/decryption evidence remain subject to the Phase 3 and consolidated checklist below.

## Consolidated pre-launch verification — gates for the next phase

1. Select hosting provider, legal entity, operating regions and data-center locations; configure least-privilege access, host/volume encryption and secrets.
2. Configure a real off-host Restic provider, protected recovery credentials, capacity alerts and actual retention.
3. Restore from that selected provider and test owner login, TOTP, staff invitation/membership, document key recovery/decryption, request-history integrity and exported records.
4. Build and run Docker, test migration, volume restart and shutdown if Docker is selected. The current engine was unavailable; there is no Docker verification result.
5. Validate public TLS, reverse-proxy headers, trusted-proxy config, link behavior and renewal alerts against the chosen hostname.
6. Verify external process/storage/backup/maintenance/quota/TLS alert delivery and rehearse an incident with named contacts.
7. Measure storage growth, backup capacity, representative upload performance and recovery objectives against real workloads.
8. Complete a Stripe test-mode end-to-end subscription, payment failure/recovery, duplicate/reordered webhooks, cancellation and receipt test using Stripe CLI; test only, no live key.
9. Verify customer export, deletion, legal-hold handling, backup expiry, and post-cancellation support flow end to end.
10. Complete operator identity, privacy contact, DPA/subprocessor locations, international transfer analysis, privacy/cookie/retention review, and UK legal/accounting review.
11. Manually test keyboard navigation, focus/error behavior and client uploads on representative mobile browsers with synthetic files.
12. Obtain an independent security review proportional to the sensitive business data and chosen deployment.

## Phase boundary

This report completes Phase 4 documentation and code changes only. It does not deploy infrastructure, enable live billing, register paid services, create customer accounts or send outreach. Phase 5 should begin with the real provider/legal/operations gates above, then controlled test-mode customer-lifecycle verification. Do not describe this branch as launch-ready until the external evidence exists.

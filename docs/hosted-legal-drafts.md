# Tickmark hosted service legal and privacy drafts

**Working draft for operator and legal review. Not a published contract, legal opinion, or statement of certification.**

Last checked against current UK sources: 22 October 2026. The Data (Use and Access) Act 2025 data-protection provisions are in force. ICO guidance says some older pages remain under review; recheck before publication.

## Operator details that must be completed

- Legal service provider: **[LEGAL ENTITY / SOLE TRADER NAME]**
- Registered or business address: **[ADDRESS]**
- Company number, if applicable: **[NUMBER]**
- Service and privacy contact: **[SUPPORT EMAIL / POSTAL CONTACT]**
- Data protection contact / DPO, if appointed: **[CONTACT OR “NOT APPOINTED” AFTER REVIEW]**
- Primary hosting provider, account entity, data-centre regions and support access locations: **[PROVIDER / REGIONS]**
- Backup provider, repository region, retention and deletion behaviour: **[PROVIDER / REGION / RETENTION]**
- Email and SMS providers, regions and message content: **[PROVIDERS / REGIONS / DATA]**
- Stripe account's contracting entity, account country, enabled tax settings, receipt/invoice rules and data locations: **[CONFIRM FROM STRIPE DASHBOARD]**
- International-transfer map and applicable adequacy / safeguard / data-protection-test record: **[COMPLETE AFTER PROVIDER SELECTION]**
- Incident contact, escalation rota and out-of-hours coverage: **[CONTACTS / COVERAGE]**
- Support hours, target response time and service-status location: **[ARRANGEMENT / URL]**
- Confirmed storage quota, file ceiling, retention schedule, deletion exceptions and restoration objectives: **[APPROVE VALUES]**
- VAT treatment, invoice wording and price presentation: **[ACCOUNTANT REVIEW]**

Do not publish these drafts while any placeholder affects a customer's decision, contractual identity, data location, support route, or cancellation/export rights.

## 1. Hosted service terms — draft

### Parties and service

These terms are between **[LEGAL ENTITY]**, of **[ADDRESS]** (“Tickmark”, “we”), and the business or professional practice identified in its hosted account (“you”). Tickmark provides a hosted document-request workspace. Client upload links do not require the client's own Tickmark account. Your practice controls the requests, client contact details, checklist information and the documents it asks clients to provide.

### Price and billing

The hosted plan is **£49 per month per practice**, billed in GBP. Stripe Checkout requires payment details and starts the subscription immediately; the first monthly payment is due when Checkout completes. There is no free trial at present. A hosted practice has a 5 GiB document-storage quota and 25 MiB maximum upload size per file. **[Confirm VAT-inclusive/exclusive treatment and applicable taxes before publication.]** We will show the applicable amount and tax in Checkout before you confirm payment. No additional plan or usage charge is described here.

### Cancellation, failures and access

Manage cancellation and payment details through the hosted account's Stripe billing settings. A cancellation scheduled for the end of a paid period remains active until Stripe reports the subscription ended. A payment failure starts a 14-day access grace period. If Stripe reports the subscription as unpaid or past due, practice access is then paused when that grace period expires. Client upload links may continue to work while the practice is retained. Re-subscription restores access to retained data if the same practice still exists and its encryption keys remain available.

An account pause does not delete documents. The service retains an ended practice for **[OPERATOR-APPROVED RETENTION PERIOD]**, then begins deletion subject to legal holds, backup rotation and documented exceptions. Before cancellation, download a Tickmark export and verify that the practice has its encryption recovery information. After access ends, contact **[SUPPORT CONTACT]** for a controlled export or deletion request. The current application has an operator-run export/offboarding tool; it does not provide a customer-facing export route from the billing wall.

### Refunds, disputes and manual corrections

Contact **[SUPPORT CONTACT]** promptly about a duplicate or incorrect charge. The operator will review the Stripe invoice, subscription history and the facts, then record any refund or account correction in Stripe and the service registry. Disputes are handled through Stripe's process and the provider's applicable terms. This clause does not limit rights that cannot lawfully be limited. **[Legal review required for refund and consumer-rights wording.]**

### Customer responsibilities and encryption

You choose what to request, provide the required privacy information to your clients, control who in your practice can sign in, and keep your practice key and recovery material safe. Documents are encrypted in the submitting browser to a key held by the practice. The hosted server stores encrypted document bytes but can see workflow and file metadata, account information, request history, IP/request security data and storage size. Browser encryption does not protect information from a compromised client or practice device, malicious browser code, a person who has the key, or exposed metadata. Losing every usable practice key can make documents permanently unreadable.

### Availability, support and changes

Support is provided through **[CONTACT / HOURS / TARGET RESPONSE]**. No uptime or recovery-time guarantee is offered in this draft. We may suspend access to address a security incident, legal requirement, or material service risk and will notify you when reasonably possible. We will give **[NOTICE PERIOD AND METHOD]** for material service or price changes. **[Review fair notice and contract termination rights.]**

### Hosted and self-hosted responsibilities

For hosted accounts, the operator runs the application host, database and backup process, subject to the provider facts and operational limits published in the final schedule. Your practice remains responsible for lawful collection, client notices, access decisions and its encryption keys. For a self-hosted installation, the operator of that installation chooses the host, security controls, mail providers, backup, retention, incident response and support. The hosted service's operational statements do not apply to self-hosted installations.

### Governing terms

Governing law, jurisdiction, liability allocation, intellectual-property terms, contract duration and any consumer-specific provisions: **[LEGAL REVIEW AND INSERTION REQUIRED]**.

## 2. Privacy notice — draft

**Controller for Tickmark account and service administration:** [LEGAL ENTITY / ADDRESS / CONTACT]. For documents and client workflow, the accountancy practice usually decides why and how its clients' information is collected; Tickmark's hosted operator is intended to act as its processor for that service data. The actual roles must be confirmed for each processing activity and in the final contract.

We process account email, password hash, practice name and slug, membership and access records, billing customer/subscription identifiers, security logs, client names and contact details, request/checklist history, upload filenames and sizes, encrypted document bytes, and support correspondence. Stripe receives the details needed to create the subscription and administer payment; Tickmark does not receive or store card numbers. **[Confirm any payment and receipt fields from the chosen Stripe configuration.]**

We use account and security data to operate sign-in, membership, billing and abuse prevention; practice data to host the document-request service under the practice's instructions; and billing records to administer the subscription and applicable accounting duties. The practice must provide its own client-facing privacy information and lawful basis for collecting client information. The Tickmark operator's own lawful bases, retention periods and rights-request route need legal review before publication.

Practice data is stored in per-practice databases and blob directories on **[HOSTING PROVIDER / REGIONS]**. The operational design includes encrypted off-site backup through **[BACKUP PROVIDER / REGION]**, but the provider and real remote restore remain unverified. Email/SMS providers are **[PROVIDERS OR “NOT ENABLED”]**. Payment processing is Stripe **[CONTRACTING ENTITY / COUNTRY / DATA LOCATION]**. International access or transfers are **[MAP, ASSESS AND DOCUMENT]**.

Strictly necessary session cookies support signed-in use. The marketing page currently has no analytics code or tracking cookies in the repository. Confirm deployed hosting/CDN logs and any added third-party scripts before stating that no tracking occurs. If non-essential analytics or advertising storage/access technologies are added, review current PECR/ICO consent rules and implement the required choice before enabling them.

To exercise account rights or raise a privacy question, contact **[CONTACT]**. The practice should route client requests about practice-controlled data to its own controller contact. Deletion, legal retention, live backups and technical logs can have different timelines; publish the final timelines and exceptions only after provider behaviour and the deletion process have been verified.

## 3. Data processing agreement — draft schedule

This schedule is intended to attach to the final hosted service contract after legal review. It is not complete until the controller and processor are identified and the blanks below are filled.

| Item | Draft description |
|---|---|
| Parties | Controller: the subscribing practice **[LEGAL NAME / CONTACT]**. Processor: **[TICKMARK LEGAL ENTITY / CONTACT]**. Confirm role per processing activity. |
| Subject and duration | Hosted document-request workflow for the subscription term and the approved post-termination export, retention and deletion period. |
| Nature and purpose | Account access, client request delivery, receipt and storage of encrypted client documents, request history, support and backup/recovery. |
| Data subjects | The practice's staff, clients, client representatives, and the practice's account owner. |
| Data categories | Names, contact details, client/request metadata, filenames, encrypted document content, access and audit records. Special-category or criminal-offence data is not a designed category; the practice must not assume the service is approved for it without risk assessment. |
| Instructions | Process only to provide and secure the hosted service, maintain backups, respond to documented support instructions and comply with applicable law. Record additional instructions in writing. |
| Confidentiality and security | Limit personnel access; use authentication, tenant separation, encryption in the browser, protected operations and backup controls as described in the approved security schedule. Complete the schedule with actual host, encryption-at-rest, staff access and testing facts. |
| Subprocessors | Use only the final, named schedule below and give **[NOTICE PERIOD / OBJECTION PROCESS]** for changes. The operator must maintain written processor terms and remains responsible for subprocessor obligations as applicable. |
| Rights and assistance | Provide reasonable help with data-subject requests, security, breach response, DPIAs and regulator consultation, taking account of the information available and the service's encrypted data model. |
| Incidents | Notify the practice without undue delay after confirming a personal-data breach affecting its data; provide known facts and updates. The practice decides its controller notifications. Operational incident contact: **[CONTACT / SLA]**. |
| End of service | At the practice's choice, provide a verified export or delete practice data after **[PERIOD]**, subject to legal retention and backup rotation. State the final backup deletion window and any exceptions. |
| Audit information | Provide current service/security information and reasonable evidence **[DEFINE SCOPE, NOTICE, FREQUENCY AND COST]**. Do not promise certifications or audit reports that do not exist. |
| Transfers | List locations and subprocessors, then document the relevant UK transfer mechanism and any data-protection test required under current law. No location or transfer mechanism is asserted until verified. |

## 4. Subprocessor schedule — draft

| Provider/service | Data and purpose | Contracting entity and location | Status |
|---|---|---|---|
| Hosting / compute / database / blob disk | Account data, tenant metadata, ciphertext and application logs | **[UNKNOWN — select and verify]** | Must be completed |
| Backup / Restic repository | Database snapshots, encrypted blobs, lifecycle metadata | **[UNKNOWN — select provider and repository region]** | Must be completed and remotely tested |
| Email relay | Account invitations, client request/reminder email and recipient addresses | **[UNKNOWN; confirm whether enabled]** | Must be completed or mark disabled |
| SMS provider | Phone number and message content, if SMS is enabled | **[UNKNOWN; confirm disabled/enabled]** | Must be completed or mark disabled |
| Stripe | Billing email, account/customer/subscription identifiers and payment status | **[Stripe contracting entity, account country and locations unknown]** | Test-mode code only; operator account setup unverified |

Do not put a provider in the live schedule until its actual contract, purpose, data, region, subprocessors and transfer position have been checked.

## 5. Security measures and responsibility summary — draft

The codebase demonstrates per-practice SQLite files and blob directories; server-enforced membership and subscription access; hashed account/session credentials; TOTP support; rate-limited sign-in; request size and storage quotas; encrypted uploads prepared in the browser; webhook signature checks; and a local backup/restore toolchain. Phase 4 adds a persistent Stripe event receipt and atomic state update. These are code-level controls, not proof of a secure deployed service.

The operator must configure host and volume access, host encryption, TLS and reverse proxy, secrets, Stripe restrictions, provider access, external monitoring, alert delivery, backup credentials and retention, patching, incident response, staff access review and tested restore procedures. A practice must protect its own devices, accounts, staff access and private encryption keys. No independent audit, penetration test, certification, production TLS test, real remote backup restore or production-scale performance test has been completed by this work.

## 6. Backup, retention, cancellation and deletion policy — draft

The hosted design takes a coordinated full-host backup and uses Restic with a planned 35-day retention policy. This has only been exercised with synthetic/fake tooling locally; provider, region, actual retention and permanent deletion behaviour remain unknown. Backups can preserve encrypted document bytes and account metadata after a live record is deleted until the relevant snapshots expire. Retention holds may defer deletion. The operator must confirm and publish actual schedules, backup scope, recovery objectives, repository capacity controls and legal hold process.

At cancellation, Stripe subscription state governs practice access. A failed payment has a 14-day access grace period. An ended subscription pauses practice access while retained data remains intact. The current customer-facing UI does not implement self-serve export after cancellation; the existing CLI export is operator-run. The operator must provide a working support route, verify the requester, create and verify the ciphertext-preserving export, securely deliver it, and record completion. A deletion request must be identity-verified, checked for holds, scheduled and recorded; the current deletion workflow defaults to a 30-day retention period in its programmatic helper, but the commercial schedule is not approved until the operator confirms it. Never promise immediate removal from every backup.

## 7. Incident and breach response procedure — draft

1. Receive reports at **[INCIDENT EMAIL / PHONE]** and route urgent security reports to **[ON-CALL CONTACT]**.
2. Record time, reporter, affected system, tenant identifier, evidence and containment actions in **[INCIDENT REGISTER]**. Do not include passwords, session tokens, webhook secrets, card data or plaintext client files in tickets or logs.
3. Preserve relevant access, host and provider logs; restrict access; contain the incident; and involve the hosting, backup, email or payment provider as needed.
4. Determine affected services, tenants, data categories, time window and whether encrypted material or keys were exposed. The operator cannot decrypt customer documents, so request practice-side confirmation where necessary.
5. Notify affected practices without undue delay when a personal-data breach affecting their data is confirmed, with available facts and follow-up. The practice remains responsible for its controller assessment and any required regulator/data-subject notification. Under UK GDPR a controller must report a notifiable breach to the ICO without undue delay and, where feasible, within 72 hours of awareness; record breach decisions even where notification is not required.
6. Recover from a verified backup only after preserving incident evidence. Validate tenant boundary, authentication, TOTP, membership, request history and document decryption before reopening.
7. Record decisions, notifications, recovery checks, corrective actions and review date. Test the procedure with named people before launch.

## 8. Support and cookies

Support route, hours, response objectives, out-of-hours handling and escalation are **[UNKNOWN — complete]**. Support staff must not ask customers to send private keys, passphrases, recovery codes, session cookies, card data or plaintext client documents. Billing diagnostics should use tenant id/slug and Stripe object identifiers only, with access audited.

Repository inspection finds no analytics or third-party tracking script on `site/index.html`; the marketing page uses a `mailto:` link and is intended to set no cookies. The hosted application uses necessary session cookies. Recheck deployed reverse proxies, CDN, error reporting, analytics and Stripe-hosted pages before publication. Current ICO cookie guidance must be consulted if any optional storage/access technology is enabled.

## Current UK source references

- [ICO: What needs to be included in a controller/processor contract](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/what-needs-to-be-included-in-the-contract/) — Article 28 terms, instructions, security, subprocessors, assistance, end-of-contract deletion/return and audits. This guidance notes that it is under review following DUAA changes.
- [ICO: Data security guide](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/security/a-guide-to-data-security/) — security measures and processor assurance.
- [ICO: Personal data breaches](https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach/personal-data-breaches-a-guide/) — notification and recordkeeping; ICO page updated 20 August 2025.
- [ICO: International transfers](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/) — current transfer mechanisms and data-protection-test/transfer risk assessment guidance.
- [ICO: DUAA summary for organisations](https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-duaa-summary-of-the-changes/) — updated 19 June 2026 and states all data-protection provisions are in force.
- [UK GDPR, legislation.gov.uk](https://www.legislation.gov.uk/eur/2016/679/contents) and [Data Protection Act 2018](https://www.legislation.gov.uk/ukpga/2018/12/contents) — primary legislation as amended; legal review should use current consolidated text.
- [ICO: Storage and access technologies guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/) — current guidance covering cookies, pixels and similar technologies under PECR/UK GDPR.
- [Consumer Rights Act 2015](https://www.legislation.gov.uk/ukpga/2015/15/contents) — review scope and remedies if the service is offered to individuals acting outside a business.
- [GOV.UK VAT on digital services to consumers](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers) — consumer digital-services guidance; do not infer B2B treatment or the operator's VAT obligation from it alone.
- [GOV.UK VAT registration threshold](https://www.gov.uk/vat-registration/when-to-register) — confirm the current threshold and taxable-turnover calculation with an accountant; do not publish “no VAT” based on revenue assumptions.

The marketing audience is primarily professional practices, but the contracting entity, sales channel and customer status can change which consumer, e-commerce, tax and distance-selling rules apply. Obtain UK solicitor/accountant review before accepting subscriptions.

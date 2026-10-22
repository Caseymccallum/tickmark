# Tickmark Phase 5 — launch qualification

**Status:** qualification in progress; this document is not launch approval.
**Starting point:** `codex/tickmark-commercial-readiness` at `1d3afd8f5a9ab667038684c7e4c277ed0441616b`.
**Work branch:** `codex/tickmark-launch-qualification`.
**Scope:** disposable synthetic practices and documents only. No deployment, live billing, paid services, customer outreach or customer data.

## Prioritised qualification matrix (before Phase 5 changes)

| Priority | Gate | Classification | Baseline evidence / required action |
|---|---|---|---|
| P0 | Stop public client uploads when a hosted tenant is inaccessible or closing | **Locally testable** | `src/tenancy/resolve.js` resolves `/r/<token>` before host billing checks and opens the tenant regardless of subscription status. Add a server-side gate, retain submitted ciphertext, and test cancellation, grace expiry, suspension, re-subscription and revocation. |
| P0 | Complete owner, TOTP, staff, request-history and decryption journey after full restore | **Locally testable**, with a **fake Restic transport limitation** | Existing `test/hosted-restore.test.js` checks older snapshot restore plus deletion tombstone replay, and `test/backup-all.test.js` decrypts backed-up uploaded bytes. They do not start a restored hosted app or authenticate through it. Add an isolated recovery integration test using real Tickmark app, registry, tenant DBs and crypto formats. Browser UI and physical-device evidence is separate. |
| P0 | Prevent deletion resurrection and handle restore failures safely | **Verified locally** for existing synthetic tombstone tests; **locally testable** for failure-path expansion | `restore-hosted.mjs`, `restore-tombstones.js`, and hosted-restore tests replay the latest ledger before service start. Add failure/no-promotion evidence to the recovery drill; real repository ledger trust and remote restore remain external. |
| P0 | Stripe lifecycle and exceptional state reconciliation | **Locally testable**; test-mode run **requires external credentials/infrastructure** | Phase 4 tests synthetic signed events, durable deduplication and stale order. Expand lifecycle tests and write a Stripe-authoritative, auditable operator reconciliation procedure. Never use live keys. Stripe API/CLI lifecycle is **blocked** until an authorized test account and CLI are available. |
| P0 | Coverage thresholds and regression quality | **Locally testable** | Phase 4 suite passed 544 tests; coverage was 90.90% lines, 88.14% functions, 73.97% branches against unchanged 93/90/75. Add behavior-focused tests; do not claim this gate passes unless `npm run coverage` exits 0. |
| P1 | Cancelled-customer export, secure delivery, deletion and backup expiry | **Locally testable** for operator procedure/tooling; secure delivery and actual backup expiry **require operator action/external infrastructure** | Export/offboarding commands exist, while Phase 4 found no billing-wall self-serve export. Specify one-founder identity verification, ciphertext-preserving export, secure delivery, receipt confirmation and separate deletion/hold/backup-expiry steps. Do not request customer keys. |
| P1 | Container/runtime, host persistence, service identity, TLS and reverse proxy | **Requires operator action / external credentials or infrastructure** | Phase 3 reports Docker engine unavailable and no real host/public endpoint. Check Docker availability without probing port 3000. Review systemd and local proxy config; report external TLS as unverified. |
| P1 | Minimum monitoring and incident recovery | **Locally testable** for scenario/runbook review; real alert delivery and founder contact route **require operator action** | Phase 3 supplies systemd backup/maintenance procedures but no installed production host or external alert delivery. Add scenario table with detection, containment, recovery, actor, evidence and test. No 24/7 promise. |
| P1 | First-time user accessibility and five-tester journey | **Locally testable** with available app tests; actual browser, mobile and screen-reader validation **requires operator action/test devices** | Existing DOM/HTTP tests are not device or screen-reader evidence. Prepare an executable five-person checklist. Record automation/browser availability and do not imply manual testers were run. |
| P2 | Safe handling of browser-encrypted/unscannable documents (F-11) | **Requires operator action**; product copy is **locally verified** | Server cannot inspect ciphertext for malware. Document endpoint malware/safe-opening limitations, practice-side review procedures and never imply antivirus scanning. |
| P1 | Operator, privacy, commercial and legal facts | **Requires operator action** and **independent professional review** | Phase 4 legal drafts contain unknown placeholders. Produce evidence checklist for entity, contacts, provider regions, subprocessors, tax, retention, support, insurance and reviewed terms/DPA. Do not fill unknowns. |
| P2 | Synthetic demo readiness | **Locally testable** | Existing self-hosted and hosted HTTP/crypto flows plus synthetic data can establish a demo path; confirm it end to end and label encryption/key limitations. |
| P2 | Public paid launch verdict | **Requires external infrastructure, operator action and independent professional review** | No technical test alone can close production host, remote backup/restore, public TLS, Stripe, legal, support or independent security review. |

## Baseline

- Remote: `https://github.com/Caseymccallum/tickmark.git`.
- `origin/codex/tickmark-commercial-readiness` equals required SHA `1d3afd8f5a9ab667038684c7e4c277ed0441616b` at qualification start.
- Original checkout remains on `codex/tickmark-commercial-audit` at `27aa759`; its pre-existing `docs/go-succeed-prep.md` edit is preserved.
- Phase 4 baseline suite on the isolated Phase 5 worktree: **544 passed, 0 failed**.
- Phase 4 coverage baseline: **90.90% lines, 88.14% functions, 73.97% branches**; configured thresholds remain 93/90/75.

## Full-host recovery evidence

`test/full-hosted-recovery.test.js` creates two isolated hosted practices and a keyed accountant invitation. It uses the real hosted app and HTTP request routes, the product's browser crypto module for practice key setup, invitation transfer and encrypted upload, the real hosted backup/restore CLIs, real SQLite files and the existing fake Restic adapter only for transport. It stops the app before backup, deletes one practice after snapshot one, captures snapshot two as the newest deletion ledger, moves the entire primary data directory away to simulate host loss, restores snapshot one into a fresh path and starts a new hosted app on an ephemeral loopback port.

Verified by the integration test:

- Two hosted practices were provisioned. One client request, two checklist items and four append-only history events survived.
- An accountant invitation was created and accepted through the HTTP routes. The link secret was used only by the crypto module; the hosted server received the sealed key, not the secret.
- Owner and staff TOTP secrets were set through the auth module before backup. Both users completed password and current-code login against the restored service and opened the practice workspace.
- A staff session could not open the other active practice before deletion. After deletion, that practice was absent from the restored registry and directory; its old slug returned 404.
- The recovered encrypted document matched its database SHA-256 `18a333af94b6c7ecc2835351c85a65568bb0d0c5c977f01749a15290b5e326f6` in the recorded run and decrypted to the original 51 synthetic bytes using the practice recovery key.
- The unrevoked client link resolved after restore. A separate gateway regression confirms link pause/recovery and revoked-token behavior through billing transitions.
- Selecting the older snapshot replayed one tombstone from the newer ledger and did not resurrect the deleted practice. A malformed latest ledger produced `restore.failed` and no promoted target directory.

This is strong local integration evidence for application recovery, not a real remote backup. Fake Restic does not verify repository credentials, encryption-at-rest at the selected provider, provider retention, remote bandwidth, immutable deletion, restore time or physical host loss. Auth after restore used real HTTP handlers but not a graphical browser, authenticator app, mobile device or screen reader.

## Stripe lifecycle and reconciliation

### Implemented local behavior

- `customer.subscription.created/updated/deleted` snapshots set access state. Checkout completion binds identifiers only. Invoice success/failure events never change access by themselves.
- Webhook receipts and state changes commit atomically. Duplicate IDs are no-ops; old snapshots and same-second active-after-cancel are refused; customer/subscription mismatches are ignored.
- `past_due` retains access only through configured grace. `active` after an authenticated payment recovery reopens the practice. Scheduled cancellation leaves Stripe status `active` through the paid period; immediate cancellation closes access. A new subscription may re-use the same customer only after cancellation.
- `tools/reconcile-stripe.mjs` requires explicit tenant, customer, subscription and operator identifiers, retrieves the current subscription from Stripe with a 10-second timeout, checks exact customer/subscription associations and a recognized status, then updates the registry and inserts a reviewable row in `stripe_reconciliation` in one immediate transaction. It never accepts a typed status or writes the Stripe response body/API secret. Repeated reconciliation of the same current state records `confirmed` without changing access. A newer local event, an API error, timeout, unknown status, tenant mismatch or returned-ID mismatch rolls back with `stateChanged:false` output.
- Reconciliation audit rows retain tenant/customer/subscription IDs, old/new status, result, operator and time, and are removed with the tenant. The billing-event table still retains no raw event body.

### Exceptional divergence procedure

1. Restrict the work to one tenant during a support incident. Record the ticket/incident ID in the private operator log; never request a card number or document key.
2. Obtain the tenant UUID, Stripe customer ID and current subscription ID from the registry. Independently open the matching Stripe account in **test mode during qualification**, verify its account header, and compare customer/subscription identifiers. Do not select a tenant by email or browser return URL.
3. Confirm the operator name and data path. Put a Stripe `sk_test_` key in the protected process environment. Do not put keys in command arguments, chat, source, or logs. This phase did not have authorised Stripe test credentials and did not call Stripe.
4. Run `npm run reconcile:stripe -- --tenant <tenant-uuid> --customer <cus_id> --subscription <sub_id> --operator <name> --data <data-dir>`. The command retrieves the object itself; no status can be supplied. Live mode requires an extra `--allow-live` flag and must not be used during this qualification.
5. Review the one-line result and the matching `stripe_reconciliation` row. Confirm whether it corrected or confirmed the state. Check the owner-facing access and the next signed Stripe subscription event. Do not perform a direct SQL edit.
6. On timeout, 4xx/5xx, ID mismatch, stale registry watermark or unknown state, stop. No local status is changed. Recheck Stripe/API health and registry IDs, then rerun only after the authoritative state is clear. If still divergent, keep access closed and escalate for a second operator review; do not infer state from an invoice or manually enter `active`.
7. Reconcile promptly after a current Stripe read. The registry write lock prevents a local webhook applying halfway through the fetch; the retrieval time becomes the event watermark so delayed older events cannot undo the correction. If subsequent newer Stripe events arrive, normal webhook ordering applies.

The command and synthetic tests are locally verified only. The Stripe account/CLI end-to-end lifecycle, portal, payment retries, scheduled cancellation and real event delivery remain an **external credential gate**. Never run with live credentials during this phase.

## Client-link lifecycle policy

| Tenant state | Client bearer link behavior | Existing ciphertext / recovery |
|---|---|---|
| Active | Usable until its own expiry/revocation. | Stored normally. |
| Past due, inside configured grace | Usable so an in-flight collection can finish during the stated payment grace. | Stored normally. |
| Past due, grace expired | Server returns a non-cacheable 403 before opening the tenant DB. New uploads and link reads pause. | Already submitted ciphertext is retained; it is not silently deleted. |
| Immediate cancellation / unpaid / pending payment | Server returns the same temporary 403; client gets a generic contact-the-practice message. | Retained for the published retention window. |
| Scheduled cancellation, still active | Continues through the paid period while Stripe's canonical state is active. | Stored normally. |
| Re-subscribed | An unexpired, unrevoked link can work again. | Existing practice, keys and ciphertext stay in place. |
| Explicitly revoked or expired | Tenant DB returns the existing 410 revoked/expired state, including after re-subscription. | Existing submitted bytes remain in the practice DB until normal deletion. |
| `deletion_requested`, `deleting`, or held/deleting lifecycle | Resolver denies workspace, invite and client-link access before tenant DB open. Offboarding revokes links. | Data follows retention/hold and tombstone rules; the hold is not an access grant. |
| Fully deleted | Link index and tenant files are removed; an older restored copy is deleted by the newest tombstone ledger. Unknown route returns 404. | Encrypted backups may retain data until shared retention expires; not immediate erasure. |

The policy is enforced in the hosted resolver using the same `tenantAllowsAccess` decision as workspace access. A generic response avoids disclosing billing state to a bearer-link holder. Single-tenant installations are unchanged. The policy prevents indefinite uploads to a practice that cannot use its workspace while retaining received ciphertext for export/recovery.

## Customer exit procedure for one founder

This is an operator procedure, not a customer portal or an SLA. Publish real support details and final retention dates only after the operator checklist is complete.

1. Receive the request through the verified support address. Record case ID, tenant UUID, requested outcome and date. Do not ask for a practice passphrase, private key, recovery phrase, OTP recovery code, card number or session token.
2. Verify authority against the owner account using a recent authenticated session with configured TOTP, plus a reply to the established account contact. If the owner cannot sign in, use a documented manual identity check and require a second confirmation through a pre-existing channel. A plain email request alone is not enough to delete data.
3. Agree whether the customer wants a ciphertext-preserving export, deletion, or both in that order. Explain that export contains ciphertext, databases and wrapped keys; the practice must hold its own recovery material to decrypt. Export cannot make lost keys recoverable.
4. Create the export with `tools/offboard-tenant.mjs --tenant <uuid> --confirm <uuid> --email <owner-email> --password-file <protected-file> --totp-code-file <protected-code-file> --to <new-private-directory>` when TOTP is enabled. The command consumes the current TOTP step or a one-use recovery code; keep both files private and never put their contents in argv. Run `tools/verify-tenant-export.mjs --from <new-private-directory>` and record the manifest SHA-256, document count/bytes and verifier output.
5. Deliver through a pre-agreed secure channel with access limited to the verified owner. Keep any decryption material in the customer's possession; Tickmark does not send or retain it. Use a separate channel for any one-time retrieval secret. Record delivery destination in masked form, expiry and sender.
6. Ask the owner to confirm retrieval and successful local verification. If they cannot decrypt, help them follow their own recovery procedure without receiving the key/passphrase. Keep the export only for the shortest approved support window, then securely remove the operator copy and record removal.
7. If deletion is requested, confirm the retention date and any hold. Use the export-first offboarding request, which suspends sessions, revokes links/invites and blocks both host and client-link routes. The current helper defaults to 30 days; do not silently reduce it. After expiry, purge only with fresh-backup safety gates and hold review. Record the deletion tombstone and expected backup expiry separately.
8. Explain that live rows/files are removed after the approved period, while shared immutable/off-site snapshots can retain encrypted bytes until the configured backup policy expires. Verify deletion by registry/tombstone, tenant-directory absence, backup-history report and later snapshot expiry evidence. Do not promise immediate removal from backups.

**Release Quality update:** owner export and deletion request now check and consume an unused TOTP step or one-time recovery code whenever the practice has confirmed TOTP. The code is read from a protected file. Regression coverage exercises absent proof, TOTP replay, recovery-code use and recovery-code replay. This establishes local application behavior only. Delivery channel and retention/backup expiry are not yet configured.

## Operational failure scenarios and minimum monitoring

| Failure | Detection and customer impact | Immediate containment / recovery | Actor and evidence | Test before pilot |
|---|---|---|---|---|
| Backup fails overnight | systemd nonzero status or backup status older than 26h; recovery point grows stale. | Keep the last known-good snapshot; stop pruning, inspect staging/repository and rerun once cause is fixed. Do not claim a fresh backup. | Founder/operator; journal, status JSON, Restic snapshot/check output. | Fake adapter failure plus real host timer failure alert. |
| Remote credentials expire | Restic auth error; no new snapshot. | Do not prune; rotate provider credentials through provider console; run repository check and backup/restore verification. | Founder; redacted job logs, provider audit entry, successful snapshot ID. | Expire test credential and verify nonzero alert/no pruning. |
| Restic password lost | Repository cannot be decrypted; primary may still work until host loss. | Halt changes/pruning; retrieve offline escrow copy. If no copy exists, data in repository is unrecoverable. | Founder plus designated recovery contact; escrow inventory and repository check. | Conduct a password retrieval drill without printing it. |
| Disk or inode capacity exhausted | health errors, disk alert, upload 507, backup staging preflight failure. | Pause uploads/traffic if SQLite at risk; expand volume or safely reconcile aged orphan files; preserve database/WAL and backups. | Founder/on-call operator; filesystem metrics, storage report and incident timeline. | Fill a disposable filesystem or inject ENOSPC. |
| Tenant accidentally deleted | Support report, tombstone, purge/maintenance logs. | Pause maintenance and public traffic; confirm fresh backup, restore to isolated path, replay newest deletion ledger; use hold only for legal preservation. | Founder; owner request/approval, export hash, tombstone, restore manifest. | Simulate both requested and completed deletion in a recovery fixture. |
| Restore has stale registry | App shows unexpected account/membership/billing mismatch or link routing. | Keep service offline; restore coordinated fleet snapshot and newest ledger again. Never combine arbitrary database dates. | Founder; snapshot IDs/timestamps, restore report, auth and tenant checks. | Full synthetic restore integration test (passed locally); real provider remains open. |
| Billing webhook delayed | Stripe dashboard differs from local status; customer may see paused access. | Query Stripe read-only; preserve current restrictive state until reconciliation; run audited command with exact IDs. | Founder; Stripe account/event IDs, reconciliation audit row and webhook receipts. | Test duplicate/delay/reorder and failed reconciliation with Stripe test account. |
| Email delivery fails | mail relay errors / no confirmation, invitation or reminder; user journey stops. | Do not paste bearer tokens into public channels. Verify relay and sender, then reissue an expiring link only after confirming prior token revocation/expiry. | Founder; redacted relay result and synthetic delivery proof. | Controlled SMTP transcript and provider delivery test. |
| Staff member is removed | owner action / membership audit; access should end, while downloaded keys/files cannot be recalled. | Remove membership, end sessions and key wrappings; check invitation/link scopes. Notify practice owner through agreed channel. | Practice owner with founder support; member-removal history and auth rejection. | Existing revocation, session, key and cross-tenant tests. |
| Customer document unavailable | client reports missing upload or owner cannot decrypt. | Stop further key changes; check request history, blob path/hash, backup manifest. Restore ciphertext to isolated copy; owner tests with own recovery key. | Practice owner leads; founder handles ciphertext integrity only. Record hash and recovery point, never plaintext. | Restore/decrypt synthetic file and corrupt-blob refusal. |
| Founder unavailable | no second operator can access credentials or answer incident. | Keep service in restrictive mode; emergency contact receives recovery instructions from sealed escrow. No 24/7 response promise. | Named backup operator must be designated. Keep contact/authority record offline. | Tabletop one-day absence and a handover rehearsal. |
| Upgrade must roll back | health/schema/startup error after migration; downgrades unsupported. | Stop traffic; do not point the old binary at a migrated DB. Restore coordinated pre-upgrade snapshot to a fresh path and validate before cutover. | Founder; release SHA, migration output, backup/restore IDs and smoke evidence. | Test a real migration/rollback on selected host and filesystem. |

Minimum private-pilot monitoring is an external process/HTTPS monitor, disk and inode thresholds, per-tenant quota alerts, mail relay errors, app error logs with route-token redaction, backup and maintenance status freshness/failure, provider repository capacity, TLS expiry and operator login alerting. Alert delivery must be outside the app host. A single founder must set a realistic support window, one alternate incident contact, a daily backup/health review and an explicit out-of-hours coverage statement; Tickmark promises no 24/7 response.

## Manual user-experience acceptance plan for five testers

No five-person manual study, actual mobile device pass or screen-reader test was performed during qualification. The following is an executable checklist for five first-time bookkeeping/accountancy testers on the selected deployment. Use synthetic accounts/files and record tester code, consent, browser/device version, start/end time, completion, errors, help needed and verbatim friction. Do not retain personal financial information.

For each tester, observe without coaching first; time the first request and client upload; record where they hesitate and whether they need help. Then repeat once with the instructions. Acceptance: all five can finish the first client request without operator intervention; no tester mistakes a link for identity proof or loses recovery information; keyboard users can complete the core flow; no upload failure remains unexplained.

| Journey step | Pass evidence |
|---|---|
| Accountant onboarding and sign-in | Tester distinguishes practice account, owner and staff login; can recover from a wrong-password message without disclosing credentials. |
| Practice key setup | Creates key in supported browser, understands where encryption occurs, identifies server-visible metadata. |
| Recovery material | Saves/downloads recovery material in an independent secure place and correctly explains that Tickmark cannot recover a lost key. Never ask tester to disclose it. |
| First client and request | Creates one fictional client and one checklist request with a due date. |
| Client opens without account | Opens request in a separate private browser profile/device; no Tickmark client account is required; tester understands anyone with link can act. |
| Mobile upload | Uploads a small synthetic PDF/photo, sees progress and success, retries one controlled network interruption, verifies no duplicate or lost file. Record exact model/OS/browser. |
| File review and history | Accountant opens/decrypts with own key, marks reviewed, sees item and request history accurately. |
| Email and reminders | Uses a test relay only; verifies link destination, sender identity, duplicate-send behavior and no key/secret in email/log. |
| Staff invitation | Invites a second synthetic practitioner, accepts one-time link, verifies intended role/key access, then removes member and checks sign-in refusal. |
| Logout and repeat login | Logout invalidates workspace session; repeat password login succeeds. |
| TOTP | Enrols authenticator, completes a fresh challenge, rejects a wrong code and uses a recovery code once only. |
| Cancellation and link policy | Explains scheduled end, payment grace, pause after grace/immediate cancellation, resubscription behavior and that submitted data is retained. |
| Export / recovery | Follows owner export support steps, verifies archive, understands encrypted export requires their key and what deletion/backup windows mean. |
| Error messages | Wrong link, expired/revoked link, upload-too-large, failed auth, disabled account, network and storage full errors are understandable and non-disclosing. |
| Keyboard | Complete signup/workspace/client request/upload/review/exit flow using keyboard only; check focus visibility/order and validation announcements. |
| Screen reader | Test at least NVDA with Firefox/Chrome and VoiceOver with Safari if supported; verify labels, headings, upload status, errors, dialogs and TOTP. Record actual versions and a human tester. |

Existing test DOM shims and HTTP snapshots are not evidence for screen readers or mobile browsers. The actual browser and device list is an operator decision; run this plan before even a synthetic outside-practice demo.

## Operator facts and legal review checklist

Do not fill these from assumptions. Store evidence in the private deployment record, not the public repository.

- [ ] Legal/business name, registration number, business address, jurisdiction and tax residence.
- [ ] Public support/privacy contact, owner for rights requests, founder incident contact and alternate contact.
- [ ] Hosting provider, VM region, backups region, storage encryption settings, administrative access list and data export capability.
- [ ] Backup provider, Restic version, repository location, encryption recovery escrow, actual retention, immutable/versioning behavior, deletion delay and measured restore time.
- [ ] Email/SMS provider names, country/location, DPA and configured sender; document disabled providers too.
- [ ] Stripe contracting entity/account region, account verification, subscription portal settings, GBP price ID, tax/VAT registration/tax display, receipts, disputes and refunds.
- [ ] Privacy notice, cookie/storage technology review, client-controller responsibilities, retention periods, rights workflow and data breach contacts.
- [ ] Article 28 DPA, subprocessors and locations, transfer mechanism/assessment, security schedule, audit assistance and deletion/return clause.
- [ ] Support hours and realistic target, cancellation and export steps, incident communications and customer notification ownership.
- [ ] Retention/backup hold policy, customer deletion confirmation and verified support export delivery channel.
- [ ] Insurance assessment: cyber, professional indemnity, public liability, business interruption and any broker exclusions for encrypted/financial data.
- [ ] UK solicitor review of consumer/business terms, liability, cancellation/refunds, data roles, cross-border transfers and electronic marketing. Accountant review of VAT and invoices.
- [ ] Independent security review proportional to financial/client data and selected host; close findings before real data.

The Phase 4 website and current hosted copy were checked against the code: £49/month, payment details required and immediate first charge/no trial, 5 GiB quota, 25 MiB file limit, browser-encrypted document bytes, visible metadata and key-loss limitations. No website claim was found promising client links survive cancellation; Phase 5 narrows the technical behavior. VAT, support, provider region, legal entity and backup guarantee are not stated as verified facts. Legal drafts remain drafts.

## Release gate status after local qualification

Use **Verified** only for direct evidence. Code presence alone is not deployment evidence.

| Gate | Final classification | Evidence / remaining condition |
|---|---|---|
| Hosted client-link access lifecycle | **Verified locally** | HTTP regression covers active, scheduled cancellation, grace, grace expiry, immediate cancellation, resubscribe, explicit revocation and ciphertext retention. External live service behavior remains unverified. |
| Full hosted recovery application journey | **Verified locally; remote infrastructure blocked** | New full-host integration starts restored app; owner/staff TOTP, request history, membership, isolation, encrypted file integrity/decryption, deleted tenant absence and failed promotion checks pass. Fake Restic only. |
| Stripe reconciliation procedure/command | **Verified locally; external Stripe test-mode blocked** | API response projection, association validation, corrected/confirmed audit and API failure rollback are synthetic tests. No authorised Stripe test credentials or CLI used. |
| Billing state machine webhooks | **Verified locally; external test-mode blocked** | Synthetic HTTP integration covers duplicate, old, same-second, customer mismatch, invoice, recovery, cancellation, resubscribe. No real Stripe event delivery. |
| Coverage | **Locally verified, gate status pending final run** | Thresholds unchanged; see final verification at end of this document. |
| Docker | **Requires external daemon** | Do not probe an app on port 3000. `docker info` result and build/runtime outcome go in final evidence. |
| systemd / TLS / provider backups / alerts | **Requires operator action and external infrastructure** | Local config review only; no public HTTPS or remote provider evidence. |
| Real-browser, mobile, screen-reader checks | **Requires operator action/devices** | Five-person acceptance plan prepared; no participant or device study claimed. |
| Customer export and deletion | **Locally testable process; external delivery/retention open** | Tools produce/verify export and offboarding; secure customer delivery and actual backup expiry need operator-selected channels/provider. |
| Legal / commercial | **Requires operator action and independent professional review** | Phase 4 draft set and facts checklist exist; blanks remain and nothing is final. |

### Original audit finding roll-up

| Finding | Phase 5 classification | Evidence and residual condition |
|---|---|---|
| F-01 hosted login throttling | **Verified in code/tests; operation assumption remains** | Account/source throttles exist; limiter is process-local, so private pilot must remain one app process or provide a shared edge limiter. |
| F-02 hosted TOTP | **Verified locally** | Restored owner and staff both passed real handler password+TOTP challenge. Authenticator/device UX is not a manual device test. |
| F-03 invitation lifecycle | **Verified locally** | Keyed hosted invitation issued/accepted through real HTTP paths in the restore test; revocation remains covered by existing regression tests. |
| F-04 trial / price | **Partially fixed** | No trial is advertised; price preflight and billing tests pass. Real Stripe test account lifecycle remains open. |
| F-05 hosted storage limit | **Verified locally** | Tenant quota and reservations have synthetic regression coverage; actual provider capacity is external. |
| F-06 export / deletion / retention | **Partially fixed** | Export/offboarding and restore tombstones are exercised. Secure delivery and remote snapshot expiry are not configured. |
| F-07 legal package | **Partially fixed** | Drafts exist; entity, provider, locations, retention, tax and professional review are open. |
| F-08 disaster recovery | **Partially fixed** | Full local application recovery now passes; fake Restic transport only. Actual off-site backups, measured RPO/RTO and host drill are open. |
| F-09 webhook idempotence/order | **Fixed locally for tested cases** | HTTP/synthetic tests cover duplicate, delay/order, same-second cancellation, association, invoice and restart. Stripe delivery and reconciliation credentials remain open. |
| F-10 upload orphans | **Verified locally** | Existing age-bounded reconciliation tests remain in the suite. |
| F-11 safe file handling | **Partially fixed / operator-dependent** | Encryption and server-visible metadata are correctly disclosed. The server cannot malware-scan encrypted content; owner-side safe download/opening and endpoint security remain operator/customer controls. |
| F-12 observability | **Partially fixed** | Structured status/backup/log guidance exists. External alert routing, TLS monitoring, multi-process throttling and an alternate responder need setup. |
| F-13 UX accessibility | **Open for manual validation** | Static checks run, but no actual browser was available to this agent, and no mobile/screen-reader testers ran. |
| F-14 pending-payment lifecycle | **Partially fixed** | Reaper and retention/holds exist; systemd scheduling and remote backup interactions need an operator-host test. |

## Pilot readiness verdicts

### A. Synthetic demo — **PASS, local and synthetic only**

**Technical evidence:** the real hosted HTTP app, synthetic practice/client/request, browser crypto module, invitation flow, encrypted client upload/download, TOTP, restore and server-side isolation tests pass. The Phase 5 full-recovery integration recovers a 51-byte synthetic encrypted document and opens it using the practice recovery key.

**Dependencies/risks:** A live hosted demo still requires a controlled host, HTTPS, safe demo accounts and no real data. The full recovery test used fake Restic transport. Browser accessibility/device behavior is untested. Demo users must understand links are bearer capabilities and the server sees metadata.

**Closure actions:** use the five-tester checklist on a selected browser/host, verify public HTTPS and email relay, use only fictional data, and reset the demo store afterward.

### B. Private pilot — **CONDITIONAL for synthetic-only; FAIL for real client documents today**

**Synthetic-only condition:** up to three invited practices may evaluate workflow only on an isolated, founder-supervised instance with fictional people/documents, public TLS, configured external backup/restore and monitoring, owner TOTP, controlled invitations, published temporary support contact, and a documented reset/deletion date. Do not use this branch's fake-backup evidence as their data recovery guarantee.

**Real documents:** **not qualified**. Provider location/terms, actual offsite backup and restore, public TLS, Stripe test-mode behavior, support/export delivery, deletion expiry, legal roles/DPA, data protection review, independent security review and manual accessibility are open. There is no verified incident/coverage arrangement or measured operational recovery objective.

**Closure actions:** complete every P0/P1 external gate and obtain operator/legal approval before switching any pilot to real customer data. Keep billing test-only until test lifecycle succeeds; real billing requires a separate explicit authorization and later release decision.

### C. Public paid launch — **FAIL**

**Technical evidence:** strong local tests now include billing order/idempotence, full app restore, access gating and encrypted document preservation. The configured coverage command remains a hard gate if it exits nonzero.

**Open dependencies:** no production host/domain, real HTTPS, offsite provider, remote restore/retention proof, Stripe test-mode evidence, support coverage, final legal/privacy/DPA/tax facts, customer exit delivery, independent security review or representative capacity/accessibility test. Live payment was not activated.

**Closure actions:** close the P0/P1 table, rerun all checks with passing coverage, obtain professional reviews and bring back a new evidence-backed release decision. Do not accept public signups or sensitive documents.

## Five highest-priority next actions for the founder

1. Select host, public domain and one-founder support/incident coverage; configure HTTPS, least privilege, encrypted volumes and out-of-band monitoring.
2. Select a real off-host backup provider and region, protect Restic recovery credentials separately, run an actual remote backup and restore/decrypt/tombstone drill.
3. Configure an isolated Stripe test account/CLI and complete Checkout, payment-failure/recovery, scheduled/immediate cancel, duplicate/delayed webhook, resubscription and reconciliation.
4. Fill the operator/business/privacy facts; obtain UK legal/accounting review of terms, privacy, DPA/subprocessors, VAT, retention, cancellation and customer export.
5. Raise coverage above unchanged thresholds with behavior-focused tests; run the five-person browser/mobile/accessibility plan and independent security review before any real customer documents.

## Final verification record

### Automated and local checks

- Starting point: `codex/tickmark-commercial-readiness` at `1d3afd8f5a9ab667038684c7e4c277ed0441616b`.
- Baseline suite at that SHA: **544 passed, 0 failed**. Phase 5 full suite: **548 passed, 0 failed**.
- Focused recovery, billing reconciliation and hosted gateway tests passed. The recovery test created two synthetic practices, accepted a keyed staff invite, used owner and staff TOTP, restored an older backup, replayed one deletion tombstone, confirmed isolation, and decrypted the 51-byte synthetic file after checking its ciphertext digest. Restic was a fake adapter; this is application behavior evidence, not an offsite-provider drill.
- Isolated self-hosted HTTP persistence check on port 3317 passed across an application restart. Signup, request creation, two encrypted uploads, key rotation, retirement and subsequent sign-in were exercised with fictional Northwind data. After restart, the request remained, one live key and the retired-key history remained, and both files opened with intact content. Data lived under a disposable temporary directory; port 3000 and customer data were not used.
- `npm run check:site`, `npm run check:docs`, `npm run check:style`, `npm run check:nav`, `npm run snapshot`, `npm run check:pages`, and `npm run check:gateway` passed. The snapshot contained 42 pages; the intentionally unknown route returned 404, and the other pages passed.
- `git diff --check` passed before the final report edit; it is rerun before commit.
- `npm run coverage` **failed the configured gates**. Measured totals: **90.91% lines / 88.10% functions / 73.96% branches** against unchanged minimums of **93% / 90% / 75%**. Do not waive the gate; add behavior-focused coverage and rerun before any launch qualification.

### External and manual checks not completed

- Docker Engine unavailable: the Docker CLI could not connect to the Docker Desktop Linux engine pipe. No container image/build or compose restart was verified.
- Stripe CLI and Stripe credentials were not configured. No Stripe test-mode API or webhook drill was run; no live billing was activated. The new reconciliation code is unit-tested only.
- Browser automation could not initialize its kernel. There was no manual browser, mobile, keyboard, screen-reader or five-person usability test.
- No production host, HTTPS/domain, mail relay, external backup provider, remote restore, backup retention expiry, systemd schedule, alert route, measured RPO/RTO, or independent security review was available. No real customer documents, account, payment, data export, deletion, outreach or production changes were used.

### Branch and repository state

The qualification branch is `codex/tickmark-launch-qualification`, created from the exact Phase 4 SHA above. The Phase 4 audit checkout's pre-existing dirty `docs/go-succeed-prep.md` was left untouched. Final commit IDs, pushed branch SHA, clean worktree status and the final diff check are reported in the task handoff after push.

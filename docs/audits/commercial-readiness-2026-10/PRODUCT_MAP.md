# Product map and claims verification

## User journeys

Self-hosted onboarding: run the server, sign up with email/password, create a practice encryption key/passphrase, and save a recovery sheet. Mail is optional for drafts but required for delivery; operator configures and tests SMTP. First client is created from the request workflow. A first request is roughly seven actions after the server is running: account, key/passphrase, client/request details, checklist, save, issue link, send/copy. Mail setup/recovery/key explanation add friction.

Hosted onboarding adds platform account, Stripe checkout, workspace login and key setup. The README promise of a 14-day no-card trial is not supported by the checkout request.

Request flow: create/import client; build checklist/date/title; issue expiring random bearer link; email or copy; client opens without account; browser encrypts and uploads each file; client may send extras/messages or mark unavailable/later; practice receives notice, opens request, decrypts locally and accepts/flags; reminders can be drafted or sent; request is ready only when every active requested item has an unflagged upload; close/reopen/re-raise from template. CSV exports and file download exist. Hosted whole-tenant export/deletion/offboarding do not.

Failures handled: expired/revoked links, invalid envelope, bad key ID, size/count caps, upload errors and mail errors. File quality checks are advisory. Duplicate requests/files are not prevented server-side. Public link holder can upload until expiry/revocation.

## Claims against implementation

| Claim | Code/evidence | Assessment |
|---|---|---|
| Client needs no account | **src/app.js** public /r routes; **src/client-portal.js** | Implemented and tested |
| Files encrypted before upload | **web/tickmark-crypto.js**, **web/upload.js**, **src/client-portal.js:acceptEnvelope**; test/link.test.js | Implemented and tested; compromised-origin/device limitation applies |
| Server cannot decrypt | Browser-generated ECDH private key, passphrase-wrapped copies, AES-GCM envelope | Ciphertext-only storage supported. Metadata remains visible; operator can alter delivered JS |
| Multi-user practice | **src/members-views.js**, **src/roles.js**, role/invite/removal tests | Self-hosted works; SaaS lifecycle integration incomplete |
| Separate practice data | Practice-scoped store functions; SaaS per-practice files in **src/tenancy/pool.js**; tenancy/saas tests | Implemented/tested; not an independent penetration test |
| Secure staff invitation | One-use/expiring/revocable; secret in URL fragment; **src/members-views.js**, **web/invite.js** | Self-hosted supported with bearer risk; SaaS account bridge incomplete |
| Document verification | **src/board-views.js**, **src/store.js** | Review state is practitioner judgement, not identity/malware/content verification |
| Reminders | **src/chase-views.js**, **src/mailer.js**, **src/sms.js** | Code exists; real delivery/reputation/consent require deployment evidence |
| Auditability | **src/store.js:recordEvent**, request history | Event history, not tamper-proof/WORM audit certification |
| Recovery | **src/keys-views.js**, **web/recovery.js** recovery sheet | Implemented; loss of passphrase and sheet is unrecoverable |
| Export/deletion | CSVs/downloads in **src/clients-views.js**, **src/board-views.js**; backup tools | Partial; no hosted tenant-wide export/delete/offboarding |
| Hosted £49/month | README/site; Stripe Price ID from environment | Price is not enforced in app; actual Stripe price is deployment evidence |
| 14-day no-card trial | README/site versus **src/tenancy/stripe.js:createCheckoutSession** | Incorrect/misleading; trial field absent |
| Free self-host/AGPL | LICENSE, package.json, Dockerfile, README | Source/licence claim verified; does not prove operator setup |
| Unlimited clients | Site/README; no client metering | No per-client billing, but finite shared disk and no aggregate tenant quota |
| No third-party auth/tracking | Empty dependency list; static site checks | App has first-party session cookies; no analytics found |

“Ready” means every active requested item has a file and no attention flag. It does not prove a file is authentic, safe or complete. Event history is not immutable evidence.

## Friction

Owner must protect a high-impact passphrase/recovery sheet; hosted setup spans gateway and workspace; hosted staff invites do not create matching platform membership; one link covers one request; no recurring schedule; and mail errors require manual follow-up.

# Feature and Workflow Audit

Method: route table read in full (`src/app.js:121`–`280`, ~120 routes); the primary journey executed against a
running instance with fictional data; and the practice and client screens **rendered and screenshotted in a real
browser** at 390–1282 px ([BROWSER_VERIFICATION.md](BROWSER_VERIFICATION.md)). Classifications use the requested
vocabulary.

## 1. Classification key

`✓ Verified` — observed working in the running app.
`◐ Partial` — implemented, with a stated limitation.
`◻ Prototype` — present but thin.
`✗ Absent` — not built.
`⊘ Refused` — deliberately not built, with a written reason.
`? Not verifiable` — needs a real device, relay, provider or human.

## 2. Practice-side features

| Feature | Class | Evidence |
|---|---|---|
| Registration (email-verified) | ✓ Verified | `/signup` → "Check your email" → `/verify/:token`; account created only on the link |
| Sign-in + TOTP second factor | ✓ Verified | `/signin`, `/signin/code`; RFC vectors in `test/two-factor.test.js` |
| Password reset by email | ✓ Verified | `/forgot`, `/reset/:token`; `test/account-recovery.test.js` |
| Session management (list / end one / end others) | ✓ Verified | `/account/sessions` returned 200; `POST /account/sessions/end-others` |
| Own password / own email change | ✓ Verified | `/account/password`, `/account/email` |
| Practice naming | ✓ Verified | `POST /members/name` |
| Encryption-key setup + recovery sheet | ✓ Verified | `/setup`, `/keys` (200), `/keys/:id/recovery-sheet`, `/recover` |
| Key rotation + re-encryption of stored files | ✓ Verified | `/keys/:id/move`, `/files/:id/reencrypt`, `/keys/:id/retire`; `test/reencrypt.test.js` |
| Members: invite, revoke, change role, remove, notify setting | ✓ Verified | 8 routes under `/members`; invite accepted in the demo |
| Three roles (owner / accountant / assistant) | ✓ Verified | `src/roles.js:41`; route requirement enforced centrally at `src/app.js:500` |
| Client directory + client record | ✓ Verified | `/clients`, `/clients/:id`, `POST /clients/:id` |
| CSV / Xero / QuickBooks client import | ◐ Partial | `/clients/import`, `/integrations/xero/*`, `/integrations/quickbooks/*`; OAuth needs registered apps → ? unverifiable here |
| Request creation with checklist | ✓ Verified | `POST /requests`; used in the demo |
| Request editing after creation | ✓ Verified | `GET|POST /requests/:id/edit` |
| Request duplication / carry-forward / re-raise | ✓ Verified | `POST /requests/:id/again`; "Duplicate" and "Do this again" on the page |
| Templates (create, edit, add/remove items, delete) | ✓ Verified | `/templates` 200; 7 routes |
| Save an existing request as a template | ✓ Verified | `POST /requests/:id/save-as-template` |
| Bulk ask everyone at once | ✓ Verified | `/ask-everyone` 200; `test/ask-everyone.test.js` |
| Due dates + overdue tracking | ✓ Verified | Board separates outstanding/overdue; `src/clock.js` |
| Link issue with expiry (7/30/90 d) + revoke | ✓ Verified | `POST /requests/:id/link`, `/revoke`; live page shows "created … expires …" |
| Email the request (draft then send) | ◐ Partial | `POST /requests/:id/send`, `/send-request`; real send needs a relay → ? |
| Reminder drafting + sending | ◐ Partial | `POST /requests/:id/remind`, `/send-reminder` |
| Chase everyone at once, with a report | ✓ Verified | `/chase` 200; `test/chase.test.js` |
| Chase cadence (practice-set) | ✓ Verified | `POST /chase/cadence`; `test/cadence.test.js` |
| Chase suppression (don't nag twice) | ✓ Verified | `test/chase-suppression.test.js` |
| SMS reminder alongside email | ◐ Partial | `src/sms.js`, `sms.sent`/`sms.failed` events; needs a gateway → ? |
| Log a non-email contact (call, letter) | ✓ Verified | `POST /requests/:id/contact`; stops the chase re-writing |
| Per-item review: checked / needs attention / stop asking | ✓ Verified | `POST /requests/:id/items/:id/:state`; reason stored beside the file |
| Bulk "check all arrivals" | ✓ Verified | `POST /requests/:id/check-all` (used in the demo) |
| Client replacement / resubmission | ✓ Verified | `test/review.test.js`; "please send this again" copy |
| Add a document on the client's behalf | ✓ Verified | `POST /requests/:id/files` (encrypted in the practice's browser) |
| Download one / download everything as ZIP | ✓ Verified | `web/download.js`, `web/zip.js`; plaintext never leaves the tab |
| Close / reopen a request | ✓ Verified | `POST /requests/:id/close`, `/reopen`, plus `/requests/close` for several |
| Search and filtering | ✓ Verified | `/requests?q=`, `/files?q=`; both returned 200 |
| CSV export (requests, history, files) | ✓ Verified | `/requests.csv` → `attachment; filename="tickmark-requests.csv"` |
| Dashboard board by whose-turn-it-is | ✓ Verified | `/requests`; counts per state |
| Audit history / event log | ✓ Verified | Timeline on the request page (`request.created`, `link.issued`, `upload.received`, `item.checked`) |
| Tenant export / restore / offboarding (hosted) | ◐ Partial | `src/tenancy/practice-export.js`, `offboarding.js`, `tools/export-tenant.mjs`; operator-only, untested against real storage |
| Billing / subscription (hosted) | ◐ Partial | `src/tenancy/stripe.js`, `billing.js`; **never called against a real Stripe account** |
| Data retention / deletion | ✓ Verified | `TICKMARK_DELETION_GRACE_DAYS`, tombstones, `tools/finalize-deletions.mjs` |
| Two-factor recovery codes | ✓ Verified | `POST /account/two-factor/codes`; `test/two-factor-flow.test.js` |
| Signed engagement letter / e-signature | ✗ Absent | Named as a gap in `docs/competitive.md` §"Still genuinely missing" |
| Form builder / structured questionnaire | ✗ Absent | Deliberate scope call |
| Search inside documents | ⊘ Refused | `docs/audit.md:29` — "Refused, not deferred", because a server that can search can read |
| Scheduled/recurring asks without a human | ⊘ Refused | `docs/audit.md:31` — "the thing this product declines to be" |

## 3. Client-side features

| Feature | Class | Evidence |
|---|---|---|
| Open a link with no account | ✓ Verified | `/r/:token` returned 200 with `asksForAccount: false` |
| Practice name + request context at the top | ✓ Verified | "FICTIONAL — Example Practice", request title, client name |
| Understand what is required | ✓ Verified | Per-item labels, "still needed", one plain sentence per item |
| Upload (single or multiple files) | ✓ Verified | Two encrypted uploads accepted with `201` in the demo run |
| Supported file types | ✓ Verified | `accept="image/*,application/pdf"`; phone photos explicitly welcomed |
| Progress and status feedback | ✓ Verified | "You have sent 2 of 3 documents"; `aria-live="polite"`, `role="status"` |
| Per-item state the client can read | ✓ Verified | "you sent … received", "Checked by the practice", "still needed" |
| Replace / resubmit after rejection | ✓ Verified | "please send this again" + the practice's reason shown verbatim |
| "I will send this later" / "I do not have this" | ✓ Verified | Both actions present; neither removes the item (practice's call) |
| Send an unrequested document | ✓ Verified | `POST /r/:token/extra` |
| Send a message (no file) | ✓ Verified | `POST /r/:token/message`; stays visible to the client |
| Return to the same link later | ✓ Verified | "Come back to this page with the same link" |
| Mobile usability | ✓ **Verified in a real browser** | Rendered at 390 px: single column, 44 px controls, native `<details>` trust panel, no horizontal overflow (`07`, `08`, `09`) |
| Expired / revoked / wrong link | ✓ **Verified in a real browser** | A bad token renders "No such link — check the address you were sent: it may have wrapped across two lines…" (`09-client-invalid-link-mobile.jpg`) |
| Failed / interrupted upload | ◐ Partial | Quota refused with remaining bytes and nothing stored; interruption behaviour is browser-dependent |
| Browser-side preflight checks | ✓ Verified | `web/preflight.js`: password-protected PDF, duplicate file, truncated `%%EOF`, photo too small — **all warn, none refuse** |
| Accessibility (labels, live regions, skip link) | ✓ Verified (structural) | 8 inputs all carry contextual `aria-label`s; `lang="en"`; single `h1` |
| Screen-reader / real-device behaviour | ? Not verifiable | No device or assistive technology available in this environment |

## 4. Journey findings

**The primary journey works, measured.** One command (`npm run demo:synthetic`) executed:

`signup → verify → name practice → create key → invite assistant → create request (3 items) → issue link →
2 × encrypted upload → check-all`

in **0.6 s of request time**, with no manual intervention and no failure. Every step returned the expected status
(`200`, `303` or `201`). That is the strongest single piece of evidence in this audit: the request log in
`evidence/demo-synthetic.log` shows the whole thing.

**No dead ends found.** Every page I fetched rendered at `200`; the 42-page render check (`npm run check:pages`)
reports *"all 42 pages look structurally sound"*, and `check:nav` confirms no page is unreachable.

### Friction and incompleteness worth naming

1. **Email is the only real-world chokepoint.** Without a relay the product is honest but constrained: it drafts and
   says it cannot send. A practice that expects "Send" to work on first run will be surprised. *Partial by design,
   but it is the first thing a trial user hits.*
2. **The passphrase is a hard wall with no recovery.** Correct and documented, but it must be *unmissable* during
   setup — and it is, on `/setup` and in the getting-started card.
3. **The client's upload control is the browser's native file input** ("Choose Files / No file chosen"). It is
   functional and honest; it is also the least polished element on the most important screen.
4. **A practice can attach a plaintext file to an outbound email** (`src/request-actions.js:590`). The label says
   "It goes out with this message and is not kept anywhere" — true, but it does not say *it is not encrypted* and
   *do not attach a client's document this way*. A one-sentence warning would close it.
5. **Xero/QuickBooks and Stripe are unexercised in this environment** — no OAuth apps, no test-mode keys. Buildable
   evidence exists in tests with stubs; real-provider behaviour is `?`.
6. **"Multiple entities per client" is absent**, and the author identifies it as the strongest signal in their own
   market research (`docs/audit.md:32`). No practitioner workflow in this checkout needs it, but it will appear.

## 5. The critical question

> **Can a small accounting practice genuinely complete its primary document-collection workflow today without
> encountering a serious blocker?**

**Yes.** Not "mostly", not "with caveats that amount to blockers" — yes.

The chain *ask → link → client uploads with no account → practice reviews → practice chases → practice closes the
request* is complete and was executed end to end. The two conditions a real practice must satisfy first are
operational, not functional:

- **configure a mail relay** (or accept drafting-and-copying), and
- **generate and keep a passphrase** (there is no recovery, by design).

Both are stated plainly in the product before they can cause harm. Neither is a defect.

The honest qualification: *completing* the workflow is proven. *Enjoying* it for a season, with real clients, over a
real phone, with real latency, is **unproven** — and that is a matter for a pilot, not for more code.

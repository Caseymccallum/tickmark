# Tickmark visual evolution

## Phase A: architecture and migration plan

Starting main: `dca09fe8ec027f17e8f45e45214caefa048676e3`. Branch: `codex/tickmark-visual-evolution`. Final implementation commit: `431da9ed7566cb8d144b3e71eecb850a829b2276`; this report-only commit follows it, and the delivery HEAD is recorded in the handoff. The original audit checkout and its dirty `docs/go-succeed-prep.md` remain separate.

Reviewable phases: A `95daa2f` (contract/tokens); B `dcd5dbb` (marketing/build); C `ed8a6d8` (gateway); D `b7a5e48` (workspace); E `293194c` (client checklist); F `431da9e` (accessibility, compatibility and evidence).

The app renders tagged/escaped HTML from `src/views.js`; `page()` owns the shared shell, CSP-nonced inline stylesheet, skip link, theme metadata, footer and small selection handler. `src/style.js` contains semantic tokens and component sections. `src/app.js` owns the core route table. Hosted gateway rendering is in `src/tenancy/views.js`; `entry.js`, `gateway.js` and `resolve.js` retain host/path, membership and billing semantics. `web/*.js` attach to existing forms and IDs for browser encryption and interaction. Marketing is the independent `site/index.html`, currently never served at hosted platform root.

No repository AGENTS or contribution file was found. Relevant guidance: README; docs/design.md, mvp.md, roles.md, members.md, encryption.md, security.md, saas.md and the Phase 1–5/release reports. CI additionally runs the unused-export and container checks.

### Screen and form inventory

| Surface | Renderer and existing routes/workflows | Shared dependencies |
| --- | --- | --- |
| Self-hosted entry and account | signin-views.js: landing, signup, verification, sign-in, password reset, account email/password and session management; account-views.js: TOTP setup, challenge, recovery and disable | page, center/card, labels, notices, existing auth fields |
| Hosted gateway | tenancy/views.js: signup, login, TOTP/expired challenge, dashboard, no-workspace state, active/pending/past-due/cancelled subscription, checkout/return, errors | page, gateway, state, facts, promise, inline POST actions |
| Requests overview | board-views.js: /requests, open/closed/state/search/order filters, onboarding steps, export, new request | page-head, tiles, bar/seg/search, board table, empty |
| Request lifecycle | request-actions.js and board-views.js: new/duplicate/edit, checklist, review/check-all, attention/replacement, answers, link issuance/revocation, send/reminder previews, close/reopen, contact/history, file download/re-encryption | items table, cards, timeline, confirmation forms, existing IDs/actions |
| Clients and files | clients-views.js: directory, search/import/CSV, client detail/edit/filing profile/history, requests and files; all-document metadata search/download | tables, facts, file rows, search and notices |
| Templates and bulk requests | templates-views.js and bulk-ask-views.js: list/new/edit, save checklist, ask-everyone preview and explicit send confirmation | card forms, pick list, preview, actions |
| Reminders | chase-views.js: chase board, drafts, preview/run/limited progress, cadence/budgets, message history | tables, notices, confirmation, tiles |
| Team/security/settings | members-views.js, keys-views.js, account-views.js: roles, invitation create/accept/revoke/recovery, remove, notification preferences, key generation/copy/recovery/rotation/move/retirement, TOTP and sessions | cards, warnings, code/key fields, live status, role-gated forms |
| Integrations | integrations-views.js, xero-views.js, quickbooks-views.js: connections, import/sync/profile, consent, disconnect, provider errors | same shell/cards/tables; OAuth semantics retained |
| Client portal | client-portal.js: open/expired/revoked/unknown/not-ready/closed request, checklist, upload/receipt/replacement, cannot-provide/later answers, extra files, messages; resolver subscription pause | page, upload.js, practice-key/upload-limit/already-sent JSON, form.upload/status selectors |
| Marketing | site/index.html: hero, fictional previews, benefits, four-step flow, security, pricing, self-hosting, FAQ, footer | generated copy of canonical tokens, standalone CSS, no app state |

All core endpoints/forms remain in the existing route table; no capability is added by navigation labels. The 42-page HTTP snapshot and 14 gateway states are the representative state matrix; render/interaction tests cover additional security, empty and error states.

### Controlled migration

A. Establish this inventory and DESIGN.md; refine tokens and reusable controls. B. Redesign static marketing and document configurable two-origin hosting. C. Apply hosted account layouts without altering field names/actions. D. Replace crowded workspace navigation with a shared shell and improve dense workflows through existing primitives. E. Render client checklist as responsive cards, retaining upload form selectors and cryptography. F. Run regression, structural, contrast and security checks; record unsupported browser/manual evidence.

Browser automation initialization failed with `failed to write kernel assets ... path specified`. No before/after browser screenshots or visual inspection is claimed unless later evidence supersedes this limitation.

## Phase B: public website and hosting

The public page now presents the checklist, review, outstanding-item, upload and reminder workflows as labelled fictional illustrations. Six benefit blocks, four steps, encryption/metadata/recovery explanations, seven FAQs, truthful pricing and a self-hosted path share the application tokens. No hosted paid signup is active. `src/style.js` exports the canonical token block; `tools/build-marketing.mjs --sync` updates its committed copy in the standalone source. `check:site` rejects drift.

### Recommended two-origin topology and operator procedure

1. Choose domains you own: the apex or www host serves only the static output; an app host proxies the hosted server. No domain is selected or provisioned here.
2. Set `TICKMARK_MARKETING_URL` to the HTTPS marketing origin and `TICKMARK_PUBLIC_URL` to the HTTPS app origin. Run `npm run build:site -- <new-output-directory>`. Publish only the generated `index.html` with the static host. Without configuration, sign-in goes to the on-page hosted-access explanation. The output adds canonical/OG URLs and app `/login` links, never a paid signup CTA.
3. Run the application separately with its existing `MULTI_TENANT=1`, data roots, TLS reverse proxy, trusted proxies and secure-cookie settings. The optional marketing URL adds a public-website link only; it does not change cookie scope, route dispatch, authentication or redirects.
4. With `TICKMARK_TENANT_DOMAIN` unset, retain `/t/<slug>` mode on the app origin. Host mode keeps the existing `<slug>.<tenant-domain>` resolver and requires owned DNS/TLS/host allowlisting. A switch between these modes or an existing origin requires operator planning for existing links, sessions, host maps and provider callbacks; this redesign performs no migration.
5. Keep Stripe return/webhook and OAuth callback URLs on the configured app origin and existing paths. Check them in isolated test mode before any separately approved launch. Do not redirect `/r/*` or `/invite/*` to marketing: bearer URLs remain on the application, under `Referrer-Policy: no-referrer`. No token is interpolated into a public-origin URL.
6. Marketing may be indexed; application pages emit `noindex, nofollow`. The static host should set appropriate CSP, `nosniff`, HTTPS/HSTS and no-referrer headers. The app retains its nonced CSP, same-origin form actions, CSRF checks and host-only secure cookies. Do not widen cookie Domain to connect marketing and app.

Build configuration accepts HTTPS origins only, rejects credentials, paths, query strings and fragments, and never reads a request's return URL. Default standalone output performs no external resource fetches. No DNS, provider, billing, deployment or legal-publication action is included.

## Phase C: hosted account experience

Signup and login use a two-column introduction/form-panel composition on desktop and stack below 48rem. TOTP/expired challenges, dashboard, billing walls and return/error screens retain the shared cards, states and readable facts. Labels, actions, methods, names, challenge tokens and billing meanings remain intact. Error notices announce as alerts; account confirmations announce as status. The TOTP input permits the keyboard needed for alphanumeric recovery codes and points to its explanatory text. No session, membership, billing or encryption implementation is changed.

## Phase D: practice workspace

The common renderer now gives every signed-in practice page a 14.5rem desktop navigation rail, grouped workspace/practice routes, an account-security entry and an existing POST sign-out. Under 64rem, a native details menu replaces the rail and preserves keyboard behavior without new JavaScript. The same escaped navigation fragment renders both contexts. Existing routes, role checks and source-of-truth overview counts remain unchanged; no analytics are invented.

Requests, clients, documents, templates, reminders, team, keys and integrations reuse the larger controls, page headings, surfaces and spacing. Request detail adds a native, labelled received-document progress indicator; review status still distinguishes received from checked. History becomes a readable timeline. Core table regions now have keyboard focus and accessible region names, preserving real table structure and narrow-screen horizontal scrolling. Shared empty states, warning/confirmation forms and passphrase fields remain intact. Every application page is noindex/nofollow; the optional public-site link accepts a validated operator HTTPS origin and carries no token/query data.

## Phase E: client checklist and upload

The client page now leads with practice identity, request/client/deadline, and a plain next step. A native disclosure explains encryption and visible metadata without displacing the task. Each checklist item is a responsive card containing its receipt, review/replacement state, file picker, optional note and existing answer actions. Files remain encrypted by the unchanged `web/tickmark-crypto.js` / `web/upload.js` implementation. The module still attaches to `form.upload`, existing input names, action URLs and `.status` elements; no plaintext is posted.

Native progress describes items with files, not acceptance. Received files separately say awaiting review or checked; replacement reasons stay visible. A new regression reproduced the old misleading all-arrived success notice when an item needed replacing; the notice now stays suppressed in that state. Extra files/messages, expired/revoked/not-ready links and subscription-paused routes retain their semantics. Dynamic upload statuses have polite, atomic live-region announcements. File inputs accept the same PDF/image types and multiple files; camera access remains a browser/OS file-picker capability, with no forced camera attribute.

## Phase F: accessibility, compatibility and evidence

### Reuse and responsive behavior

The one shared STYLE string remains canonical; no frontend dependency was added. The final stylesheet is approximately 51.6 KB raw (about 13 KB gzip); the standalone marketing page is 29,070 bytes (9,187 bytes gzip), with no fetched fonts, scripts or imagery. The website token copy is checked byte-for-byte against DESIGN_TOKENS. Design instructions in docs/design.md now point to the current contract instead of stale token values.

Desktop workspace content uses a fixed-width navigation rail and flexible/min-width-zero main column. Native mobile navigation replaces it below 64rem. Gateway forms stack at 48rem; client cards are one column; table regions scroll independently and are keyboard-focusable with accessible names. Inputs use 16px text on smaller screens to avoid common mobile focus zoom. Headings and client filenames wrap long content. Numeric progress is labelled and never substitutes for review status. No dialog or focus trap was introduced.

Visible focus outlines, a focusable skip target, polite/atomic upload and key/invite status announcements, text-mode recovery-code input, and contrast-safe control boundaries are added. Existing semantic labels, SVG names, native controls, reduced-motion behavior and high-contrast adaptations remain. The page checker now rejects scrolling table regions without a name and keyboard access. The style checker measures all 38 text/background pairs at 4.5:1 plus control borders on all three surfaces at 3:1 in both themes; the tightest text pair measures 5.00:1. This is automated evidence, not a full WCAG 2.2 AA claim.

### Security and behavior compatibility

No database, authentication/session, role, quota, billing, encryption, backup or restore implementation was replaced. Form names/actions/IDs and browser-module selectors are retained. The only request-state adjustment is presentation: an item marked for replacement suppresses the misleading all-arrived success notice; a new HTTP regression covers upload, review and replacement. The existing client-note ordering test now targets the new checklist rather than the removed table, preserving its assertion that the practice note precedes the document list. Existing disclosure wording and current-section navigation text selectors remain compatible.

The shared HTML tag continues escaping values; inline styles/scripts retain per-response CSP nonces; no style attributes, remote scripts/fonts, unsafe-inline policy or cross-origin form actions are added. Public-origin configuration comes only from operator environment values, is validated as an HTTPS origin, and is escaped into markup. Client tokens are never attached to marketing links. Host/path tenancy, cookie scope, CSRF checks, Stripe return/webhook paths and the platform root signup/dashboard redirect remain unchanged. Marketing and app remain separately deployable source in this repository.

### Verification record

- Starting baseline: 556 tests passed, 0 failed. Coverage: 91.33% lines, 74.52% branches, 88.68% functions; command exited 1 against unchanged 93% / 75% / 90% thresholds.
- Final full regression: 562 tests passed, 0 failed, including hosted identity/TOTP/recovery, invitation interruption/revocation, isolation, encrypted upload/decryption, key rotation/recovery, storage/quota/reconciliation, export/offboarding/tombstones, billing ordering/reconciliation/link gating, and full-host recovery.
- Six targeted visual-system tests cover operator-origin validation, standalone build configuration, escaped hosted forms, scoped challenge/recovery input, workspace/mobile navigation/sign-out, and client receipt/review/replacement.
- Final coverage: 562 passed, 0 failed; 91.57% lines, 74.65% branches, 88.86% functions. The command exits 1 against unchanged 93% / 75% / 90% thresholds. This improves on the starting measurement; the existing shortfall remains a separate release blocker, with no threshold or production inclusion change.
- check:site, check:docs (27 linked documents), check:style, check:nav, snapshot (42 HTTP-rendered pages), check:pages, check:gateway (14 states), find:unused (514 exports, zero unused) and git diff --check pass.
- Static build runs successfully to a disposable output directory with no operator URLs; targeted tests build configured HTTPS sign-in/canonical output and reject a bearer-path origin.

### Browser and manual-review limits

Both the browser automation entry point and the computer-use skill's alternate Node runtime failed initialization: `failed to write kernel assets: The system cannot find the path specified (os error 3)`. No real-browser screenshots, visual layout inspection or assistive-technology/device session was completed. HTML snapshots are rendered HTTP evidence, not screenshots. No browser result is substituted with a mock.

The following manual matrix remains unverified: desktop 1440px, tablet 768px, mobile 390px/320px; light/dark/system high contrast; keyboard-only menu/form/table navigation; 200% and 400% zoom; screen-reader heading/label/live-region output; native photo/file picking; long names, large upload failures/retries, and real-device touch behavior. Review the desktop sidebar/mobile details positioning and dense key-management tables in particular. The static preview illustrations show supported behavior but are not screenshots of a live paid service.

### Operator deployment steps and remaining decisions

Replace the angle-bracket values below with origins the operator owns. This prepares local static output only:

```powershell
$env:TICKMARK_PUBLIC_URL = 'https://<owned-app-host>'
$env:TICKMARK_MARKETING_URL = 'https://<owned-marketing-host>'
npm run build:site -- tmp-marketing-release
```

Serve that output through the selected static host. Separately configure the hosted process with `MULTI_TENANT=1`, the same app/marketing origins, its existing data roots, secure cookies and trusted TLS proxy. Use slug-path mode until an owned tenant domain and certificates are deliberately configured. Keep insecure cookies disabled outside local HTTP trials. Configure CSP/HTTPS/static cache headers at the public host, and retain the app's stronger dynamic CSP/referrer headers. Register provider callback URLs against the app origin only. Existing-origin changes need a separately planned link/session/provider migration.

Before any public hosted offer: complete actual infrastructure, backup/restore/retention and incident validation; publish a real support contact and reviewed legal documents; resolve coverage; complete the manual/browser matrix and independent security/accessibility review. Price, tax, support and launch approval remain founder decisions. This branch performs no deployment, DNS change, live Stripe activation or merge to main. It is delivered for review.

## Detailed rendering and form inventory

The following is a source inventory of renderer/action entry points and unique HTML form method/action pairs. Interpolated paths deliberately retain their template form; permissions and route matching remain in the existing app/gateway code.

### src/account-views.js

Entry points: `accountPasswordForm`, `changeOwnPassword`, `accountEmailForm`, `changeOwnEmail`, `accountSessionsPage`, `endOneSessionPage`, `endOtherSessionsPage`.

Forms: `POST /account/password`; `POST /account/email`; `POST /account/sessions/end-others`; `POST /account/sessions/end`.

### src/board-views.js

Entry points: `listRequests`, `newRequestForm`, `createRequestPage`, `viewRequest`, `requestsCsv`, `historyCsv`.

Forms: `GET /requests`; `POST /requests`; `POST /requests/${found.id}/items/${item.id}/uncheck`; `POST /requests/${found.id}/items/${item.id}/check`; `POST /requests/${found.id}/items/${item.id}/clear-attention`; `POST /requests/${found.id}/items/${item.id}/attention`; `POST /requests/${found.id}/items/${item.id}/withdraw`; `POST /requests/${found.id}/items/${item.id}/relabel`; `POST /requests/${found.id}/send`; `POST /requests/${found.id}/check-all`; `POST /requests/${found.id}/save-as-template`; `POST /requests/${found.id}/items`; `POST /requests/${found.id}/items/${item.id}/restore`; `POST /requests/${found.id}/revoke`; `POST /requests/${found.id}/link`; `POST /requests/${found.id}/remind`; `POST /requests/${found.id}/contact`; `POST /requests/${found.id}/files`; `POST /requests/${found.id}/reopen`; `POST /requests/${found.id}/again`; `POST /requests/${found.id}/close`.

### src/bulk-ask-views.js

Entry points: `askEveryonePage`, `askEveryone`.

Forms: `POST /ask-everyone`.

### src/chase-views.js

Entry points: `checkAllArrivalsPage`, `logContactPage`, `chasePage`, `setCadencePage`, `sendAllReminders`, `testEmailForm`, `testEmailSend`.

Forms: `POST /chase`; `POST /chase/cadence`; `POST /admin/test-email`.

### src/client-portal.js

Entry points: `clientPage`, `clientSays`, `acceptEnvelope`, `receiveExtra`, `clientMessage`, `receiveUpload`.

Forms: `POST /r/${params[0]}/items/${item.id}`; `POST /r/${params[0]}/items/${item.id}/says`; `POST /r/${params[0]}/extra`; `POST /r/${params[0]}/message`.

### src/clients-views.js

Entry points: `filesPage`, `filesCsv`, `listClients`, `clientsCsv`, `saveClient`, `viewClient`, `importClientsForm`, `importClientsRun`.

Forms: `GET /files`; `GET /clients`; `POST /clients/${found.id}`; `POST /clients/import`.

### src/integrations-views.js

Entry points: `integrationsPage`, `integrationsSync`.

Forms: `POST /integrations/sync`.

### src/keys-views.js

Entry points: `pendingFor`, `reencryptFile`, `retireKey`, `moveWithoutScript`, `setupForm`, `saveKeys`, `keysPage`, `changePassphrase`, `saveRecoverySheet`, `recoverPassphrase`.

Forms: `POST /setup`; `POST /keys/${current.id}/recover`; `POST /keys/${current.id}/recovery-sheet`; `POST /keys/${key.id}/passphrase`; `POST /keys/${key.id}/move`; `POST /keys/${key.id}/retire`.

### src/members-views.js

Entry points: `membersPage`, `createInvitePage`, `invitePage`, `acceptInvite`, `changeRolePage`, `removeMemberPage`, `removeMemberAction`, `setNotifyPage`, `renamePracticePage`, `revokeInviteAction`.

Forms: `POST /members/name`; `POST /members/notify`; `POST /members/${person.id}/role`; `GET (current URL)`; `POST /members/invite/${row.id}/revoke`; `POST /invite/${params[0]}`; `POST /members/${member.id}/remove`.

### src/quickbooks-views.js

Entry points: `quickBooksClientRows`, `quickBooksPage`, `quickBooksBooksSignal`, `quickBooksConnect`, `quickBooksCallback`, `quickBooksImport`, `quickBooksDisconnect`.

Forms: `POST /integrations/quickbooks/import`; `POST /integrations/quickbooks/disconnect`; `POST /integrations/quickbooks/books-signal`.

### src/request-actions.js

Entry points: `addFileForClient`, `serveEnvelope`, `issueLink`, `revokeLink`, `draftReminder`, `editRequestForm`, `saveRequest`, `draftOpening`, `sendOpening`, `sendReminder`, `closeRequestPage`, `reopenRequestPage`, `addItemsPage`, `changeItemPage`, `reRaiseRequestPage`.

Forms: `POST /requests/${found.id}/edit`; `POST ${sendTo}`.

### src/signin-views.js

Entry points: `home`, `signUpForm`, `signUp`, `verifyPage`, `verifyAccount`, `forgotForm`, `forgot`, `resend`, `resetForm`, `reset`, `signInForm`, `twoFactorPage`, `twoFactorStart`, `twoFactorConfirm`, `twoFactorNewCodes`, `twoFactorOff`, `signIn`, `signInCode`, `signInCodePage`, `signOut`.

Forms: `POST ${action}`; `POST /resend`; `POST /verify/${params[0]}`; `POST /forgot`; `POST /reset/${params[0]}`; `POST /account/two-factor/start`; `POST /account/two-factor/confirm`; `POST /account/two-factor/codes`; `POST /account/two-factor/off`.

### src/templates-views.js

Entry points: `templatesPage`, `createTemplatePage`, `templatePage`, `saveTemplate`, `addTemplateItemsPage`, `removeTemplateItemPage`, `deleteTemplatePage`, `saveAsTemplate`, `closeSeveralPage`, `closeSeveral`.

Forms: `POST /templates`; `POST /templates/${found.id}/items/${item.id}/remove`; `POST /templates/${found.id}/items`; `POST /templates/${found.id}`; `POST /templates/${found.id}/delete`; `POST /requests/close`.

### src/tenancy/views.js

Entry points: `signupPage`, `loginPage`, `loginCodePage`, `dashboardPage`, `billingWallPage`.

Forms: `POST /signup`; `POST ${loginPath}`; `POST ${codePath}`; `POST /logout`; `POST /billing/portal`; `POST /billing/checkout`.

### src/views.js

Entry points: `html`, `icon`, `page`, `redirect`, `badge`, `tile`, `section`, `empty`, `sendPage`, `sendCsv`, `sendJson`, `fail`, `requireSignIn`.

Forms: `POST /signout`; `POST /logout`.

### src/xero-views.js

Entry points: `xeroClientRows`, `xeroPage`, `xeroBooksSignal`, `xeroBooksCheck`, `xeroConnect`, `xeroCallback`, `xeroDisconnect`, `xeroImport`.

Forms: `POST /integrations/xero/import`; `POST /integrations/xero/disconnect`; `POST /integrations/xero/books-check`; `POST /integrations/xero/books-signal`.

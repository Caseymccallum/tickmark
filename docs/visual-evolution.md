# Tickmark visual evolution

## Phase A: architecture and migration plan

Starting main: `dca09fe8ec027f17e8f45e45214caefa048676e3`. Branch: `codex/tickmark-visual-evolution`. Final implementation SHA and verification are recorded at completion. The original audit checkout and its dirty `docs/go-succeed-prep.md` remain separate.

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

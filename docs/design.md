# The visual system

The current contract is [DESIGN.md](../DESIGN.md). The screen inventory, migration decisions, hosting procedure and verification evidence are in [visual-evolution.md](visual-evolution.md).

Tickmark remains server-rendered HTML with one inlined stylesheet, local fonts, inline SVG and browser cryptography. There is no UI framework, font service, analytics script or CSS build dependency. Escaped tagged templates remain the markup boundary; style and interaction never grant permissions.

## Identity and hierarchy

The tick is retained. Warm mineral surfaces and green-black ink give the product a quiet ledger character. Light uses canvas `#f6f7f4`, ink `#172d25` and primary `#164e3c`; dark uses canvas `#0d1513`, ink `#e8f0eb` and primary `#a5e6c7`. Colour-state families retain the meanings used by `badge()` and `TONES`. Words distinguish received, awaiting review, checked, replacement, outstanding and inactive states.

Body and controls use local Aptos/Segoe UI at a 16px base; major headings use local Iowan/Palatino/Georgia. Dense tables remain sans-serif with tabular numerals. Base controls are 44px; compact desktop controls are 36px and grow on small screens. Focus has a solid outline, not just a translucent shadow. The shared contrast check measures text at 4.5:1 and control borders at 3:1 against each supported surface in both themes.

## Reuse before custom UI

| Source | Responsibility |
| --- | --- |
| `src/style.js` | TOKENS, BASE, COMPONENTS, FORMS, TABLES, SURFACES, CLIENT_AND_MISC, SHELL, WIDTHS; assembled STYLE and canonical DESIGN_TOKENS |
| `src/views.js` | Escaped html/raw rendering; page shell, mark/icons, badge, tile, section, empty; nonce/security headers |
| `src/tenancy/views.js` | Hosted account forms, challenge, subscription, billing return/error states |
| `src/client-portal.js` | Client identity, responsive checklist, receipts/review, upload forms, messages and link errors |
| `web/*.js` | Existing encryption, file validation, upload status, key management and other progressive enhancements |
| `site/index.html` | Independently deployable marketing page and explicitly fictional workflow illustrations |
| `tools/build-marketing.mjs` | Canonical token sync and optional validated operator origins for standalone output |

The desktop workspace uses the existing routes grouped in a navigation rail. At 64rem and below, a native details menu replaces it. At 48rem, hosted forms stack and compact targets enlarge. The client checklist is a single column at every width. Real practice tables keep their semantic headers and use focusable, named horizontal scroll regions. No global overflow hiding is used.

Use existing notice, card, toolbar, filter and form primitives. Keep one primary action per decision area. Label every field; placeholders are supplementary. Preserve destructive confirmations, delivery previews, metadata disclosures, private-key recovery warnings and disabled/loading feedback. Do not create a modal when an ordinary page or native disclosure will do.

## Theme, motion and delivery

`prefers-color-scheme` switches semantic tokens. Reduced-motion disables transitions/animation; forced-colour mode uses system focus and boundaries. The marketing token block is generated from the same canonical source and checked for drift. Run `node tools/build-marketing.mjs --sync` after changing tokens, then review the diff. The committed static page works without configuration; its sign-in link stays on the hosted-access explanation until an operator builds a configured output.

No styles may add inline event handlers, broad CSP exemptions, remote resources, unescaped user content or plaintext upload paths. Never put a backtick inside a CSS template literal. Every CSS section must be included in `check-style.mjs` as well as assembled into STYLE.

## Verification and limits

Run style, site, docs, navigation, snapshot/page/gateway, unused-export, test and coverage commands listed in package.json. The 42 core snapshot pages and 14 gateway states check real rendered HTML and semantic structure. Targeted tests preserve form contracts, escaping, public-origin validation, mobile navigation semantics and client review states. Automated checks do not establish full WCAG 2.2 AA compliance or prove visual quality. Real browser, keyboard, zoom, screen-reader and device review remain necessary; record the environment and evidence in the visual-evolution report.

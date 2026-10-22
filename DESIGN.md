# Tickmark visual contract

## Visual theme and atmosphere

A calm working ledger: warm mineral surfaces, deep green ink, precise rows and a familiar tick. The application prioritises scanning and completing work. Marketing uses a more editorial scale while showing the actual checklist workflow. No external font, illustration, UI framework or analytics dependency.

## Color and semantic roles

`src/style.js` is authoritative. Light canvas `#f6f7f4`, surface white, ink `#172d25`, primary `#164e3c`; dark canvas `#0d1513`, surface `#14201c`, ink `#e8f0eb`, primary `#a5e6c7`. Green identifies the product and completion; existing information, warning and error tokens retain their meanings. Text must pass the existing 4.5:1 contrast checks. Labels and words convey every state independently of colour.

## Typography and hierarchy

Local Aptos/Segoe UI for controls and body, with tabular numerals for counts. Local Iowan/Palatino/Georgia for major editorial headings. Base 16px, body line-height 1.6; small labels 12–14px, workspace heading 32px, marketing heading responsive 40–76px. No remote fonts. Never apply serif to dense tables, controls or security codes.

## Spacing and grid

Four-pixel rhythm; reusable space tokens from 4 to 48px. Desktop sidebar 14.5rem; content at most 76rem; reading columns 42rem; client checklist 48rem. Standard controls 44px, compact controls 36px. Native menu replaces the sidebar below 64rem. At 40rem forms and actions stack; tables scroll within labelled containers rather than widening the page.

## Layout and composition

One shared page shell in `src/views.js`. Workspace navigation groups existing work routes and practice/security routes. Client pages have no account-navigation requirement. Hosted forms use an introduction and a distinct form panel; account and billing states use the same cards and notices. Marketing stays a standalone static document.

## Components and states

Reuse `page`, `badge`, `tile`, `section`, `empty`, `icon`, `.page-head`, `.card`, `.bar`, `.seg`, `.scroll`, `.facts`, `.upload` and notice classes. One primary action per decision area; destructive actions retain their explicit warning/confirmation. Rows use spacing and typography before badge colour. Inputs retain visible labels. Empty states include a useful next action. Client receipt and review are different states. Upload status remains a polite live region; errors remain visible and retryable.

## Motion and interaction

Subtle 120–160ms control transitions only. Focus uses a solid 2px outline with offset; the soft focus shadow is supplemental. Reduced-motion disables transitions. Native details navigation requires no new script. Forced-colour mode uses system focus/borders. Mobile controls retain 44px targets. No modal is introduced.

## Voice and brand

Direct, helpful, specific. Explain encryption and recovery boundaries where they affect a decision. Fictional product previews are labelled. Price, trial, quota and launch state follow source configuration and evidence. Keep essential recovery warnings prominent.

## Anti-patterns

No invented metrics, decorative gradients, fake testimonials, remote scripts/fonts, blanket overflow hiding, colour-only status, placeholder-only labels, plaintext uploads, or CSS that changes security semantics. No hard-coded unowned domain or paid signup link before an operator configures the service.

# The look, and why it is this one

Tickmark's interface is one stylesheet (`src/style.js`), one mark drawn in SVG, and plain HTML.
There is no build step, no CSS framework, no icon set, and no class-name convention to learn — and
that is a product decision rather than an aesthetic one, for three reasons.

**A practice runs this on their own machine.** Every dependency is something they have to install,
trust and update. A stylesheet that is part of the source is a stylesheet that cannot rot, cannot
phone home, and cannot break because a major version moved.

**A client opens one page, once.** The page a client sees has to load fast on a phone on a train, so
it is one document with its CSS inlined and two small modules beside it. There is no font to fetch
and no icon sprite to wait for.

**A page has to be readable as markup.** Every page still renders sensibly with the stylesheet
switched off and is legible in `curl`, because the semantic elements are the design. This is also
what makes the tests possible: they assert on the page's own words, so a test that breaks means the
product's promise changed, not that a class name moved.

## What the identity is

| Piece | What it says |
| --- | --- |
| The tick | The mark is a tick in a rounded square: the one gesture the whole product is about. It is drawn inline in every page and the same drawing, URL-encoded, is the favicon — so the identity cannot 404 and costs no request. |
| Ink, not black | Text is a very dark navy (`--ink: #131c2b`) on a faintly blue canvas. Pure black on pure white reads as a default; a navy text-and-border system reads as decided. Elevation is tinted with the same navy, so a shadow looks like light rather than a smudge. |
| One accent, and it means "done" | Green (`--brand`) appears in three places: the tick, the bar on the practice's note to their client, and the progress of a key being moved. Every other colour in the system is a *state*, never decoration. |
| State as a word in a shape | `badge()` renders a state as a pill with a status dot: `ok` (nothing is wanted), `check` (somebody here has work), `wait` (the client does), `bad` (something is wrong), `off` (out of play). The same word means the same colour on every page, because a state that looks different on two pages is two states. |
| Numbers that answer a question | `tile()` puts one number above the words that name it, and links it when there is somewhere to go. The board's tiles answer *what do I do now?* — files to check, waiting on clients, ready — and never show a figure nobody acts on. |
| Columns that stay put | Where a table has a shape worth fixing, the markup carries a `colgroup`, so columns do not move when a client's name gets longer. Numeric columns are right-aligned and tabular, so digits line up down the page — the cheapest thing that makes a table look engineered. |
| Filters that compose | Search and the order controls are a plain `GET` form and a set of links, so every filter lives in the address bar and a link can be sent to a colleague. A search box that hides itself when a search finds nothing is the same trap as a control that cannot work: there is a rule about it below. |
| Prose that is meant to be read | The explanatory paragraphs are part of the interface, not filler. They are set at a readable measure in a softer ink, and they are the reason the copy can be long without the page feeling crowded. |

## The rules

1. **No class is needed to render a page correctly.** `table`, `button`, `input`, `h1`, `h2`, `.note`
   and `.warning` are styled by element or by names the product already used. A class is added only
   when it names something that exists — `.card`, `.badge`, `.tile`, `.greeting`.
2. **One primary button per page.** Everything else is neutral or ghost. A form that *is* the page's
   action gets the primary button by being a `.card`, without being told. If a page has two
   primaries, the page has not decided what it is for.
3. **A button is never inside a link.** Anchors wear `.btn` directly, which is why the button styles
   exist as classes and not only as element styles.
4. **Colour is state, never decoration.** Five state families, fixed meanings.
5. **A control that cannot work is not shown.** No Send button without a mail server, no passphrase
   form on a retired key. This is a design rule with a test suite behind it.
6. **Light and dark from one set of tokens.** `prefers-color-scheme` swaps custom properties and
   nothing else in the sheet knows which mode it is in; `prefers-reduced-motion` turns transitions off.
7. **Escaping is not a class's job.** Every value goes through `html`; `raw` is only ever used for
   markup this repository wrote.
8. **An icon carries meaning, never decoration.** Ten of them, drawn inline at 16×16, all
   `currentColor` — so an icon in a warning is warning-coloured because it is *inside* the warning
   rather than because somebody chose a colour. Each sits beside the word it means, which is why they
   are all `aria-hidden`. There is no ornament in this stylesheet and an icon with nothing to say
   would be the first one.
9. **A fact is said once.** The dashboard shows the subscription state as a badge at the top and does
   not repeat it in the table below; the wall derives its tone from the same `STATUS_LOOK` the
   dashboard uses, so one state cannot look like a warning on one page and a neutral fact on another.
   Two descriptions of one thing drifting apart is the bug this project has fixed most often.

## Where the ideas came from

Three systems in `plain-forms/design-systems/`, and one thing taken from each:

- **Cal.com** — the shadow-first, near-monochrome posture. Depth is a layered stack: a 1px ring so a
  card has an edge even where the diffused shadow has faded, plus one soft shadow. The palette is
  greyscale with colour admitted as a rare, controlled accent.
- **Stripe** — the financial-data craft. Tabular numerals, restrained radii (5–12px, nothing
  pill-shaped except state), and shadows tinted with the ink rather than with black.
- **Wise** — friendliness. The green, and the willingness to write a full sentence where a label would
  do, because the reader is an accountant with a deadline rather than a developer.

## Where things live

```text
src/style.js      TOKENS · BASE · COMPONENTS · FORMS · TABLES · SURFACES · CLIENT_AND_MISC
                  → one exported STYLE string, inlined into every page
src/views.js      page() — the shell, the header, the footer, and html/raw escaping
                  badge() tile() section() empty() — the four components markup asks for by name
                  icon() and the ten drawings it looks up, plus tick() for a list of truths
src/tenancy/views.js  the public pages: sign up, sign in, the dashboard, the billing wall
web/*.js          the browser half: upload, download, keys, members, setup
```

`views.js` decides what a page *says*; `style.js` decides how it looks. Neither is easier to change
because the other is tangled into it. The gateway's pages are their own file because they are the
only ones about *accounts* rather than documents, and they exist only when `MULTI_TENANT=1`.

**Never write a backtick inside `style.js`.** The sheet is a template literal, so one backtick in a
CSS comment ends the string and the module fails to load — taking every page and every test with it,
with an error that points at a line of CSS rather than at the comment. It has happened three times;
`npm run check:style` now fails the build instead.

## Checking it

The look can be reviewed without a browser:

```sh
node tools/snapshot.mjs    [dir]   # renders every page, writes an INDEX.txt
node tools/check-pages.mjs [dir]   # catches "undefined", unbalanced styles, a missing header/footer
node tools/show-page.mjs   <page>  # prints one captured page with the CSS collapsed
node tools/preview-gateway.mjs [dir] # the thirteen states of the public pages, including the ones
                                     # that otherwise need a webhook to have fired
node tools/check-style.mjs         # no backtick inside the CSS literal, every rule closed
```

`snapshot.mjs` drives the real server over HTTP through the same helpers the tests use — a signed-up
practice, a key, a request, a link, one document actually sent — so what is captured is the product as
it runs rather than a fixture of it. It renders the client's page too, which is the one a stranger
sees and the hardest to check by clicking through as yourself. Neither tool is part of the product and
`npm test` does not run them.

## The trade this makes

A hand-written sheet means no component library to lean on and no tokens exported from a design tool.
What it buys is that the whole interface is one file a practice can read, that cannot be broken by
`npm audit`, and that will still work in five years. When the SaaS layer arrives, both deployments
look identical because they *are* identical — see `docs/saas.md`.

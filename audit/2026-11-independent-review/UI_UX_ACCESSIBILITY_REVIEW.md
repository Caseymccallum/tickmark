# UI/UX and Accessibility Review

## Method and evidence

**This review was performed against the running application in a real browser** (BrowserOS neo over MCP — see
[BROWSER_VERIFICATION.md](BROWSER_VERIFICATION.md)). A practice was seeded with fictional data into four states and
screenshotted at 390 / ~575 / ~730 / **1282** CSS px. Every screen below is a live render, not a mock-up; the images
are in `evidence/screens/`.

Also used: the rendered accessibility tree, `src/style.js`, the `DESIGN.md` contract, and the project's own gates —
`check-style` (which computes WCAG contrast), `check-pages` (structure), `check-nav`, `snapshot`.

**What I could not do:** a screen-reader session, a real iOS/Android device, and a 1440 px capture (the roomy window
captures at 1282 px but at ~61 s per shot). **WCAG 2.2 AA conformance is not claimed.** Where something needs a real
device it is labelled.

## 1. Visual quality — good, and better than "good for a solo project"

**Observed in the live application:**

- **A real design system, not a default stylesheet.** Warm mineral canvas `#f6f7f4`, deep green ink `#172d25`,
  primary `#164e3c`; a serif display face (Iowan/Palatino/Georgia) for headings against a system UI face for controls;
  tabular numerals for counts. `DESIGN.md` is a genuine contract and the code follows it.
- **Hierarchy works.** On the board (`01b`, `02`): serif "Requests", one-line explainer, `New request` as the single
  filled primary action, then state tiles, then the table. On the request page (`03`, `04`): breadcrumb `REQUESTS`,
  serif title, client + due date, then the action row.
- **The state tiles are genuinely useful** — `1 with files to check · 3 waiting on clients · 1 ready to work on ·
  5 open in total`. That is a morning's triage in one glance, and it is the product's real differentiator expressed as
  four numbers.
- **Badges never rely on colour**: `files to check`, `waiting on the client`, `overdue`, `ready to work on`,
  `received`, `still needed` — each a word in a tinted pill.
- **Empty/first-run state is unusually thoughtful.** The getting-started card lists four steps with `(optional)` on
  the two that are optional and a real action button on each.
- **The client pages are the best-designed screens in the product** (`06`–`09`): a single column, the practice's name
  at the top, one honest sentence ("Choose your documents below. No account needed."), a collapsed "How your
  documents are protected" disclosure, a plain progress sentence, then one card per document.
- **Dark mode exists** as a second token set, and `check-style` fails the build if a token is defined in only one mode.

**Weaknesses observed live:**

- **The client's upload control is the browser's native `<input type="file">`** — "Choose Files / No file chosen" in
  a dashed box. It is the single most important control in the product and the only element that looks like a form
  from 2011. It also renders differently on every browser, which means the one screen where a suspicious client
  decides whether to trust you is the one screen you do not control.
- **The board's `Duplicate` control is small muted text under each title** — a low-emphasis link doing a
  high-value job, and a likely target-size problem (B-05).
- **The empty progress bar looks like a scrollbar** at "0 of 4" (B-04) — a small but real confusion on the client's
  first visit, which is exactly the moment trust is formed.
- The practice sidebar is long (10 items in two groups). *Account security* and *Keys* both read as "security" to a
  new user; the distinction is real but not obvious from the labels alone.

## 2. The palette question — the owner's instinct is right

The owner suspects the green reads like their agricultural applications. **I agree, with a caveat.**

- What is there is a *deep forest* green (`#164e3c`) on warm off-white, not a bright farm green. It is tasteful,
  cohesive and clearly not a stock theme.
- But green-plus-rounded-plus-friendly is the visual grammar of **agri-tech, eco/green business and small-business
  accounting**. It says "approachable local firm" when the proposition is "we cannot read your clients' documents" —
  a claim about *rigour and custody*, which is closer to banking or legal than to a farm shop.
- It is also the reason two different products in the owner's portfolio look related. For a multi-product portfolio
  that is a liability, not a house style.

**Recommendation (not implemented, per the brief):** keep the typography and spacing — they are the best part — and
change the accent pair. My ranking:

1. **Ink & cobalt** — near-black ink `#12161c` with cobalt `#1f4bd8`. Reads precise, institutional, trustworthy;
   closest to Big-4/legal. Best fit for the "server cannot read your files" claim.
2. **Plum & stone** — deep plum `#3b1f38` with warm stone `#e8e2d9`. Most distinctive of the three; unmistakably not
   agriculture; slightly softer, which suits "we take the paperwork off your desk".
3. **Midnight & copper** — `#0f1b2d` with copper `#b8703c`. Warm and premium, but copper + serif edges toward
   "boutique hotel"; riskier for a compliance-adjacent buyer.

Whichever is chosen, the *state colours must not move*: amber = needs attention, red = overdue/error, green = done.
Those are semantic, and `DESIGN.md` already says words must carry every state independently of colour — which they do.

## 3. Interaction quality

### The request page, which is where a practice lives

Counted from the rendered page. The screen carries: title, client context, "2 of 3 received", a Duplicate block, a
"Keep this list for next time" template save, a **passphrase unlock panel**, "Download everything (2 files)", a
document table with per-row *Wrong words?* / *Save* / *checked* / *Needs attention* / *Stop asking*, an add-items box,
the client link with **Revoke** and a 7/30/90-day reissue, a chasing panel, "Been in touch another way?", the event
timeline, "Add a document for this client", and Close / Do-this-again.

That is **a lot on one page** — and it is the right call. Every one of those is something a practice does *about this
request*, and splitting them across tabs would add clicks to the most-visited screen. The sectioning (link → chase →
record → timeline → close) is a defensible information architecture.

**Clicks for common tasks (counted):**

| Task | Clicks | Comment |
|---|---|---|
| See what is outstanding | 1 (open `/requests`) | Board sorts by whose turn it is |
| Chase one client by email | 2 | `Draft a reminder` → `Send` |
| Chase everyone | 2 | `/chase` → send, with a preview page first |
| Review one arrival | 1 | `Save` on the row |
| Review everything that arrived | 1 | `check-all` |
| Open one client's document | 3 | Unlock → download → (browser save) |
| Next year's list | 1 | `Do this again` |
| Reuse a checklist for another client | 1 | `Duplicate`, then choose client/date |

Those numbers are good. Nothing important is buried.

**Friction that is real:**

- **The passphrase panel is a modal-less interruption.** It is well explained ("It is used in this browser and sent
  nowhere… keeps the keys in this tab so that saving several files does not mean typing it again") and it correctly
  re-locks on reload. But it sits *above* the document table, so a practice that only wants to review states must
  scroll past a security control they are not using yet. Making it collapsed until `Download` is pressed would remove
  a permanent 600k-round-shaped speed bump from the review loop.
- **Review verbs are practice-idiom, not obvious.** `Wrong words?` / `Stop asking` are charming and specific; a first-
  time user may need the one-line hints that are present but small.
- **"Download everything" is excellent** and under-sold: opening each file in the tab and packing them into one ZIP
  without plaintext leaving the browser is a genuinely better answer than competitors, and it is described in a small
  note rather than as a headline.
- **Confirmation handling is good:** destructive actions (close, revoke, remove member) are two-step or explicitly
  described ("Closing is a status, not a deletion").

## 4. Accessibility (WCAG 2.2 AA — assessed where practical)

| Criterion area | Finding | Evidence |
|---|---|---|
| Semantic structure | **Good.** One `h1` per page, `lang="en"`, skip link ("Skip to content"), real `<main id="main" tabindex="-1">`, real `<ol>` for the checklist | markup of every page fetched |
| Labels | **Good.** Zero placeholder-only fields; all 8 client inputs carry contextual `aria-label`s ("Upload one or more files for: Bank statements") | markup inspection |
| Live regions | **Good.** Upload status is `role="status" aria-live="polite" aria-atomic="true"`; the client page has 4 and the request page 7 `aria-live` regions | markup; asserted in `test/visual-system.test.js:79` |
| Contrast | **Verified by tooling, not by eye.** `tools/check-style.mjs` computes WCAG relative luminance and fails on any ink below 4.5:1 (and control boundaries below 3:1). It exits 0 | `npm run check:style` → exit 0 |
| Colour-independence | **Good.** Every state has a word ("still needed", "checked", "Waiting on the client"), never colour alone | markup |
| Target sizes | **Claimed 44 px** in `DESIGN.md` and visible in the mobile capture; UIs use 44/36 px tokens. **Needs device measurement** | CSS tokens |
| Keyboard / focus | **Good on paper.** A solid 2 px focus outline with offset is defined, `:focus-visible` semantics, native `<details>` for the mobile menu (no ARIA menu to get wrong), no modal traps | `src/style.js`, `web/` |
| Reduced motion | **Present.** Transitions disabled under `prefers-reduced-motion`; only 120–160 ms control transitions exist | `DESIGN.md` §Motion, `style.js` |
| Reflow / zoom 200% | **Partly verified.** At 390 px the client checklist reflows to one clean column with no horizontal overflow (`07`, `08`). The request page's document table scrolls horizontally inside `role="region" tabindex="0"` — correct and exempt from 1.4.10, but with no visible affordance (B-02). 200 % zoom still unmeasured | live render; `src/style.js:425` |
| Forced colours | **Handled** — system focus and borders under forced-colour mode | `DESIGN.md` |
| Error announcements | **Good** — form errors render as `role="alert"` (asserted in `test/visual-system.test.js:43`) | test |
| Screen reader | **Not tested.** No AT available | — |

**Honest verdict:** structurally this is **well above average** for a product this young — better than most funded
competitors' client portals. It is **not** proven WCAG-conformant, and the only honest way to establish that is a
manual audit with a screen reader and a 200% zoom session on a real device. `docs/phase-5` already lists exactly this
as outstanding work with "five-tester journey" framing.

## 5. Prioritised findings, separated by kind

### Cosmetic preferences (safe to ignore for now)

| # | Finding |
|---|---|
| C1 | Green palette reads agricultural; ink/cobalt or plum/stone would read more "professional services" |
| C2 | Sidebar labels *Keys* and *Account security* are distinguishable only after clicking both |
| C3 | `New request` is the only filled button on the board, which is right, but `Search` beside it is an unstyled twin — the button hierarchy at the bottom of the board is slightly muddy |
| C4 | Serif headings in dense areas are well restrained; the request page is all sans, which is correct — no change proposed |

### Workflow friction (real cost, low risk)

| # | Finding | Suggested change |
|---|---|---|
| F1 | Passphrase panel occupies prime vertical space above the document table even for a review-only visit | Collapse behind `Download` until first used in that tab |
| F2 | Native `<input type="file">` chrome on the client's phone | One styled button + "no file chosen" text + drop zone, keeping the same `name`, `aria-label` and `accept` |
| F3 | "Download everything" advantage is buried in a note | Promote it; it is a differentiator |
| F4 | Review verbs (`Stop asking`, `Wrong words?`) need their one-line hints read first | Keep the verbs; raise the hint's contrast/position slightly |
| F5 | No "what happens next" line after a client submits | One sentence: "The practice will check this; you will not need to do anything unless they ask." (partly present on the receipt state) |
| F6 | The request page's close/re-raise section is headed **"The file itself"** (`src/board-views.js:1136`) — a heading describing nothing in it | Rename to "Close or repeat this request" (B-01) |
| F7 | Two requests with the same client and title are created silently; the board then shows duplicate rows | Warn on create when an open request for that client has a near-identical title (B-03) |
| F8 | The document table's review buttons are clipped mid-word at ~44rem and below | Sticky first column, or a visible scroll affordance (B-02) |

### Accessibility defects (must fix before claiming AA)

| # | Finding | Basis |
|---|---|---|
| A1 | ~~Possible unintended horizontal overflow on the client checklist at ~390 px~~ | **WITHDRAWN.** Rendered live at 390 px: the checklist reflows cleanly with no overflow. The grey bar that prompted this was the `<progress>` element at 0 %, not a scrollbar. Replaced by B-04 (cosmetic) |
| A5 | Request-page document table clips its action column mid-label below ~44rem, with no scroll affordance | **Confirmed** — B-02 in [BROWSER_VERIFICATION.md](BROWSER_VERIFICATION.md) |
| A6 | Small text controls (`Duplicate`, `Wrong words?`) may be under the 24×24 px target of WCAG 2.2 §2.5.8 | **Likely — unmeasured** (B-05) |
| A2 | No screen-reader pass has ever been performed | `docs/phase-5` states this; cannot be closed by code review |
| A3 | 44 px targets and 200% zoom are asserted in `DESIGN.md`, not measured | Needs a manual check |
| A4 | No `autocomplete` attributes on the practice-side password/email fields (client-side 2FA field does have `autocomplete="one-time-code"`) | Markup; a password manager will still work, but hints are better |

### Trust-reducing presentation (matters most for a product selling custody)

| # | Finding |
|---|---|
| T1 | The native file input looks less trustworthy than the copy around it promises |
| T2 | The "Attach a file" control on reminders does not say the attachment is unencrypted (see S-02) |
| T3 | The client's trust panel is genuinely honest — *"The server can still see the name of the file, the document it answers and when it arrived"* — and should stay exactly that blunt |
| T4 | `docs/visual-review-screenshots/` renders every preview without a visible "fictional" stamp inside the app pages (the marketing page does stamp them) |

### Conversion and adoption risks

| # | Finding |
|---|---|
| V1 | First-run lands on an empty board with a four-step card — good — but the **first required action is "Make your encryption key"**, which asks for a passphrase before the user has seen the product do anything. Consider letting them create a request first and generating the key at the moment it is needed |
| V2 | "Hosted access is awaiting launch validation" on the marketing page is honest and is also a conversion ceiling — a waitlist or a self-host path needs to be the visible next step |
| V3 | No screenshot or example of what the *client* sees, on the marketing page. For this product that is the strongest possible demo |

## 6. Verdict

**Visually and interactionally, Tickmark is in good shape — genuinely more coherent than most early-stage B2B
software, and this was confirmed by using it rather than by reading its markup.** The client checklist is the
standout: honest, calm, complete, and it answers the three questions a frightened client actually has (*who is
asking, what do they want, is this safe*). The board's four state tiles are the product's whole value proposition in
numbers, and the request page is information-dense in the right way.

The browser pass changed the picture in three ways worth stating plainly:

1. **One earlier concern was wrong.** There is no horizontal overflow on the client checklist at 390 px; the grey bar
   was an empty `<progress>` track. Withdrawn.
2. **A worse one was hiding underneath it.** The *request page's* document table genuinely clips its review buttons
   mid-word at ordinary laptop-ish widths, with no hint that it scrolls (B-02). That is a real, confirmed usability
   defect on the screen a practice lives in — and it was invisible from markup alone.
3. **A one-line copy bug sits on the same screen**: a section headed "The file itself" that contains the close and
   re-raise buttons (B-01).

The work that remains is **one real control** (the upload affordance), **one layout fix** (the document table's
clipped action column), **two copy fixes** (the "file itself" heading; the unencrypted-attachment warning), **one
accessibility measurement** (screen reader + 200 % zoom on a device), and **one brand decision** (the palette). None
is large, and none is a reason to delay a pilot.

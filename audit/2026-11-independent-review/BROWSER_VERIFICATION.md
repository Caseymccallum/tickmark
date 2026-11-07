# Browser Verification — Setup and Results

This document records connecting **BrowserOS neo** over MCP, driving the live Tickmark application in a real browser,
and what that changed in the audit. It is the addendum that upgrades several earlier "needs device testing" items to
verified observations — and overturns two of my own hypotheses.

---

## 1. The connection, and the schema trap

**Endpoint:** `http://127.0.0.1:9010/mcp` — reachable, `browseros-neo` **v0.0.92**, MCP protocol **2025-06-18**,
streamable HTTP (returns `text/event-stream` and an `mcp-session-id` header). Tools advertised: **27**.

**Config file:** `C:\Users\Casey\.cline\data\settings\cline_mcp_settings.json` — confirmed as the *live* one, because
the servers already listed there (proxima 50 tools, gitnexus, supabase-db) are exactly the MCP tools available in
this session. Two other candidates were checked and ruled out:

| Path | Verdict |
|---|---|
| `…\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json` | **Not used.** Contains only a stale `filesystem-logged` entry (30 Sep 2026); none of its tools are live here |
| `…\.cline\data\settings\cline_mcp_settings.json` | **Used.** Matches the live tool set exactly |

**The schema trap worth recording.** Cline's public documentation shows a *flat* remote entry:

```json
{ "type": "streamableHttp", "url": "https://example.com/mcp" }
```

This installation is **`saoudrizwan.claude-dev` 4.1.26**, and its bundled schema (recovered from
`dist/extension.js`, then confirmed against `dist/extension.js.map`) is different in two ways:

```js
TNo = z.object({ type: z.literal("stdio"), command, args?, cwd?, env? })
kNo = z.object({ type: z.literal("sse"),             url, headers? })
RNo = z.object({ type: z.literal("streamableHttp"),  url, headers? })
DNo = z.discriminatedUnion("type", [TNo, kNo, RNo])

ServerConfig = z.object({
  transport: DNo,          // ← nested, not flat
  disabled?, timeout?, metadata?, oauthClient?, oauth?
})
```

So the correct entry for **this** build is nested under `transport` with the literal **`"streamableHttp"`**. The
*other* installed extension (`rooveterinaryinc.roo-cline` 3.54.0) uses a **different literal** — `"streamable-http"`
with a hyphen — and flat fields. Writing the documented flat form here, or the hyphenated form, would produce a
server that silently never connects. I verified the literal in the shipped code rather than guessing.

**What was written** (existing three servers preserved byte-for-byte; backup kept):

```json
"browseros-neo": {
  "transport": { "type": "streamableHttp", "url": "http://127.0.0.1:9010/mcp" },
  "autoApprove": ["name_session", "tabs", "tab_groups", "windows", "browser_profiles",
                  "browser_target", "history", "navigate", "snapshot", "diff", "read",
                  "grep", "screenshot", "pdf", "wait"]
}
```

**Auto-approval is deliberately narrow.** Read-only and visual tools only. Anything that mutates a page (`act`),
downloads, uploads, touches credentials or payment cards, runs arbitrary code (`run`, `evaluate_in_page`), or asks a
human still requires approval. Backup: `cline_mcp_settings.json.backup-2026-11-07T19-04-26-597Z`.

**Verification.** `initialize` → `notifications/initialized` → `tools/list` completed and returned all 27 tools, which
is the same handshake Cline performs. The tools are not yet in this session's tool list because MCP servers load at
session start — **reload the Cline panel (or start a new task) for them to appear natively.** Until then they were
driven over the identical protocol by the audit's own client (`evidence/neo-client.mjs` style, kept in `%TEMP%`).

## 2. Driving a real browser: what worked, and two traps

| Trap | Symptom | Cause | Fix |
|---|---|---|---|
| **Background-tab capture** | `screenshot` fails after ~60 s with `CDP request timed out: Page.captureScreenshot`, then a bare retry sometimes succeeds | `tabs new` opens the page **in the background**; an occluded tab will not paint for CDP | Open a **dedicated window** (`windows create` → `browser_target set_window`) so the tab is its own window's active tab — capture then takes **84–104 ms** |
| **`size` only caps** | `size: {width:1440}` still produced a 575 px image | The parameter is a **maximum**, never an upscale; the viewport is whatever the window is | A neo-created window is ~575×520 CSS px; the roomy original window gives 1282×741 — but captures there cost ~61 s because the tab is backgrounded |

**Consequence for this audit:** many captures below are **575–730 CSS px wide**, i.e. a small-laptop / tablet
viewport, not 1440 px desktop. That is stated per screenshot rather than glossed. Two genuine wide captures
(1282×741) were obtained from the roomy window and are marked as such.

## 3. What was driven

A disposable instance on **port 3010** (fictional data only, removed before publication), seeded through the
real HTTP routes into four states — overdue, waiting-on-client, files-to-check, ready-to-work-on — then exercised in
the browser: sign in through the form, board, request detail, client checklist, client receipt, an invalid link, the
account hub, chase, clients. Tokens in logs are redacted by Tickmark's own logger (`/r/[redacted]`).

All captures are in `evidence/screens/`.

## 4. Screenshot index

| File | Screen | Viewport | What it shows |
|---|---|---|---|
| `01b-board-wide.jpg` | Practice board | **1282×741** (real desktop) | Sidebar nav, stat tiles, request table with all four states |
| `01-board-desktop.jpg`, `02-board-desktop-full.jpg` | Practice board, narrow + full page | ~730 CSS px | Mobile `<details>` nav; the same states stacked; full page to the footer |
| `03-request-detail-desktop.jpg`, `04-request-detail-desktop-full.jpg` | **Request detail** | ~575 / ~730 px, full page | Title, progress, "Files to check" banner, passphrase panel, document table, add-items, link + revoke, chasing, contact record, timeline, add-for-client, close/re-raise |
| `05-request-detail-mobile.jpg` | Request detail | 390 px | The same page on a phone |
| `06-client-checklist-desktop.jpg` | Client checklist | ~575 px | 0 of 4, trust panel collapsed, item cards |
| `07-client-checklist-mobile.jpg`, `08-client-checklist-mobile-tall.jpg` | Client checklist | 390 px | Mobile-first layout, 44 px controls, status pill |
| `09-client-receipt-mobile.jpg` | Client receipt state | 390 px | "You have sent 1 of 3", filled progress, `received` badge |
| `09-client-invalid-link-mobile.jpg` | **Wrong / expired link** | 390 px | "No such link" with a genuinely helpful explanation |
| `10-chase-desktop.jpg` | Chase | ~730 px | Who will be written to, before sending |
| `11-clients-desktop.jpg` | Clients | ~730 px | Client records |
| `14-signin-mobile.jpg` | Sign in | 390 px | Form, labels, focus ring |
| `15-account-hub.jpg` | Account security hub | ~575 px | The 2FA state, plus links onward to password, email and sessions |

**Not captured:** a 1440 px desktop view (see §2), the signed-out home page (signed in, `/` redirects to the board),
the 2FA setup screen with its QR code, and the marketing site (the repository already has recent captures in
`docs/visual-review-screenshots/`).

## 5. Findings this phase added

### B-01 — A section on the request page is titled "The file itself" and contains no file · **Low** · Confirmed

`src/board-views.js:1136` renders `<h2>The file itself</h2>` immediately above the *close / do-this-again* block,
whose own text is "Closing is a status, not a deletion…". The heading describes nothing in the section — it is a
leftover from the refactor that moved the review controls into the table. On the busiest screen in the product it
actively misdirects: someone looking for "close this request" reads past a heading about a file, in a section with no
file in it. **Fix:** one line — `Close or repeat this request`. **Evidence:** `04-request-detail-desktop-full.jpg`.

### B-02 — The document table's action column is clipped mid-word, with no scroll affordance · **Medium** · Confirmed

At 575–730 CSS px the request page's document table is wrapped in
`<div class="scroll" tabindex="0" role="region" aria-label="Scrollable request data">` (`src/board-views.js:982`),
which is the *correct* accessible pattern. But in the rendered page the right-hand column is cut at the card edge and
its buttons read **`Che…`, `why?…`, `Nee…`, `Stop…`** — clipped labels with no visible scrollbar and no fade or
chevron hinting that the region scrolls.

This is not a WCAG reflow failure (data tables are exempt from 1.4.10), but it is a real usability problem: the
controls that *review a document* are the ones you cannot see, and they look broken rather than scrollable.
**Fix:** a sticky first column, a visible edge mask/fade, styled scrollbar, or stack the row into two lines below
~44rem. **Evidence:** `03`, `04` (clipped at right) versus `01b` (fits at 1282 px).

### B-03 — Two requests for the same client and title are created without comment · **Low** · Confirmed

I seeded the same client/title twice by accident (my first seed run created a request, then crashed). The product
accepted both silently and the board showed **two identical rows**. There is no duplicate guard on client + title and
no "you already have an open request like this" hint. For a practice that is a realistic mistake — double-clicking
"New request", or a colleague doing the same — and the board then reports inflated counts.
**Fix:** a soft warning on create when an open request exists for that client with a near-identical title (warn, do
not refuse). **Evidence:** the board before I closed the duplicate with the product's own action.

### B-04 — The empty progress bar reads as a rule, not a progress meter · **Low (cosmetic)** · Confirmed

At "0 of 4", `<progress>` renders as a bare grey track with no fill, which at first sight looks like an empty
scrollbar or a divider. At "1 of 3" the same element is unambiguous. **Fix:** render the track only when
`received > 0`, or label it. **Evidence:** `06` (0 of 4) versus `09` (1 of 3).

### B-05 — Review-verb labels are legible but small · **Low** · Likely

The per-row `Wrong words?` control and the board's `Duplicate` link are small text controls. WCAG 2.2 **2.5.8** asks
for 24×24 CSS px minimum targets; these look close to or below that. **Needs measurement** in DevTools — I did not
measure them, so this stays "likely", not confirmed.

## 6. What the browser work **overturned**

Two assertions of mine proved wrong once rendered. Both are recorded rather than quietly dropped:

| Earlier claim | Status | Why |
|---|---|---|
| **A1:** "possible unintended horizontal overflow on the client checklist at ~390 px" (a grey bar visible in the repo's own screenshot) | **Withdrawn** | The grey bar is the `<progress>` element at 0 % — an empty track, not a scrollbar. At 390 px the client checklist reflows cleanly with no horizontal overflow (`07`, `08`). B-04 is the real, much smaller, issue |
| "**Account pages unreachable from the navigation**" — my own working hypothesis while grepping `views.js` | **Withdrawn before publication** | The nav exposes only "Account security", but that hub page links onward to *Change your password*, *Change your email* and *Where you are signed in*. Confirmed by reading the rendered link list of `/account/two-factor`, not the source |

That is the pattern this audit keeps meeting: reading produces a hypothesis; running produces the evidence.

## 7. What the browser work **confirmed**

| Claim from the static review | Now |
|---|---|
| Mobile-first client checklist with 44 px controls and a native `<details>` trust panel | **Confirmed** — `07`, `08`, `09` render cleanly at 390 px |
| Colour is never the only signal | **Confirmed** — every badge carries a word (`received`, `files to check`, `waiting on the client`, `overdue`, `ready to work on`) |
| The passphrase panel occupies prime space above the document table | **Confirmed** — visible in `03`/`04`; the earlier recommendation to collapse it stands |
| "Download everything" packs files in the tab without plaintext leaving it | **Confirmed present** on the page beside the unlock control |
| The link lifecycle is visible and reversible (created / expires / Revoke / reissue 7-30-90) | **Confirmed** — `04` shows `created … expires 2026-12-07`, a **Revoke** button and a reissue control; reissuing in this session did issue a working new link |
| An invalid/expired link is refused kindly | **Confirmed** — `09-client-invalid-link-mobile.jpg`: "No such link. Check the address you were sent: it may have wrapped across two lines in an email, or lost a character on the way" |
| The "files to check" state is explained rather than merely counted | **Confirmed** — the amber banner says *"'Received' is not 'ready' — do this before chasing anything else, because what is already here is the thing a client is least likely to send twice"* |
| An assistant who cannot decrypt is told why, in place | **Confirmed** in source (`src/board-views.js:1153-1158`); not exercised with an assistant session |

## 8. Honest limits of this phase

- **Viewport widths are 390 / ~575 / ~730 / 1282 CSS px.** No 1440 px capture succeeded: the roomy window captures at
  1282 px but takes ~61 s per shot, and a longer run hung. Nothing in the review depends on 1440 px specifically.
- **No screen reader.** The accessibility tree *was* read (BrowserOS exposes an a11y snapshot), which confirms
  accessible names, `LabelText` nodes, roles and live regions — but that is not a screen-reader session.
- **No real phone.** 390 px is a viewport override in a desktop Chromium, not iOS Safari or Android Chrome.
- **A real capture of the 2FA setup screen with a QR code was not taken** — that flow needs an authenticator app.
- **Screenshots were taken against a local instance over HTTP**, so no HSTS, and the sign-in page shows no
  certificate affordance.
- **Two screenshots contain artifacts of my own seeding**, not product defects: the duplicate "Lodge & Co" row (B-03,
  since closed) and one request closed during the session.

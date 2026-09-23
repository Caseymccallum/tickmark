# A full audit: what is missing, what is slow, and what is left

The security half has its own file — `docs/security.md`. This is the other two thirds of the same exercise: the
feature gaps, and the code.

Done by reading the source rather than the documentation, because the documentation is what the previous passes
*claimed* and the source is what is true. Where a number appears below it was measured with `tools/bench.mjs`
rather than estimated.

## 1. Feature gaps

The honest summary: **the workflow is complete and the absences are all in one direction — things a practice
would want after using it for a season, not before their first one.**

Everything the Phase 0 research named as a need is built: collection by link, chase with a cadence, the client's
own answers, overdue dates, carry-forward, bulk send, and the encryption none of the incumbents have. What follows
is what is *not* there, ordered by what I would do first, with the reason each is not there today.

### Worth building next

| Gap | What it would look like | Why not yet |
| --- | --- | --- |
| **A password reset by email** | `pending_payment`-style token, a link, a new password — and it also closes the sign-up enumeration leak in `docs/security.md` because the flow stops needing to say "that address is taken" | Needs the mailer and a token table. `tools/reset-password.mjs` covers self-hosted, where the operator is reachable; the gap is real for hosted |
| **A Content-Security-Policy** | Per-response nonce; the work is described in `docs/security.md` | A piece of work rather than a header. Do it before a hosted launch |
| **Markdown or line breaks in the note to a client** | The note already keeps its newlines; links in it would need the escaping rules revisited | Deliberately plain text. A note that can carry a link is a note that can carry a phishing link, written by somebody whose session was stolen |
| **Searching *inside* documents** | — | **Refused, not deferred.** A search that could read the files would be a search run by something that can read the files. This is the product's central promise and the answer is no, permanently |
| **An audit of who changed what** | The event log records the *kind* of change and the person for `file.opened`; a full before/after diff for every edit | The log says what happened in words (`title → 2025 return — amended`). A structured diff is more machinery than the question needs |
| **Recurring asks on a schedule** | — | Refused since 2u: the remembering half is built (the season notice, the due list), and a robot that emails a client without a person reading the list first is the thing this product declines to be |
| **Multiple entities per client, in one place** | The strongest signal in the whole market research — the same respondent named it twice, about two different products | A design decision rather than a sprint: a link is issued for one request, so a page spanning several means deciding what a link may reveal. Noted in `roadmap.md` |
| **Item-level due dates** | Stage the checklist — ID by March, statements by June | Everything shares the request's date, and a request with four stages is a different product shape. No practitioner has asked for it |

### What is genuinely absent rather than refused

Two things a practice would look for and not find, and they are worth naming plainly:

1. **No way to send a document *to* a client other than the reminder text.** A practice cannot attach a
   template, a spreadsheet or a signed letter through Tickmark. The link mail goes out; nothing else can.
2. **Nothing exports the *history*.** Requests, clients and documents all export as CSV. The event log — arguably
   the most valuable record the product keeps — cannot be got out.

Neither is hard. Neither is in the research. Both are the kind of thing a practice asks for in month two.

## 2. Performance

Measured, not guessed. `node tools/bench.mjs 500` builds 500 clients with four documents requested and a file
against each, then times the pages five times and reports the median.

**Before this audit:**

| Page | 100 clients | 500 clients |
| --- | --- | --- |
| Board | 34 ms | 176 ms |
| Clients | 29 ms | 168 ms |
| Chase | 22 ms | 99 ms |
| Documents | 10 ms | 40 ms |
| CSV of requests | 12 ms | 44 ms |

Nothing here is broken — half a second at five hundred clients is not a crisis — but the *shape* was worth
understanding, and two things sat behind it.

### The finding: every `prepare` is a parse, and the code prepares on every call

`requestsFor` computes progress per request, and progress asks for the items, so a board of five hundred clients
runs the same two statements a thousand times per render. Every one of those re-parses the SQL.

Measured directly: twenty thousand `prepare`-then-read calls take 168 ms; the same twenty thousand against a
statement prepared once take 29 ms. **Re-parsing is 5.8 times the work.**

The fix is one seam rather than three hundred call sites: `openDatabase` gives each connection a cache keyed by SQL
text. Queries stay written next to the function that needs them — which is why the code reads the way it does — and
the parse happens once.

**Safe because** SQLite's `prepare_v2` re-prepares a statement whose schema has changed underneath it, so a cached
statement cannot go stale after a migration, and the set of distinct SQL strings is fixed by the source, so the map
cannot grow without bound. Both of those are claims rather than facts until tested, so there is a test: a statement
prepared before an `ALTER TABLE ADD COLUMN` still sees the new column afterwards.

The 5.8× figure comes from `tools/bench-prepare.mjs`, which is kept rather than folded into a comment so the number
can be re-derived on another machine. The figures in the table below come from `npm run bench N`.

**After:**

| Page | 100 clients | 500 clients |
| --- | --- | --- |
| Board | 34 → **26 ms** | 176 → **94 ms** (−47%) |
| Clients | 29 → 26 ms | 168 → **101 ms** (−40%) |
| Chase | 22 → **14 ms** | 99 → **38 ms** (−62%) |
| CSV of requests | 12 → **6 ms** | 44 → **19 ms** (−57%) |

Five hundred clients is a large bookkeeping practice. At that size every page a person uses daily is now under a
tenth of a second.

### The finding that is *not* fixed, and why

**Two N+1 patterns remain.** `requestsFor` asks for each request's progress in its own query, and the clients page
asks for each client's outstanding count in its own. At 500 clients that is around a thousand queries, and it is
why the board is 94 ms rather than 30 ms.

It scales linearly — 100 to 500 clients is 5× the rows and 5.2× the time — which puts the point where it hurts at
roughly **5,000 clients**: about a second to render a board. That is a bigger firm than this product is aimed at,
so this is a ceiling rather than a cliff.

Fixing it means computing progress for every request in one aggregate query instead of one per request. That is a
change to the single most-depended-on function in `store.js` — fifteen call sites — and the risk is specific and
familiar to this project: **the aggregate and the per-request version disagreeing**, which would put a count on the
board that the request page contradicts. That is exactly the class of bug found in phases 2t and 2w, and it is not
something to attempt at the end of a long session when the number in hand is tolerable.

**What it would take**, written down so it is a plan rather than a wish: one query grouping `request_item` and
`upload` by request; `requestProgress` reading from it; and a test that walks every request in a deliberately messy
fixture — withdrawn items, flagged items, answered items, an extra that answers nothing — asserting the aggregate
agrees with the per-request computation. Only then can the call sites be pointed at it, one at a time.

## 3. The code itself

**6,535 lines in `src/app.js`** — more than half the source, and the one thing here I would call a real
maintainability problem rather than a measured trade-off. It is not one thing: it is every route and every page and
the mail drafting and the notification logic, in one file, in a consistent style. Finding a handler is a search
rather than a scroll.

**Why it has not been split**: the route table is one screen, and every handler is a top-level function in the same
file, so the seam between a route and its handler is the shortest possible one. Moving handlers out means importing
them into the route table (fine) or moving the table too (worse). The risk is a large mechanical diff across a file
every test touches — for a readability gain rather than a behaviour one.

**The proposed split**, in the order I would do it, each step verifiable by the existing suite on its own:

| Module | What moves | Roughly |
| --- | --- | --- |
| `src/notices.js` | `arrivalDraft`, the reminder and opening drafts, `notifyPracticeOfChange` | ~450 lines, no route coupling, already covered by `notify.test.js` |
| `src/client-portal.js` | `clientPage`, `clientSays`, `clientMessage`, `receiveUpload`, `receiveExtra`, `acceptEnvelope` | ~600 lines, touched by five routes |
| `src/keys-views.js` | the setup, keys and re-encryption pages | ~700 lines |
| `src/board-views.js` | `listRequests`, `viewRequest`, the client pages, the templates pages | ~1,200 lines |

That leaves `app.js` as the route table, the dispatcher and the sign-in handlers — around 2,000 lines, which is a
file somebody can read in an afternoon.

**Also found, and stated rather than fixed:** three things this audit *thought* were dead code and were not — a
`href` helper in the board that is used eight times, an unused-looking binding in the first-run card that is live,
and a duplicated doc comment in `roles.js` that is not duplicated. All three were found by a tool, not by eye,
which is the point: *"is this used"* is a question a person gets wrong, and during this audit I got it wrong three
times out of four before writing `tools/find-unused.mjs`.

## 4. What the audit says overall

- **The product is not missing anything it needs to be usable.** Two real absences are named above, and both are
  month-two requests rather than blockers.
- **The security audit found one serious thing and it is fixed** — an unbounded second-factor challenge, in a
  feature built two passes ago.
- **Performance is fine and now measured**, with the remaining N+1 documented against the client count where it
  would start to matter, and a plan rather than a shrug.
- **The code has one real problem** — the size of `app.js` — with a split proposed in four steps that the existing
  test suite can verify individually.
- **Nothing was found that is currently exploitable.** Every claim in `docs/security.md` is backed by a test that
  attacks it or by reading the code, and the gaps are listed rather than discovered.

The pattern worth noticing across all three halves: **every finding came from attacking or measuring the thing
rather than from reading it.** The two-factor gap was invisible in the code and obvious the moment a test asked for
sixty wrong codes. The parse cost was invisible until twenty thousand calls were timed. The N+1 was a suspicion
until the board was rendered at five hundred clients. And the audit's own claims about dead code were wrong three
times out of four until a tool checked them — which is the same lesson this project's documentation keeps teaching
from the other direction: nine tables that were twelve, twenty-one event kinds that were twenty-five.

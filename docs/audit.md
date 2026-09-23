# A full audit: what is missing, what is slow, and what is left

The security half has its own file — `docs/security.md`. This is the other two thirds of the same exercise: the
feature gaps, and the code.

*This is a record of that day's audit. For what is true now — including the second-pass findings and
the fixes for the gaps listed below — `docs/security.md` and `CHANGELOG.md` are the living documents.*

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

**After the statement cache, before the N+1 work** — the table further down has the cumulative result:

| Page | 100 clients | 500 clients |
| --- | --- | --- |
| Board | 34 → **26 ms** | 176 → **94 ms** (−47%) |
| Clients | 29 → 26 ms | 168 → **101 ms** (−40%) |
| Chase | 22 → **14 ms** | 99 → **38 ms** (−62%) |
| CSV of requests | 12 → **6 ms** | 44 → **19 ms** (−57%) |

Five hundred clients is a large bookkeeping practice. At that size every page a person uses daily is now under a
tenth of a second.

### The N+1 patterns, fixed — and the bug that was hiding inside them

The first pass found two N+1s and did not fix them, with a plan written down instead: computing progress for every
request in one aggregate query, and the risk being that the aggregate and the per-request version disagree.

**Building that turned up a third instance of the bug class this project keeps finding, and a worse one.**

`progress.outstanding` counted documents with *no file*. The chase's `outstandingOf` counted documents with no file
**or** a flagged one. Two definitions of one word, both reading the same table, both looking right on their own — so
the board showed **0 outstanding** beside a request the chase was asking a client about. The number is worse than a
state word, because it looks precise:

```
   the practice flagged a document as unusable:
     progress.state         = to-check
     progress.outstanding   = 0   <- what the board shows
     outstandingOf().length = 1   <- what the chase asks for
```

It had been there for three passes. The state machine had already been fixed for exactly this case in 2w — the comment
even says *"a flagged document is not ready, and that took a bug report to notice"* — and the **count** beside that
state kept the old rule. The same fix had been applied to one and not the other.

**How it is fixed.** There is now one definition, in one SQL constant, and it reads:

```sql
COALESCE(u.files, 0) = 0 OR i.attention_at IS NOT NULL
```

It is used in two shapes — `outstandingRows`, which returns the documents, and `progressRows`, which counts them — and
neither writes the rule again. The state is derived from the count rather than from a second copy of the same
condition, so the number and the word beside it cannot say different things.

**The N+1s are gone**, because the counting happens once per page rather than once per row:

| Page | 100 clients (before → after) | 500 clients | 1,000 clients |
| --- | --- | --- | --- |
| Board | 34 → **12 ms** | 176 → **38 ms** | 59 ms |
| Clients | 29 → **8 ms** | 168 → **22 ms** | 53 ms |
| Chase | 22 → **7 ms** | 99 → **21 ms** | 40 ms |
| Ask everyone | 16 → **3 ms** | 79 → **10 ms** | 20 ms |
| CSV of requests | 12 → **3 ms** | 44 → **9 ms** | 17 ms |

Against the numbers this audit started with, the board is **4.6× faster** at five hundred clients and the clients page
**7.6×**. The board now scales *sub*linearly — 38 ms to 59 ms for double the rows — because the remaining cost is a
scan that does not grow with the number of requests, and at a thousand clients it is still under 60 ms.

The chase went from three N+1s to two queries: the documents wanted, and each client's last contact, both grouped.

**One thing the new test caught in the fix itself.** The counts come from grouping `request_item` rows, so a request
with *nothing on its list* produces no row and was simply absent from the batch map. Every caller happened to guard
with `?? NOTHING`, so nothing was broken — but a map that documents itself as complete and is not is a trap for the
next caller. `progressForPractice` and `progressForClient` are now total, and `test/progress-agreement.test.js`
asserts the size.

### A second pass: two more wastes found by asking where the milliseconds were

The board was 38 ms after the N+1 work, and `tools/bench-breakdown.mjs` says where a page's time goes rather than
how long it takes. It found the queries at 9.5 ms and the row markup at **0.06 ms** — so something like 28 ms was
unaccounted for, which is the sort of gap that turns out to be one line.

**`dateIn` built a new `Intl.DateTimeFormat` on every call.** Measured: 120 microseconds to construct one against
1.2 to use one that already exists — **a hundred times as much**. Invisible on a page that formats one date, and
severe on a page that formats one per row. The documents page was spending most of its hundred milliseconds
constructing formatters and throwing them away:

| Page, 500 clients | before | after |
| --- | --- | --- |
| Documents | 50 ms | **7 ms** |
| Documents, searched | 48 ms | **8 ms** |
| Board | 38 ms | **26 ms** |

The fix is a map keyed by zone, which is bounded because a zone only ever arrives from a practice's own validated
setting.

**A correlated subquery nobody read.** `requestsFor` carried
`(SELECT MAX(e.at) FROM event e WHERE e.request_id = r.id) AS last_activity_at`. A grep for the name found the query
and nothing else — no page displayed it — so every board render was doing one index lookup per request for a value
that went nowhere. Removed rather than kept in case: a field nobody reads is a cost paid on every render for a
hypothetical.

### A third pass: the same index, built three times

The N+1 work made each *call* cheap. It did not stop the same call happening more than once, and a probe written to
count statement executions found the board running **15 queries where 9 would do**:

```
the board (/requests) — 15 queries
  3x  SELECT id FROM request WHERE practice_id = ?
  3x  SELECT i.request_id AS request_id, COUNT(*) AS items, …   (the counts)
  2x  SELECT id, name, created_at, cadence_days, timezone, …    (the practice's own row)
```

Three identical passes over `request_item`, and two reads of one row. The reason was structural rather than careless:
three *unrelated* consumers each wanted the counts and none of them knew about the others — the table itself, the
season notice, and the first-run card. Each called in through a different function that built the index for itself.

**The fix is an idea borrowed from a sibling project** (`life-os/apps/cognivault`), where an `AnalysisContext` is
constructed once from the raw entries and handed to every analysis function that needs it. Its `BuildContext` does
the same for relationships: `milestonesByGoal`, `progressByGoal`, `habitsById`, all built in one O(n) pass and then
read in O(1). The lesson is not "cache" — it is **build the index once, pass it to the things that read it.**

So the three functions that need the counts now accept one that has already been built:

```js
const progress = progressForPractice(db, practiceId);
const all = requestsFor(db, practiceId, { scope, progress });
const due = clientsDueForAsking(db, practiceId, { timezone, progress, clients: everyone });
```

**That is deliberately not a cache.** A cache needs a lifetime and an invalidation rule, and every serious bug in this
product has been stale state — a count that disagreed with the list beside it, a state word that contradicted a
number. An index that lives for the length of one function call cannot go stale, and the only question it raises is
which caller builds it, which the code now answers by being explicit.

Two more things fell out of the same probe:

- **`firstRunCard` wanted a count**, not a page: it called `requestsFor(…, { scope: 'all' })` to ask whether *any*
  request existed, building every request's counts to answer a yes/no question. There is now `countRequests`.
- **`viewRequest` called `itemsOf` twice for one request** — once for the table, once to decide whether to show the
  "email this request" button.

| | queries before | after | page time at 500 clients |
| --- | --- | --- | --- |
| Board | 15 | **10** | 31 → **19 ms** |
| Clients | 10 | **6** | 30 → **23 ms** |

And `tools/probe-repeats.mjs` — the counter, which hooks the statement cache — now reports **"every page asks each
question exactly once"**. It is kept as a regression guard rather than thrown away, because the thing it catches is
invisible to tests: every page still renders correctly with the index built three times, just slower.

**What it does not fix, and why that is right.** The reminder draft reads `request_item` twice with two different
shapes — `itemsOf` for every document, `outstandingOf` for the ones still wanted. Merging them would mean deriving
"outstanding" from the full list by hand, which is the second-definition-of-a-word bug this project has now fixed
three times. Two queries, one rule, and the rule stays in exactly one place.

### Then the bytes, which is where the rest of it was

88% of a Tickmark page is the stylesheet, and the stylesheet is inlined on purpose so that a page needs no second
request. That makes every page 37 KB, sent uncompressed by a bare `node src/server.js`.

Responses are now gzipped when the client asks, in-process, using `zlib` from the standard library — no dependency,
and it means a self-hosted install behind nothing gets the benefit rather than depending on a proxy the documentation
merely recommends. `tools/bench-gzip.mjs` chose the level: **level 1, not the default 6**, because on a 500-row board
level 1 sends 12.1 KB in 0.37 ms where level 6 sends 10.3 KB in 0.93 ms — 1.8 KB more for 0.56 ms less, which is
where the knee is.

**The trade, stated rather than claimed as a win.** A 122 KB board becomes 12 KB. The round trip a client observes in
the benchmark at 500 clients went from 26 ms to about 31 ms, and most of that 5 ms is *the client* undoing the gzip,
not the server doing it — the server's share is under half a millisecond. So: a small latency cost, a tenfold
reduction in bytes. On a local network that is roughly a wash; over the internet, on a VPN, or on a poor line it is
the difference between a page that appears and a page that arrives in pieces. `no-transform` is honoured, a body under
a kilobyte is left alone, and an encrypted document is **never** compressed because it is already ciphertext.

Five tests in `test/compression.test.js` check it on a raw socket rather than through `fetch`, because `fetch`
decompresses transparently and would have proved that the body round-trips while proving nothing about the bytes,
`content-length`, or the negotiation.

## 5. Where the architecture actually limits this, and where it does not

Everything above was work removed. This is the part that cannot be removed without changing a decision, and it is
worth being exact about because "are we architecturally limited" has three different answers depending on who is
asking.

### Not a limit: the database

SQLite was the right choice and it has not been the problem at any point. The pages are one query each, an index
exists for every join, and the worst page at a thousand clients is 62 ms *including* its compression. The statement
cache removed the last thing that was structurally wasteful.

The one shape that would make SQLite wrong is many tenants in one file with heavy concurrent writes — and that is not
this product's shape. **In hosted mode each practice is its own file**, so a tenant's write contention is with its own
three users, which is no contention at all. The pooling and isolation work in `docs/saas.md` is what makes that true,
and it is the reason this section is short.

### Not a limit: the queries, now

Covered above. Worth one line of contrast — `requestsFor` at a thousand clients costs about 12 ms of which most is
the client join, and that is a scan of a thousand rows to build a page. There is nothing left to fix that would be
honest to call a problem.

### A real limit: one process, synchronous, one core

**This is the actual answer to the question.** `src/server.js` calls `server.listen()` once, in one process, and
`node:sqlite` is synchronous. So while any request is doing database work the event loop is blocked, and every other
request waits. Throughput per process is therefore bounded by `1 / (time per page)`, and **adding cores does not help**.

At the current numbers that is roughly 30-150 requests a second per process depending on the page — which for this
product's target customer (a practice of one to five people, a handful of requests a minute) is not a limit they will
ever see, and for a self-hosted install is not a limit at all.

It matters for hosted scale, and it has a known, bounded answer rather than a rewrite:

| Concern | Fix | Cost |
| --- | --- | --- |
| One core, one process | `node:cluster`, one worker per core, each with its own connection pool | Small. The pool and registry already take a file path, so workers share nothing and need no coordination — except that the statement cache is per connection, which is fine |
| A slow page blocking others | The same, since a blocked worker only blocks its own share | — |
| Many open database files | Already handled: the pool evicts least-recently-used handles | — |

**The honest number**: one process serves roughly 30-150 requests a second, and a practice of five people generates
perhaps one request every few seconds while they are working. So one process is comfortable for on the order of a
hundred practices, and four workers for four hundred. That is a long way past the point where the question becomes
interesting, and the fix is a `cluster` branch in `server.js` rather than a different architecture.

**What would be a genuine architectural limit** — and each of these is a decision this product made on purpose:

- **Reading the documents** to search or analyse them. Impossible by design: the server has no key. No amount of
  engineering changes this, and that is the point of the product.
- **Many tenants in one database.** Also by design — the per-tenant file *is* the isolation wall. A shared database
  would need row-level security over an engine that has none, which is the trade `docs/saas.md` documents at length.
- **Horizontal scale across machines.** Each tenant's data is a local file, so a tenant belongs to one machine. Fine
  for thousands of practices and wrong for millions, and the answer at that point is the same one every product like
  this eventually reaches: shard by tenant, which the resolver already makes possible because a tenant is named by an
  id and a directory.

So: **not limited by the architecture in any way the target customer will reach, and limited by one process and one
core for hosted scale** — with a fix that is small, well-understood, and does not touch the parts of this codebase
that are hard.

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

**Since this was written, all four steps are done, and a fifth besides** — `src/notices.js` holds the letters,
`src/client-portal.js` the client's page and the five things a client can do on it, `src/keys-views.js` the key, and
`src/board-views.js` the board and the request page. The fifth is `src/members-views.js`: who is in a practice, how
somebody joins it, and what the practice is called — the one subject the table above did not name, and the largest
thing the plan left behind.

`app.js` has gone from **7,173 lines to 3,901** (357 KB to 191 KB — 46% of it gone), and the helpers that more than one
side needed moved out to `src/views.js`, `src/http.js`, `src/clock.js`, `src/store.js`, `src/auth.js` and a new
`src/blobs.js`. What is left is the sign-in and two-factor pages, the account pages, the chase list, the templates and
the client records, the assets and the route table. `CHANGELOG.md` has all five entries.

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
- **Performance is fine and now measured**, and the two N+1 patterns this audit found are fixed along with a bug
  hiding inside them. At a thousand clients — a firm well beyond the one this product is aimed at — every page in a
  morning's loop renders in under 60 ms.
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

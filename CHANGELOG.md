# What changed, and when

One entry per release, newest first, written for somebody deciding whether to upgrade rather than for a
changelog reader. `docs/roadmap.md` has the reasoning behind each of these; this is the summary.

Versions follow the ordinary convention: the first number changes when the schema or a promise does, the second
when features arrive, the third for fixes. **Downgrading is not supported** — migrations only go forwards — so
the entry that matters most is the one that says the schema changed.

**Three more wastes, found by asking where the milliseconds were.** The board was 38 ms and the breakdown tool put
the queries at 9.5 ms and the row markup at 0.06 ms — so ~28 ms was unaccounted for:

- `dateIn` built a new `Intl.DateTimeFormat` on every call: **120 µs against 1.2 to reuse one**, a hundred times as
  much. The documents page was spending most of its hundred milliseconds constructing formatters and discarding
  them. **50 ms → 7 ms.**
- `requestsFor` carried a correlated subquery producing `last_activity_at`, which nothing read. One index lookup per
  request, per render, for a value that went nowhere.
- **Responses are now gzipped** when the client asks, in-process via `zlib` — no dependency. 88% of a page is the
  inlined stylesheet, deliberately, so a page is 37 KB; it is now **12 KB** for a 122 KB board. Level 1 rather than the
  default 6, chosen by measurement: on the biggest page level 1 sends 1.8 KB more and costs 0.56 ms less.

The trade is stated rather than claimed as a pure win: the round trip a client observes went from 26 ms to about
31 ms at 500 clients, most of which is the *client* undoing the gzip. A small latency cost for a tenfold reduction in
bytes — a wash on a fast LAN, decisive over the internet or a VPN. Ciphertext is never compressed, `no-transform` is
honoured, and bodies under a kilobyte are left alone.

**Where the architecture actually bounds this, written down in `docs/audit.md` §5.** The database is not the limit;
the queries are not; **one process on one core is**, because `node:sqlite` is synchronous and `server.listen()` is
called once. Throughput is roughly 30-150 requests a second per process, which is a hundred practices' worth — and
the fix at that point is a `cluster` branch in `server.js`, not a different architecture.

**Then the same index, built three times.** The N+1 work made each *call* cheap; it did not stop the same call
happening twice. A counter on the statement cache found the board running **15 queries where 9 would do** — three
identical passes over `request_item` and two reads of the practice's own row, because the table, the season notice
and the first-run card each wanted the counts and none knew about the others.

The fix is an idea taken from a sibling project, where an `AnalysisContext` is built once from the raw entries and
handed to every function that needs it. The lesson is not "cache" — it is **build the index once and pass it to the
readers**, which is why the three functions now accept one that has already been built:

```js
const progress = progressForPractice(db, practiceId);
const all = requestsFor(db, practiceId, { scope, progress });
const due = clientsDueForAsking(db, practiceId, { timezone, progress, clients: everyone });
```

**Deliberately not a cache**: a cache needs a lifetime and an invalidation rule, and every serious bug in this
product has been stale state. An index that lives for one function call cannot go stale.

| | queries | page time at 500 clients |
| --- | --- | --- |
| Board | 15 → **10** | 31 → **19 ms** |
| Clients | 10 → **6** | 30 → **23 ms** |

`npm run probe:repeats` is kept as a regression guard and now reports *"every page asks each question exactly once"*.
It catches something no test can: every page renders correctly with the index built three times, just slower.

## Unreleased, expected in 0.1.0 — the premium pass

**The SaaS front door got a premium pass, and an icon set to do it with.**

The portal pages — sign up, sign in, the dashboard, the billing wall — were written before the design system grew up.
They used bare `<h1>`, a `<table>` and `status.replace('_', ' ')` while the rest of the product had tiles, badges,
states and facts lists, so the front door looked like a plainer product than the room behind it. That matters most
there: **it is the only page where somebody decides whether to trust the software at all.**

**Ten icons, drawn inline**, 16×16, `currentColor`, `stroke-width` 1.6. In `src/views.js`, because the mark already
lives there and an inline path cannot 404. Their names are meanings rather than pictures — `shield`, `clock`, `arrow`
— and every one of them sits beside the word it means, which is why they are all `aria-hidden`.

**The drawing attributes sit on the `<svg>` rather than on each shape**, because `stroke`, `stroke-width`, `fill` and
the caps are inherited properties. The first version appended them to `<path>` elements only, which would have made
the `card` icon's `<rect>` and the `clock` icon's `<circle>` invisible — a bug that shows up as a missing icon
rather than as an error, and only on the icons nobody happened to look at.

**`STATUS_LOOK`** is now the one place a subscription state becomes words and a tone, so `pending_payment` cannot be
a warning on the dashboard and a neutral fact on the wall. That is the same class of bug this project has fixed
three times — two descriptions of one thing drifting apart — and it is now prevented by construction rather than by
care.

Also fixed while looking: the mark and the favicon were **two hand-written copies** of one drawing, with a comment
claiming they were identical and nothing making them so. They are now built from one constant. Deleting one of them
by accident took down every page and every test with `FAVICON is not defined`, which is how the duplication was
found.

**And a checker, because one mistake has now cost three sessions.** `npm run check:style` fails if a **backtick**
appears inside the CSS template literal — which ends the string and breaks the module, with an error pointing at a
line of CSS rather than the comment that caused it — and walks the braces in order rather than counting them, so a
rule that never closes is reported rather than silently swallowing everything after it.

`npm run preview:gateway` renders all thirteen states to `tmp-gateway/` — including the two a locked-out practice
sees, which otherwise need a webhook to have fired. 357 tests pass. No schema change.

## Unreleased, expected in 0.1.0 — navigation, and a hole in the second factor

Asking *"is anything needed not reachable?"* — and finding something much worse than a missing link.

**Two navigation fixes first.** Every gateway page's header offered **"Sign in"**, including the dashboard (to
somebody already signed in) and the billing wall, which had **no way back to the account and no way to sign out at
all**. The header now has three cases — a practice member, a signed-in account, a stranger — and `page()` gained
`account` to express the middle one. The wall reads the session from `response.req`, because the resolver hands that
callback the response rather than the request. `/login` no longer links to itself.

**Then the hole.** The gateway's platform sign-in verified the password and then **bridged** — minting a session
inside the practice's own database so the workspace pages find the person they expect — without ever asking whether
the practice had a second factor armed. So **a practice with TOTP enabled could be entered without a code by signing
in at the platform instead of at the practice's own sign-in page.** Two-factor exists to stop somebody who already
knows the password; a second door that does not ask defeats it completely, because the attacker uses the front door.

The bridge now refuses to mint a session for a member with a second factor armed. The platform session still exists —
the dashboard and billing need it — and the person is sent to the dashboard, which says what to do: *"Your practice
asks for a code from your authenticator, so open your workspace and sign in there to enter it."* The alternative was
teaching the gateway the core's challenge flow, which is a second implementation of the one thing here that must not
be got wrong.

**A new tool that found both.** `npm run check:nav` renders every public state and fails on a dead end (a page with no
way onward) or an orphaned route (one nothing links to). Neither bug was visible to the test suite; both are obvious
to it. The navigation question is what led to the security question, one step behind it.


The portal pages — sign up, sign in, the dashboard, the billing wall — were written before the design system grew up.
They used bare `<h1>`, a `<table>` and `status.replace('_', ' ')` while the rest of the product had tiles, badges,
states and facts lists, so the front door looked like a plainer product than the room behind it. That matters most
there: **it is the only page where somebody decides whether to trust the software at all.**

**Ten icons, drawn inline**, 16×16, `currentColor`, `stroke-width` 1.6. In `src/views.js`, because the mark already
lives there and an inline path cannot 404. Their names are meanings rather than pictures — `shield`, `clock`, `arrow`
— and every one of them sits beside the word it means, which is why they are all `aria-hidden`.

**The drawing attributes sit on the `<svg>` rather than on each shape**, because `stroke`, `stroke-width`, `fill` and
the caps are inherited properties. The first version appended them to `<path>` elements only, which would have made
the `card` icon's `<rect>` and the `clock` icon's `<circle>` invisible — a bug that shows up as a missing icon
rather than as an error, and only on the icons nobody happened to look at.

**`STATUS_LOOK`** is now the one place a subscription state becomes words and a tone, so `pending_payment` cannot be
a warning on the dashboard and a neutral fact on the wall. That is the same class of bug this project has fixed
three times — two descriptions of one thing drifting apart — and it is now prevented by construction rather than by
care.

Also fixed while looking: the mark and the favicon were **two hand-written copies** of one drawing, with a comment
claiming they were identical and nothing making them so. They are now built from one constant. Deleting one of them
by accident took down every page and every test with `FAVICON is not defined`, which is how the duplication was
found.

**And a checker, because one mistake has now cost three sessions.** `npm run check:style` fails if a **backtick**
appears inside the CSS template literal — which ends the string and breaks the module, with an error pointing at a
line of CSS rather than the comment that caused it — and walks the braces in order rather than counting them, so a
rule that never closes is reported rather than silently swallowing everything after it.

`npm run preview:gateway` renders all thirteen states to `tmp-gateway/` — including the two a locked-out practice
sees, which otherwise need a webhook to have fired. 357 tests pass. No schema change.

## Unreleased, expected in 0.1.0 — one word with two meanings, and the counts that came with it

**One word with two meanings, for the third time, and this one was a number on the board.**

`progress.outstanding` counted documents with no file. The chase's own list counted documents with no file **or** a
flagged one. So a request where everything had arrived, been looked at, and one document had been sent back showed
**0 outstanding** while the chase was asking the client about it. The state machine had been fixed for exactly this in
2w and the count beside it had not — the same fix applied to one place and not the other.

There is now one definition, in one SQL constant, used by both the count and the list; and the state is derived *from*
the count rather than from a second copy of the same rule. That is what makes a repetition of this impossible rather
than unlikely.

**The performance work that found it.** Every page that lists requests was running a query per row — and the clients
page, a query per row per request. All of them now compute every request's counts once, before drawing:

| Page | 500 clients: before → after |
| --- | --- |
| Board | 176 → 38 ms |
| Clients | 168 → 22 ms |
| Chase | 99 → 21 ms |
| Ask everyone | 79 → 10 ms |

At a thousand clients every page in a morning's loop renders in under 60 ms, and the board is now sublinear. **No
schema change** — this release is a rewrite of how the counts are computed, and `test/progress-agreement.test.js`
(8 tests) checks that every way of asking agrees rather than checking numbers against a list.

## Unreleased, expected in 0.1.0 — the audit

Features, performance and security, end to end. Nothing below is published yet; it is in the tree and will go out
with the first version.

**One serious problem found and fixed, and it was in the feature whose whole purpose is stopping somebody who
already knows the password.** The two-factor sign-in accepted unlimited wrong codes: a six-digit code with no
attempt limit is a million guesses against a door that stays open for ten minutes, and the password rate limiter
never saw any of them because it is consulted *before* the password is checked. There is now an account-level
limiter in a bucket of its own, plus a five-attempt ceiling on the challenge itself so that a deployment which
replaces the limiter still cannot be walked. `test/security.test.js` attacks it, and the test that proved the gap
asked for sixty wrong codes and got sixty answers.

**Two smaller hardening fixes.** Two script tags built their own JSON-in-a-script-element markup with a bare
`JSON.stringify`, bypassing the one helper that escapes the one sequence that matters — nothing could break there
today, which is exactly why it was worth fixing before something could. And there were **no security headers at
all**; responses now carry `Referrer-Policy: no-referrer` (a client's URL is a credential, so it must not travel
to whoever they link to next), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Cross-Origin-Opener-Policy: same-origin`, on every response type including served documents.

**Performance was measured rather than guessed.** Every `prepare` is a parse and this code prepares on every call,
so a board with five hundred clients re-parsed the same two statements a thousand times per render — measured at
**5.8× the work** versus preparing once. Connections now cache their statements: at 500 clients the board went
176 ms → 94 ms and the chase 99 ms → 38 ms. Two N+1 patterns remain and are documented against the client count
where they would start to matter, with a plan rather than a shrug.

**Withheld on purpose:** no Content-Security-Policy. One worth having needs a per-response nonce threaded through
every rendering path, and `unsafe-inline` in a CSP is the claim that a page is protected when it is not.

`docs/security.md` states every promise with how it is checked and every known gap with why it is open;
`docs/audit.md` has the feature and performance halves. Four tools arrived with them: `npm run bench`,
`npm run find:unused`, `npm run tables`, and `tools/bench-prepare.mjs`. The schema changed by one column
(`login_challenge.attempts`), and the migration adds it in place rather than rebuilding.

## 0.1.0 — 23 September 2026

The first release. Everything before it was development, and the version number went from `0.0.0` to something
that means "this is the one to run".

**What it is.** A practice makes a checklist for a client, sends a link, and the client uploads documents through
it with no account. The files are encrypted in the client's browser to a key the practice holds, so the server
stores what it cannot read.

**The promises worth knowing before you rely on it:**

- **The server cannot read the documents.** Not as a policy — it never receives a key. Anyone can check that by
  reading `src/crypto.js` and the upload path. It also means `/files` searches filenames and never contents.
- **Losing the passphrase destroys the documents.** There is no recovery, no backdoor and no reset. This is the
  one thing to tell a practice before they start.
- **The self-hosted edition is free forever**, and the licence cannot be taken back: AGPL-3.0, with no clause
  that would let a future version be pulled.
- **Backups are `node tools/backup.mjs`**, not a file copy. See `docs/operations.md`.
- **Opening a document is recorded**, with who did it, so the practice can answer "who has seen this file?".
- **Two-factor is available** per member, and worth turning on: a stolen password can otherwise add an encryption
  key of its own, and every upload after that would be sealed to somebody outside the practice.

**What it does not do**, stated rather than implied: it does not read or analyse documents, it will not email a
client without somebody pressing a button, and it does not connect to tax software. Those are decisions, not
gaps — `docs/roadmap.md` has the reasoning.

**What is not proven.** The hosted layer — multi-tenancy, billing, the Stripe checkout and webhook — is built
and tested but has never been driven against a real Stripe account. `docs/saas.md` says so in the place it
matters. The self-hosted path is exercised end to end by `npm run check:container`.

**The schema, for anybody upgrading from a development checkout:** sixteen tables, and the migrations in
`src/db.js` run at startup and report what they did. Three of them rebuild a table (`invite`, `upload`, and the
key wrappings) because SQLite cannot relax a constraint in place; each verifies its own row counts and refuses
to run rather than completing with a row missing.

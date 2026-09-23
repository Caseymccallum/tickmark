# What changed, and when

One entry per release, newest first, written for somebody deciding whether to upgrade rather than for a
changelog reader. `docs/roadmap.md` has the reasoning behind each of these; this is the summary.

Versions follow the ordinary convention: the first number changes when the schema or a promise does, the second
when features arrive, the third for fixes. **Downgrading is not supported** — migrations only go forwards — so
the entry that matters most is the one that says the schema changed.

## Unreleased

Entries for what is true now and not yet in a numbered release. Written as they land rather than saved up for a
tag, because a changelog assembled at release time is one reconstructed from memory.

### The browser's scripts are cached by content, and compressed at last

The scripts a page needs in order to encrypt or move a document were served `no-store`: the right instinct for the
wrong reason. A browser holding an old copy of the encryption script is a class of bug this product cannot afford, so
the answer taken was to never let it hold one — at the cost of re-sending the file on every visit. They are served
`no-cache` with an `ETag` now, which gets both halves: the browser may keep the file, must ask before using it, and is
told *not modified* unless the bytes have actually changed. The hash is taken from the bytes being sent rather than
from a remembered copy, because a remembered hash beside a freshly read body is a 304 that lies — the exact failure
`no-store` was there to prevent. `test/assets.test.js` rewrites a script underneath a running server and asserts the
validator moves with it.

They had never been compressed either: the asset route was the one place in the product that skipped `acceptableBody`,
and nothing tested it. A client's page pulls `upload.js`, `preflight.js` and the crypto module — 28.4 KB of scripts,
re-sent on every visit to the one page somebody opens on a phone on a train. That is **11.0 KB** on a first visit now,
and on a repeat one a 304 and its headers.

The compression numbers in `src/http.js` were re-measured while passing, because they had drifted with the sheet: a
page is 43 KB rather than 37.9, and **brotli has changed sides** on the larger sheet — quality 5 takes the stylesheet
to 10.9 KB where gzip's level 1 takes it to 13.6, for 2.5 ms against 1.0. Stated rather than switched: every page
inlines the sheet, so a live server pays that CPU on every response, and the paragraph says where to measure again if
bandwidth ever matters more than CPU.

406 tests, all green.

### The tests reach the browser's other half, and the checks learn arithmetic

Two things were true and are now not. Five of the nine browser modules — `setup.js`, `keys.js`, `reencrypt.js`,
`members.js` and `invite.js` — were served on their pages and executed by nothing, so the claims around them lived in
prose. And the checks that guard the look were structural only: a page could lose its accessibility, and a colour
could drop below the contrast it needs, with every gate still green.

**The browser's other half is run now.** `test/browser-keys.test.js` drives making a key, changing the passphrase that
protects it and moving stored files onto it; `test/browser-invite.test.js` drives creating an invitation and accepting
one. `test/fake-dom.js` grew a general `installPage` for the pages that touch a *key*, and the crypto is not
re-implemented anywhere: what a page puts on the wire is opened again with the real `web/tickmark-crypto.js`. Eleven
tests — and the first run caught the fault that reading had only half-seen. `members.js` was posting the invitation
secret to the server in the same request as the sealed blob, while the page's own copy says that secret never reaches
a server; and the link was built *from* the posted field, which is how a field nothing reads had survived. Both are
fixed now, and the assertion that keeps them fixed names the three fields an invitation is allowed to carry.

**The checks grew the parts that are arithmetic.** `check:style` measures 38 pairs of text and background — every ink
on every surface, every state on its own fill, in both modes — against 4.5:1, fails on a token defined in one mode
only, and fails on a variable that is used and never defined. That last one found `.promise { border-radius:
var(--radius) }`: a token that has never existed, so the browser threw the declaration away and the trust block on the
sign-up page has been square-cornered since the day it was written. `check-pages` now refuses two `h1`s, a skipped
heading level, a control with no name, and a drawing that is neither labelled nor hidden — and running it over the
rendered pages is what gave names to the five passphrase fields and to the client page's upload fields, which only a
placeholder had ever named. The gateway's fourteen states are rendered and checked in CI now
(`npm run check:gateway`), which immediately found that the preview had never stamped its nonce.

403 tests, all green.

### The front door gets the details the work pages already had

A design pass over the shell, the public pages and the landing page: no new colour, no new dependency, and the
stylesheet went from 315 rules to 339. Most of it is the kind of thing that is invisible until it is missing.

**What was missing, rather than what was wrong.** Every page now opens with a skip link — eight navigation links
stood between a keyboard and the page's own content — and it is off-screen until it is focused. A phone's browser
chrome takes its colour from the page, through the two `theme-color` values the shell reads from a `CANVAS`
constant rather than typing out twice. Anchors land below the sticky header instead of behind it. A tap is not
held back by a double-tap that will never come, and a recovery code or an email address no longer attracts a
spellchecker's red line. The landing page's hero has one orchestrated arrival — five elements, 60ms apart — which
is the only motion on that page beyond a hover state, and it is off for anybody who asked for less.

**The one thing measured rather than chosen.** `--faint` was `#8b95a3`: 2.9:1 on the canvas, which made table
headers, eyebrows and the footer something a person had to work to read. It is `#656e7b` now — 4.9:1 on the
canvas, 5.2 on a card, 4.7 on the sunken fill, and `#7a8491` in the dark — so the four ink weights keep their
order and the quietest one stops being decoration. Both sheets carry the same values, because a token that drifts
is the first sign the marketing page and the application have stopped being one product.

**A practice prints things**, so there is a print stylesheet: the header, the nav, the footer, the buttons and the
search boxes come off, shadows and tints go, a row or a card is not split across two sheets, and the one block a
reader must not miss keeps its tint through `print-color-adjust`. And because two of these are invisible in a
screenshot of a page that has lost them, `tools/check-pages.mjs` now refuses a page without its skip link or its
theme-colour pair, and `tools/check-site.mjs` holds the landing page to the same rule.

392 tests, all green.

### The split, all five steps in

`src/app.js` was **357 KB** — the one thing `docs/audit.md` called a real maintainability problem rather than a
measured trade-off, with a four-step split proposed and nothing done about it. **All four are done, and a fifth
besides.** At 3,901 lines the file is 3,272 shorter than when the audit measured it — 191 KB against 357, which is 46%
of it gone — and what is left is the sign-in and two-factor pages, the account pages, the chase list, the templates and
the client records, the assets and the route table.

**Step one** was the audit's own first choice, for the audit's own reason: no route coupling, and the suite already
owned it. The letters moved to `src/notices.js` — `arrivalDraft`, `openingDraft`, `reminderDraft`,
`notifyPracticeOfChange` (the only message the product sends by itself) and the `signOff` they share — and the claim
held: the new module lands at **100% of its lines and functions** covered. Three test files now import the drafts from
where they live rather than through the application.

**Step two** was the harder one the audit named: `src/client-portal.js`, the page behind a link and the five things a
client can do on it. Moving it forced four things out of `app.js`, because code on both sides of the new seam uses
them and a helper left behind becomes a circular import:

- **`jsonTag`, `sendJson` and `fail`** went to `src/views.js`, where the rest of the answering already lives. `fail`
  is now the one place every refusal in the product is written, which is what makes *errors are pages, not stack
  traces* true by construction instead of by remembering.
- **`originOf`** went to `src/http.js` — the one thing only a request can answer, in the module that already exists
  for what a request carries.
- **`readHead`** went to a new `src/blobs.js`: the single place this server reads a stored document, 84 bytes at a
  time, needed by the client's upload path and by the practice's replace route for the same reason.
- **`CLIENT_SAYS`** — the two sentences a client can send instead of going quiet — moved with the page that renders
  them. Six store imports (`MAX_CLIENT_MESSAGE`, `tokenLookup`, `itemInRequest`, `recordUpload`, `setClientSays`,
  `recordClientMessage`) left `app.js` with the code that was their only user.

**Step three** is the key: `src/keys-views.js`, 526 lines — making one (`setupForm`, `saveKeys`), seeing them
(`keysPage`), moving files onto a new one (`pendingFor`, `reencryptFile`, `retireKey`, `moveWithoutScript`) and changing
a passphrase. It is the only module that touches key material, and it does it without ever being able to use it:
`publicKeyProblem`, `wrappedKeyProblem` and `keyProblem` validate the *shape* of a key and nothing more. Two more
helpers moved for the same reason as before — `requireSignIn`, the guard thirty-odd signed-in pages open with, to
`src/views.js`, and `tellOwners`, the letter announcing a key or a membership change, to `src/notices.js` where the
other letters live. Eleven imports left `app.js` with the code that was their only user, and the whole envelope-format
import went with them: the server's half of the encryption no longer appears in `app.js` at all. And the note
describing the keys page, which had drifted hundreds of lines from its function to sit above `saveKeys`, is now above
`keysPage`.

**A dead export that only an unused import was hiding.** Cleaning up after the move made the `find:unused` gate fail:
`ROLE_BLURBS` — three sentences describing the roles — had been exported from `roles.js` and rendered nowhere at all.
The gate could not see it while `app.js` imported it, because the import line itself counted as a reference. The blurbs
are gone, and the picker on the invite form writes its own copy. A gate that counts references cannot tell an import
from a use, which is worth knowing about every gate in this repository.

**Step four** was the last of the plan's four and the biggest: `src/board-views.js`, 1,096 lines — the board
(`listRequests`, `firstRunCard`), the request view (`viewRequest`), the forms that make a request (`newRequestForm`,
`createRequestPage`, `requestForm`) and the same board as a file (`requestsCsv`). Everything in it answers one
question, *whose turn is it?*, and two of its decisions are the kind that rot quietly: a request's state is derived
from the documents' own columns rather than stored anywhere that could disagree with the list, and the orderings are
named once so the screen and the export cannot sort differently. Four helpers came out with it —
`REQUEST_STATE_WORDS` and `stateTone` to `src/views.js`, because they are presentation vocabulary; `parseItems` to
`src/http.js`, because it parses a submitted textarea; and `agoWords` to `src/clock.js`, because it is time arithmetic
in words.

**Step five** is not in the plan at all: `src/members-views.js`, 720 lines — who is in a practice, how somebody joins
it, and what the practice is called. The invitation created, claimed and revoked, roles changed, members removed, and
the settings that are a practice's own. It exists because of what the plan left behind: once the four were gone, this
and the account pages were the last things in `app.js` that were about a *subject* rather than about routing. Two more
helpers moved to where they belong — `EMAIL_SHAPE` and `validateCredentials` to `src/auth.js`, where `MIN_PASSWORD`
already lived, so that the sign-up page and an invitation claim validate a new credential through one function — and
two limits (`INVITE_DAYS`, `MAX_PRACTICE_NAME`) moved with the pages that are their only readers.

**The helpers are the shape of the whole exercise.** Fifteen functions and constants left `app.js` for another module
across the five steps, and not one of them because it was in the way: a helper needed on both sides of a new seam is a
circular import waiting to happen. That is what a monolith actually is — not one large file, but a file everything else
is allowed to reach into — and the work of splitting it is mostly the work of finding out what deserves a home of its
own. `src/views.js` took six (`jsonTag`, `sendJson`, `fail`, `requireSignIn` and the state vocabulary), `src/http.js`
two (`originOf`, `parseItems`), `src/auth.js` two, `src/store.js` two, `src/clock.js` one, `src/notices.js` one, and
one — the only thing in the product that reads a stored document — got a module of its own.

**One bug the move caused, and it is the interesting part.** `CLIENT_SAYS` is a module-level constant that was never
exported, so it appeared in no import list — and an analysis of *exports* therefore did not find it. The client page
answered 500 until it moved. Every static check said the seam was clean; the thing that caught it was 392 tests
driving a link, which is the difference this repository keeps writing down between reading a claim and checking it.

**The same shape of bug happened again in step three, and that is the part worth keeping.** Widening the analysis to
every top-level declaration worked — nothing was missing from the new module. What went wrong instead was a hand edit:
rewriting one import line dropped `tellOwners` while the routes that used it stayed behind, and every member-removal
test went red with `ReferenceError: tellOwners is not defined`. Twice now the failure has been an import list
disagreeing with the code, and twice the only thing that noticed was the suite — not reading, and not a static check.
The lesson is not about the analysis being wrong; it is that a mechanical move should stay mechanical, and that 392
tests driving real pages remain the only check here that reads the whole system.

### Two more subjects leave the file, and one of them takes a lesson with it

`src/account-views.js` (261 lines) and `src/chase-views.js` (626 lines): a person's own password, address and sessions;
and the chase list with every message it can send. `app.js` is **3,018 lines and 149 KB** against the 7,173 and 357 KB
the audit measured — **58% of it gone** — with the sign-in and two-factor pages, the templates, the client records, the
per-request actions, the assets and the route table left inside it.

`messageFor` went to `src/notices.js` with the other letters, and for the same reason those exist: a reminder that says
one thing on a single request's page and another in a run to fifty clients is a disagreement that shows up in a
client's inbox. The chase's three constants went with the chase — days for a bulk link, a cap on the cadence, and the
run's time budget — except the budget, which the bulk ask in `app.js` shares and therefore imports.

**The mistake is worth recording, because the recovery is the part that worked.** The chase block was sliced with line
numbers measured *before* two earlier edits had shifted the file, so both `app.js` and the new module were cut in the
wrong places: the module began five lines into a doc comment and ended inside the function after it. Nothing was lost.
`app.js` came back from the last commit with `git checkout`, the half-written module was deleted, and the account move
that had already been done was simply done again from the restored file — with its boundaries **re-measured rather than
remembered**. Fifteen minutes, no harm, and one rule worth keeping: measure the boundaries in the file you are about to
edit, not in the one you measured an hour ago.

### One request's actions leave the file, and the file is a third of what it was

`src/request-actions.js` (737 lines): a request's own link, its letters and the documents on it — `serveEnvelope`,
`issueLink` and `revokeLink`, the reminder and opening drafts, sending them, closing and reopening a request, and
adding and editing its items. The three things in it that are load-bearing are stated at the top of the module: a link
is issued and never recovered, a letter is drafted rather than sent by a robot, and what a client sent is served as an
envelope because the browser is the only place it can be opened.

`app.js` is **2,326 lines and 117 KB**, against the 7,173 and 357 KB the audit measured — **67% of both gone**. What is
left is the dispatcher, the route table, the assets, and the four sections `docs/splitting.md` lists with the recipe
for each.

**This move needed nothing from `app.js`.** Every helper a seam had forced out over the previous six was already where
this one wanted it, which is the sign the seams are in the right places — `docs/splitting.md` records it so the next
four are easy to judge.

**And one bug, which was mine and not the analysis's.** The analysis named two imports — `createReadStream` from
`node:fs`, and `open` and `stat` from `node:fs/promises` — and I read them as a single line, importing `stat` from
`node:fs`. There, `stat` is the callback API, so `await stat(path)` quietly produced nothing and every test that serves
an envelope went red: the envelope route, the compression exemption, the opening record, the re-encryption pass. One
run of the suite found it. That is the third time in this series that a hand-written import list has been the failure
and the third time the tests were the only thing that noticed — and the first time the analysis was right and the
transcription was wrong, which is its own lesson about doing these at the end of a long session.

### The client records leave the file, and the search says what it cannot read

`src/clients-views.js` — 481 lines of section, plus the `FILES_PER_PAGE` ceiling that only the documents page ever read:
every document in one searchable list with its CSV, the client directory, and one client's own record. It is the tenth
module to leave `app.js`, which is **1,830 lines and 92 KB** against the 7,173 and 357 KB the audit measured — **74% of
both gone** — and the first of the four sections `docs/splitting.md` still had listed.

`FILES_PER_PAGE` was read nowhere but the documents page, so it left *with* the section instead of becoming a circular
import, and `readableSize` was private to it; nothing else had to be rehomed ahead of the move. That is the second move
in a row that needed no helper rehomed, which is what the recipe's step three predicted for the easy ones.

**The one mistake was mine, and it was the fourth version of the same mistake.** The six handlers were wired into the
route table before they were given `export`, so `app.js` failed at import time — *"does not provide an export named
clientsCsv"* — and one run of the suite found it. The three earlier failures were an import list disagreeing with the
code in the other direction; the lesson that keeps paying is that the suite is the only thing that checks the seam at
all. The unused-import scan then found twelve of the fifteen imports that had left with the code — `rename`, `sendCsv`,
`dateIn`, `monthIn` and eight store functions — and missed three that a comment's prose kept alive (`open`, `now` and
`history`), which is why the last three were settled with a grep for the call rather than the word. The scan is in
`docs/splitting.md` now, with the repairs it needed to run without lying.

392 tests, all green.

### The templates leave the file, and the export goes in before the wiring

`src/templates-views.js`, 394 lines: the templates pages and the lists they keep — make one, rename it, add to it, take
something off it, delete it, start a request from it — plus the page that closes several requests at once, which sits
here because it is the same shape of page. It is the eleventh module to leave `app.js`, which is **1,462 lines and
74 KB** against the 7,173 and 357 KB the audit measured — **four fifths of both gone**.

Nothing needed rehoming, for the third move in a row: the section's outside dependencies were `parseItems` and the
store functions behind the lists, and `http.js` was already `parseItems`'s home, exactly as `docs/splitting.md` had
predicted. Fifteen imports left with the code; the scan found fourteen of them, and `section` was the fifteenth —
invisible to it because `<section class="card">` and the word in a comment both look like a use, which is the same
reason `open`, `now` and `history` had to be settled by hand last time.

The mistake of the last move was not repeated: the ten handlers were given `export` before they were wired into the
route table, and nothing else went wrong, so the suite had nothing to catch — the first move in the series where the
checks only confirmed what the previous four had left behind.

392 tests, all green.

### The bulk ask leaves the file, and a note that had gone stale is made true

`src/bulk-ask-views.js`, 403 lines: the preview page that lists every client with whether they can be written to, the
run itself, the per-client opening it sends through the same `openingDraft` the single-request page uses, and the report
that says what happened. It is the twelfth module to leave `app.js`, which is **1,084 lines and 55 KB** against the
7,173 and 357 KB the audit measured — **85% of both gone**.

`CHASE_BUDGET_MS` came along as an import rather than a copy, exactly as `docs/splitting.md` said it should: the run is
bounded in time, not in count, and the ceiling is the chase's own because what it is really about is the response still
being writable. Nothing needed rehoming — the fourth move in a row — and sixteen imports left with the code, every one
of them found by the scan, with no prose hiding a name this time. The analysis's false positives were in the other
direction: `home` appeared as a *must import* and `join` as a `node:path` import, when the first was the word in a
comment and the second a `.join(', ')` call.

The stale note this move makes true is in `src/board-views.js`, which had said the templates, the client records, the
chase list and the bulk ask "remain in `app.js`". All four are modules now, so it says so, and `app.js` is one section
from being the route table it says it is.

392 tests, all green.

### The sign-in pages leave the file, and the split is finished

`src/signin-views.js`, 680 lines: home, the credential forms, sign-up, sign-in, the second factor and sign-out — every
way into the product and the one way out. `app.js` is **423 lines and 25 KB**: the imports, the route table,
`contextFor`, `asset` and `createApp`. From the 7,173 lines and 357 KB the audit measured, **94% of the lines and 93%
of the bytes are gone**, and the file the audit called the one real maintainability problem is the route table it says
it is.

The last move was the one that had to be last, and it went the way the recipe predicted: the analysis found nothing the
section needed from `app.js` — `createApp`, `contextFor` and `asset` sit directly above it and stay behind — so the
thirteenth module left in one cut. Forty-two imports stayed behind with the dispatcher; thirteen names went with the
pages, `signUpForm` and `signInForm` among them, because the route table hands those two forms straight to the browser
and they have to be exported rather than private. That is what the analysis's MUST EXPORT column is for, and it caught
them before a test had to.

The split is finished, and no fifth section was invented to keep it going. `docs/splitting.md` keeps the recipe, the
tool, and the thirteen modules with what left in each; what it no longer has is a list of what remains. The product is
the same — 392 tests say so — and the point of arriving back at a few hundred lines is that somebody can now find the
part of it they need: the board is one file, the chase another, the client's page a third, and `app.js` is the table
that puts them together.

392 tests, all green.

### The browser's half, executed rather than served

`web/tickmark-crypto.js` was always tested directly — Web Crypto is the same API in Node as in a page, so
`test/crypto.test.js` runs *the* implementation rather than a second one written to agree with it. **The glue around
it was not.** `upload.js` and `download.js` were asserted to be *served* on every page and were executed by nothing,
which is the difference between a claim and a check: a page can be served, be perfectly valid, and still encrypt
nothing.

`test/fake-dom.js` is a hand-written partial DOM — no dependency, for the same reason the SMTP client and the ZIP
reader are hand-written — and `test/browser.test.js` drives both pages through it:

- the client's page **encrypts before it sends**: the captured body is an envelope, the document does not survive in
  it, the name and the sealing key travel as headers, and what went out **opens with the passphrase and nothing
  else**;
- a file over the practice's limit is refused *before* it is encrypted, once on the picker and again on submit;
- the practice's page unwraps the key in the tab, fetches the envelope, and saves **the document rather than the
  ciphertext** — releasing the object URL a minute later, which is asserted rather than waited for;
- a wrong passphrase opens nothing and **fetches nothing**: a page that refuses instead of spending the practice's
  bandwidth on an envelope it will not read;
- and an envelope changed in storage is refused by the page whether the changed byte is in the ciphertext, in the
  header (the ephemeral key an attacker would want to substitute), or in the authentication tag.

What the shim does not implement throws rather than passing quietly, and its two limits are written down where they
bite: events do not bubble, and a cache-busting import shows up in the coverage report as one partially-covered file
per scenario.

### The documents check each other now

`README.md` advertised **four** things the encryption does not protect. `docs/encryption.md` lists **seven** — three
arrived over later phases, and the one sentence a buyer reads first kept the old count. Fixed, and then made
impossible to repeat: `tools/check-docs.mjs` counts the bullets in the document and compares them with the word in
the README, requires every file in `docs/` to be linked from the README, and requires the policy below to be
findable. It is a CI gate like the other checks, because a stale number here is not a typo — the whole claim is that
the limits are stated rather than discovered, so a count that understates them *is* the failure mode.

### SECURITY.md, and a way to report something

The gap a review of this repository found and the repository itself had not noticed: **there was no disclosure
process at all.** `SECURITY.md` now says how to report (GitHub's private advisories, with a fallback for a mirror
that has them switched off), what to expect (days rather than hours, and a written reason rather than a dismissal
when the answer is "that is a recorded limit"), what is **already known and accepted** with links to the two
documents that argue it, what is in scope — the browser-side key first, because moving decryption to the server is
the most serious finding this project can receive — and which versions are supported.

### A coverage number, with no threshold invented for it

`npm run coverage` wraps the suite in Node's own `--experimental-test-coverage`, and CI prints the table. There is
deliberately **no threshold**: a number below which this will not ship is a decision about what the project is
willing to accept, and inventing one to look rigorous would be exactly the kind of unearned claim the rest of this
repository avoids. The browser tests moved the figure from 95.08% to **94.08% of lines** while making the suite
strictly stronger — `upload.js` and `download.js` had never been loaded by a test, so previously unmeasured code is
now measured and partly covered. A coverage number that only ever goes up is one that is being managed rather than
read.

## 0.2.0 — 23 September 2026

The first tagged release. By the convention above it is the *second* number that moves: features
arrived and the schema changed (`invite` gained `revoked_at`). Everything since the untagged first
cut, newest first:

### The restore drill, and the door that closes behind

The restore `docs/operations.md` describes is now **drilled on every run**: `test/backup.test.js`
takes a backup while the server is running, deletes the original, performs the documented steps, and
decrypts a document out of the result — step 5 automated, the proof a checksum cannot give.
`--verify` is proved to have teeth (a copy missing its documents is refused), and backups are proved
never to be overwritten. And `find:unused` is a **gate** rather than a comment: 203 exports, none
unreferenced, and the four dead ones that sat there for a release are gone.

### The hardening pass

**A fresh full-codebase audit, and every finding in it addressed.** `docs/security.md` has the full list; the
shape of it is here:

- **Four security fixes with real exploit paths**: CSV exports no longer hand a spreadsheet a formula built from
  a filename a client chose; links inside emails say where the install actually lives (`TICKMARK_PUBLIC_URL`)
  instead of whatever `Host` the request claimed; sign-up on both doors is rate limited — it was the one
  unauthenticated endpoint that costs a scrypt hash per hit; and the two-factor actions a stolen session would
  aim at (turning it off, minting recovery codes) now have a guess budget like sign-in always did.
- **Three quiet bugs**: a malformed cookie header took every page down with a `URIError`; a removed member kept
  receiving the "your client sent something" emails; the tenancy fallback password record was a placeholder
  that verified against some short password. All fixed, all tested.
- **The account is now something a person manages**: change your password (costing the current one, and ending
  every other session — which is the point), change your address, and see where you are signed in with a button
  per session. **An invitation can be taken back before it is used**, which a link that hands over a copy of the
  practice's key always needed. **The owners are emailed when a key is added or the membership changes** — the
  one attack this product's threat model describes is silent in the interface, so silence was not an option.
  (The first key of a practice stays silent; the announcement is for the rotation-or-hijack moment.)
- **Three performance fixes**: uploads and downloads stream to and from disk rather than through memory, the
  client directory aggregates in two grouped joins rather than four subqueries per client, and expired sessions
  are swept at open. The documents list — the one list that grows forever — pages at a hundred with "Show more";
  the CSV still gives everything.
- **A Content-Security-Policy, at last** — the last thing `docs/security.md` admitted to. One nonce per
  response, minted and stamped where every page already passes through; no `unsafe-inline` anywhere; and
  the inline widths and click-handlers a strict policy refuses became classes and one nonced script.
  `check:pages` fails any rendered page that brings either back.
- **The reminder is a letter** — client-facing mail leaves as `multipart/alternative`: the exact words
  of the draft as plain text, and the same words rendered as a styled letter with the practice's name
  at the top and the link as a button. The plain part is byte-for-byte what the practice typed; the
  styled copy adds and removes nothing, so "what you see is what gets sent" survives the styling.
  The notes a practice sends itself stay plain.

**The schema changed**: `invite` gained `revoked_at` (added in place, and present in the rebuild path — see
`docs/operations.md`).

### Three more wastes

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

### The premium pass

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

### Navigation, and a hole in the second factor

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

### One word with two meanings, and the counts that came with it

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

### The audit

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

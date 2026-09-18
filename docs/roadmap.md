# The roadmap

This file exists because the plan in `docs/mvp.md` describes version one, and once version one shipped
there was nowhere that said what comes next and why. The phases are here, each with its status and the
reason it is in that order.

The rule underneath all of it: **shipped means a stranger gets value in five minutes, and you have
told them it exists.** A feature nobody can find, or that needs a tutorial, is not shipped.

## Where things stand

```
Phase 0   Verify the demand            NOT RUN — and it decides whether Phase 4 matters
Phase 1   Version one                  COMPLETE
Phase 2   Make it usable in the field
          2a email sending             COMPLETE
          2b several people per practice COMPLETE — A, B and C, invitation included
          2c re-encrypting old files      COMPLETE — and a key can now be retired
          2d other install paths          NOT PLANNED
          2e the states the trade asks for COMPLETE — see docs/product-needs.md
          2f chase everyone at once     COMPLETE — every item of Phases 1 and 2 is now built
Phase 3   Find out if anyone wants it  NOT STARTED — and it is Phase 0
Phase 4   Grow the surface             NOT PLANNED
```

## Phase 0 — Verify the demand

**Status: not run.** `docs/verify-demand.md` holds the questions and the decision table, written before
any code; `docs/demand-posts.md` holds the posts ready to send. Nothing in this repository can run it:
it needs a person asking practitioners, and the table says what their answers mean — including the
answer *"stop"*.

It sits at the top because the projects that failed in this author's history did not fail for want of
features. They stopped at the point where the interesting work was done.

## Phase 1 — Version one

**Status: complete.** Eight commits, and every item of the plan's seven either built or written down as
a named limit.

| | |
| --- | --- |
| Accounts, sessions, sign-out that revokes | done |
| A request: a client, a title, a due date, a list of documents | done |
| Adding to a request later, withdrawing an item, flagging one that needs re-sending | done |
| A link the client opens with no account, with an expiry and a revoke | done |
| Encrypted uploads the server cannot read | done |
| Opening what arrived, in the browser | done |
| The reminder draft, and closing a request | done |
| Rotating a key without losing the files it was protecting | done |
| `docker compose up`, verified by running it | done |

The named limits are in `docs/encryption.md` rather than repeated here: a weak passphrase, the
metadata, a lost passphrase, a compromised browser, the identity of the uploader, and the fact that a
new key cannot un-disclose anything already taken. Plus one engineering limit — old files cannot be
re-encrypted to a new key, so old keys stay.

## Phase 2 — Make it usable in the field

The plan's "what ships after version one" list, in the order it should happen.

### 2a. Email sending — the biggest cut

**Status: complete.** `src/mailer.js`, `docs/mail.md`, and the reminder page grew a Send button that
appears only when it can work.

Built as planned, and the plan was right about the shape:

- **Written by hand against `node:net` and `node:tls`.** No dependency: `nodemailer` would be the
  largest supply-chain surface in a project whose pitch is that the operator can read what they run.
- **A failure is never silent.** The practice keeps their text, sees the relay's own words, and the
  attempt is in the history as `reminder.failed`.
- **Deliverability is documented as the operator's problem**, with the relay answer spelled out in
  `docs/mail.md` rather than implied.
- **No queue and no retry**, deliberately: a reminder that failed is one a person can see and send by
  hand.

Three things the build found that the plan did not anticipate:

1. **Quitting without reading the reply truncates the final write.** The first version wrote `QUIT` and
   destroyed the socket, which is how a client loses its last byte — a relay logs that as an error, and
   the practice would be told a message failed that was delivered.
2. **SNI cannot be an IP address.** Node refuses one, so a relay addressed as `smtp://10.0.0.5` failed
   outright. The name is now sent only when the host really is a name.
3. **A reminder can be sent with no link in it.** The message is editable — it is the practice's
   message — so deleting the link leaves the client with nowhere to send anything. It is sent, and the
   page says so. That is the same rule as the rest of the product: their words, and the consequence
   stated rather than hidden.

Covered by tests: the conversation itself against a fake relay, both auth mechanisms, the refusal to
send a password to a server offering no encryption, timeouts, refusals naming the step, and the whole
path through the app. **The TLS handshake is now covered too** — see below.

### 2a-ii. The TLS gap, closed

The first version of this section said the TLS paths were not exercised, because generating a
certificate needed a tool this machine did not have. **It did have one**: Git for Windows ships
`openssl`, which was found by looking rather than by assuming. So the gap is closed, and it was worth
closing — this is the path every real relay uses, and a password travels over it.

`test/fixtures/tls/` holds a throwaway CA and two certificates signed by it, committed deliberately.
**The CA's private key was deleted after signing**, so no key in the repository can sign another
certificate and nothing here can impersonate anything. `test/mail-tls.test.js` uses them for six tests:
a message over `smtps://`, a **real STARTTLS upgrade** (the relay performs the handshake on the socket,
so the assertion is that the login and message arrived after it), an untrusted certificate refused, the
same during an upgrade with **nothing sent afterwards**, a wrong-name certificate refused, and the CA
file's handling.

Mutations proved those tests bite, each run alone and each restored. The last row is deliberately two
mutations at once, and the paragraph after explains why:

| Mutation | What failed |
| --- | --- |
| `rejectUnauthorized` forced to `false` | exactly the three verification tests, while the three happy paths still passed |
| the own-CA option dropped from both TLS paths | the three tests that rely on the test CA being trusted |
| the client never asks for STARTTLS | the upgrade test |
| **no STARTTLS and no refusal to send a password without it** | the upgrade test *and* the "nothing follows in the clear" test |

That fourth one is deliberately two mutations at once, and the reason is a finding in itself: the
plaintext-leak assertion passed under the third mutation because the behaviour is guarded **twice** —
by upgrading, and by refusing to send a password to a server that offers no encryption. Either guard
alone prevents the leak, so proving the test bites meant removing both.

One question was settled by measurement rather than reasoning: the mailer sends no SNI when the relay
is addressed by IP (Node refuses an IP as `servername`), which looks like it might skip the hostname
check. It does not — Node verifies the certificate against the address it dialled, proven with a
certificate naming a different host. Had that gone the other way it would have been a security hole,
and it would have been invisible without a certificate that *should* fail.

### 2a-iii. A finding in the test harness

`node --test` with no arguments executes **every `.js` file under a directory named `test`,
recursively**, and counts each one as a passing test. So `test/helpers.js` and `test/smtp-relay.js` were
being run as test files and counted as tests, and the suite reported **two more tests than exist**.

The fix is one word: `npm test` now names the test files (`node --test "test/*.test.js"`), which reports
the honest number. The reason it matters is not the count — it is that a shared helper with a top-level
side effect was being executed by the runner, and an import error in one would have appeared as a
failing "test" named after the file, which is exactly the kind of red a reader learns to ignore. The
note is in `test/helpers.js`, where someone adding a third shared module will see it.

Version one drafts the reminder and the practice copies it into whatever they send mail with. That is
the honest place to have started — it tests whether the client portal gets used without a mail server
in the way — but it is also the difference between a tool that tells you who to chase and a tool that
chases for you. For a practice with forty clients, this is the feature that decides whether the tool is
used in a second season.

What it has to get right, because every one of these was a flagged gap in the author's previous
project:

- **A failure is never silent.** A reminder that was not sent must say so, keep the draft so nothing
  typed is lost, and record the attempt. A notification that fails quietly is worse than no
  notification.
- **Deliverability is the operator's problem, and the documentation has to say so.** A self-hosted tool
  sending from a rented VPS with no SPF, no DKIM and no reputation will land in spam, and no amount of
  code fixes that. The honest guidance is a relay — the operator's existing provider — and a page that
  says what to configure.
- **No dependency.** An SMTP client is a few hundred lines against `node:net` and `node:tls`, and
  `nodemailer` would be the largest supply-chain surface in a project whose entire pitch is that the
  operator can read what they are running. The plan already committed to writing this by hand.

### 2b. More than one person per practice

**Stages A and B are done; C is not started.** `docs/members.md` holds the decision, and it came before
the code because the roadmap was right that it is a design question: the answer decides the shape of the
data, and the shape of the data is expensive to change later.

**The decision: one key pair for the practice, wrapped once per person.** Not a key per person — the
documents belong to the firm, a request has one recipient for the client to encrypt to, and a partner
leaving must not make four years of client records unopenable. The cost is stated there rather than
discovered: adding a member means giving them the private key, and removing one does not un-disclose
anything they already had.

**Stage A** put the tenancy in the schema: a `practice` row, a `practice_id` on every table that belongs
to a firm, and a migration backfilling each practitioner's work into a practice of their own.

**Stage B** switched the code over. Everything the store does is now scoped by **practice** rather than
by person: `requestFor`, `itemsOf`'s guards, the key history, the client-link lookup, the token checks.
`createClient`, `createRequest` and `addPracticeKey` take `practiceId` **and** `createdBy`, so the firm
owns the record and the person is recorded as provenance. Sign-up creates a practice and its first
member in one transaction. `contextFor` resolves the practice once, so no handler has to remember to ask.
And `sessionFor` now returns the practice beside the person.

**Behaviour is unchanged with one member, and that is the point** — every test written before this pass
still passes. The capability that is genuinely new needs two members to see, so it is asserted directly:
two people in one practice see the same client's records, which under the old shape was unrepresentable
because a person *was* the tenant.

Five things went wrong or were found while switching, and each is recorded because the pattern matters
more than the instance:

1. **A substitution-order mistake of mine.** I added `createdBy: practitioner.id` *before* the blanket
   rename from `practitioner.id` to `practiceId`, so the rename turned the creator into the practice —
   and the foreign key refused 53 tests at `/setup`. The rename had to come first. (This is the third
   time in this project that the *order* of two edits was the bug, after a batch writing one file twice.)
2. **The tests caught a half-finished removal.** Dropping `session.practice_id` left the backfill
   statement that updated it, and four tests failed with `no such column: practice_id` — which is what a
   half-removed thing looks like when something is still reading it.
3. **A dead join, removed.** `tokenLookup` joined `practitioner` and read nothing from it.
4. **A dead export, removed.** `endAllSessions` in `auth.js` was called from nowhere, and its comment
   claimed a passphrase change needed it, which is not true of a session created by password sign-in.
5. **A test that was not testing anything.** The "members are listed oldest first" assertion passed with
   the `ORDER BY` deleted, because SQLite returns rows in insertion order and I had inserted them in
   timestamp order. The fixture now creates them in the *opposite* order to their timestamps, and the
   mutation now fails the test with the sentence that names the ordering.

Two mutations proved the new tests bite. Scoping `requestFor` by the creator instead of the practice
fails 49 tests — and the reason is worth stating: a practice id and a person id are both random UUIDs,
so confusing them is **loud, never silent**. Removing `membersOf`'s ordering fails exactly the assertion
about ordering.

**Stage C is done.** A two-partner firm can now use this: one key for the practice, a sealed copy per
member, and an invitation that carries the key without the server ever seeing it.

**C-i: the key can move, and a practice holds one sealed copy per member.**

1. **The invitation crypto**, in `web/tickmark-crypto.js`. The practice's private key is sealed under a
   random 32-byte **secret** with HKDF and AES-GCM, and the secret travels in the part of a link a browser
   never sends to a server — the fragment. The functions work with PKCS#8 *bytes*, not a `CryptoKey`,
   deliberately: the passphrase-unwrapped key is imported as **not extractable**, and that is a property
   worth keeping, so one narrowly-named function hands out bytes for the one operation that has to move a
   key rather than making every unwrapped key exportable.
2. **`key_wrapping`**, one row per member per key. Before this, a key carried a single wrapped copy and a
   practice had a single login, so "whose passphrase" was not a question. It is now.

**C-ii: the pages.**

- **`/members`** — who is in the practice, whether each of them holds a copy of the newest key ("can open
  the newest files?" is a column, answered by looking rather than assuming), what has been invited and
  what became of it, and the invitation form.
- **`/members/invite`** — takes a blob the browser sealed, checks that it is a sealed blob *and* that the
  key it names is one the member holds a copy of, and returns a token. It answers with JSON rather than a
  redirect, because the secret has to stay in the page that generated it.
- **`/invite/<token>`** — public, gated by the token in the path and by the secret in the fragment. It
  names the practice, hands the browser the sealed blob, and stops there: the server cannot know whether
  the link is valid in the way that matters, and does not pretend to.
- **`web/members.js`** and **`web/invite.js`** — the two browser halves, which never send a passphrase.

Two things the pages say out loud rather than leaving to be discovered: **whoever opens the link gets the
key** (it is not addressed to a person, it works once, it expires), and **the accept page needs
JavaScript**, because the key is sealed in the browser. A submission arriving with the passphrase fields
filled is refused with that sentence, rather than creating a member whose key copy is empty.

**The test that proves the whole path**, in `test/invite-flow.test.js`: a practice with a key and a
document already uploaded; an invitation made from the members page; a newcomer who joins; and then —
**the newcomer fetches the file that arrived before they existed, through the ordinary file route, with
their own session, and opens it with their own passphrase.** It also asserts that the token does *not*
open the invitation (only the fragment does) and that the secret is nowhere in what the server sends.

Two mutations proved the new tests bite:

| Mutation | What failed |
| --- | --- |
| accepting an invitation gives the newcomer no copy of the key | *"each with their own copy"*, and *"that is not a Tickmark key record"* |
| the members page accepts any key id | the refusal test, and the database's own foreign key |

That second one is worth a note: the check is guarded **twice** — by the handler and by the foreign key —
so the mutation had to break the handler to see the database refuse it. The same pattern as the mail
client's plaintext guards, and the same conclusion: defence in depth is good, and it means a single
mutation does not always tell you whether a test bites.

**What is deliberately still missing:** removing a member. It is easy to half-build and dangerous to get
wrong — the honest version needs the "no wrapped copy of the newest key" state to be visible and acted
on, and it needs a decision about what happens to the sealed copies of a person who leaves. The state is
visible today (the members page has the column); the act is not built, and `docs/members.md` records why.

**The practice can be renamed** (`POST /members/name`), because until that existed every practice was
called `My practice` — a label nobody chose, on the page a new member sees first. Anyone in the practice
may do it, and that is the honest consequence of having no roles: inventing a hidden owner-only rule would
be a permission system with one rule in it. One test asserts the new name reaches the *invitation* page,
because that is where it matters most.

### 2c. Re-encrypting old files, so a key can be deleted

**Status: complete.**

The reason there is no delete button is that an old key exists to open the files that were sent while it
was current, and a file cannot be moved to a new key without the old one. The first thing that needed to
exist was therefore not a move but a *count*: before this pass, nothing in the system knew which key had
sealed which file, so "can we throw this key away?" had no answer at all — the only policy was to keep
every key forever and hope.

**Done, and measured rather than asserted:**

- **An upload records the key it was sealed to.** Nothing about an envelope's bytes says so — its header
  carries the *ephemeral* key, not the recipient — so the browser that encrypts says which practice key it
  used, in a header, and the server **checks** the claim against the practice before recording it. A key
  belonging to a different practice is a refusal with nothing written, because this column is what decides
  whether a key can ever be discarded, and a wrong answer is worse than none.
- **An upload that names no key still arrives, and is counted as *not known*.** That is not a
  hypothetical: a client can be holding a page from before this existed, and refusing their file to record
  a number would lose a document. `null` is "not known" and it is deliberately a different thing from
  zero — treating it as zero would say a key holds nothing, and a practice that believed that would throw
  away the key that opens the file.
- **The keys page counts them.** Each key shows how many files it holds, and any file whose key is not
  recorded is called out in a sentence rather than folded into whichever key happens to be current.

**The move, and what makes it safe to run.** The pass lives in the browser, because the private key only ever
exists there: `GET /keys/<id>/pending` lists what is still sealed to a key, the page fetches each file,
opens it with the old key, seals it to the current one, and posts the result to
`POST /files/<id>/reencrypt`. The server checks the bytes are an envelope, checks the named key belongs to
this practice and is live, writes them to a **path of their own**, moves the row in a transaction, and only
then unlinks the old file. That order is the whole design: a crash between the write and the row update
leaves an unreferenced file and a perfectly good document, which is the safe direction to be wrong in.

**Resumption needs no mechanism.** A file that has been moved is no longer sealed to the old key, so it stops
appearing in the pending list — the count on the keys page *is* the progress. Closing the tab halfway
through loses nothing, and pressing the button again carries on from wherever the data got to. No progress
table, no cursor to fall out of step with the files.

**The round trip is checked, and that check needs two keys.** Before anything is replaced, the new envelope
is opened again and compared with the original plaintext. That requires the *current* key's private half as
well as the old one, which is not what the first version of this did — it opened a new-key envelope with an
old-key private key, so the check failed on every file and the pass could never have completed. The form now
takes the current key's passphrase as a second field, needed only when it differs, and the test that caught
this was written before the feature was ever run.

**Retiring a key destroys its copies and keeps the record.** Not a row deletion: `key_wrapping` rows go,
which is what makes the key open nothing, and the row stays with a `deleted_at` date. A key that vanished
would take with it the only evidence of what it opened, and this project's rule is that a record does not
lose a row. Three refusals: the current key (new files are sealed to it), a key that still holds files (that
is what the move is for), and a key already retired (so the date means something).

**The sentence the page has to say**, because it reaches further than the server: retiring a key cannot be
undone, and *any copy of an unmoved file held or backed up elsewhere* becomes unopenable, because the key
that opened it no longer exists. Hence the word has to be typed rather than a button pressed.

### The install path, and how it is checked

**`node tools/check-container.mjs`** drives a running container through the whole loop over HTTP: a
practice, its key, two encrypted uploads, a rotation, the move of every stored file onto the new key, and
the retirement of the old one — then, after `docker compose restart`, signs back in and opens those files
through the volume that survived.

It exists because **`npm test` cannot check the install path.** The suite runs on the host, where `web/` is
on disk, so it can say nothing about whether the image contains it — and the image once built successfully
and then crash-looped on `ERR_MODULE_NOT_FOUND` for exactly that reason, while `docker build` reported
success. That failure mode is now checked two ways: the tool asks the container for `/assets/reencrypt.js`
and confirms it is the real file, and pointing the tool at a deliberately broken image **exits 1** rather
than reporting a pass. Both were verified by doing it.

It uses the same crypto module the container serves, because that is the one a browser runs. It is not part
of `npm test` because it needs Docker and a running container — the same treatment the browser tests get on
a machine with no browser.

### 2d. Packaging beyond Docker

**Status: not started, and probably never.** A Helm chart, a Debian package, a hosted one-click. Each is
a promise to maintain an installation path, and none of them is why a practice would choose this.

### 2e. The states the trade actually asks for

**Status: complete.** `docs/product-needs.md` is the research this came from, with the sources.

The finding was that the problem a practice has is not collecting documents — every portal does that —
but knowing **whose turn it is**. Received is not ready, and a client who cannot produce a document
currently has only two options: send something, or go quiet. This phase is five changes, all of them
about the list being honest:

- **A check per item.** `request_item.reviewed_at`. Somebody has actually looked at what arrived.
- **A state per request** — `ready`, `to-check`, `waiting` — derived from the items on every read rather
  than stored, so it cannot drift away from the thing it describes.
- **The board.** The requests list is sorted by whose move it is, marks overdue dates, counts each
  state, and filters by it.
- **Roll-forward.** `?from=<request id>` fills the new-request form from an old one, which is the
  smallest honest version of the year-two problem the research names as a top pain.
- **The client can say why.** "I do not have this", "I will send this later" — stored beside the item,
  shown to the practice, and repeated in the reminder so nobody chases something already explained.

Two things were deliberately left, and named in `docs/product-needs.md` rather than half-built: **bulk
send** (it writes N emails, and it needs a confirmation screen listing exactly who is about to be
written to), and **recurring requests** (which depend on bulk send existing).

### 2f. Chase everyone at once

**Status: complete.**

The research is blunt about why this is not optional: **"manual tracking breaks down past fifty
clients"**, and chasing is where a practice's week goes — nine to twelve hours a week of follow-up, in a
season that lasts twelve to fourteen weeks. A board that names who to chase and makes you chase them one
at a time has diagnosed the problem without solving it.

`GET /chase` is the list, `POST /chase` is the run. What makes it safe to press is the order:

1. **A page listing exactly who will be written to** — with their addresses, what each one owes, and when
   each was last reminded — before anything leaves the server. "Are you sure?" on its own would be a worse
   page: it asks for confidence without giving information.
2. **The run bounds its own time**, at `CHASE_BUDGET_MS` (two minutes), because Node's `requestTimeout` is
   five minutes and a run cut off by the server would leave no record of which clients had already been
   written to. A count would be the wrong bound — a fast relay and a slow one deserve different answers.
3. **A failure never stops the run and is never hidden.** One dead mailbox must not prevent the other
   thirty, and the report names each outcome: sent with its identifier, failed with the server's own
   words, not attempted, or no address at all.
4. **Every send is recorded per request**, in the same events the single-send path writes, so a client's
   history says what was sent to them and when, whichever way it was sent.

Two things are deliberately not here, and both are named in `docs/product-needs.md`: **recurring
requests**, and **a cadence the run respects** — the run has no memory of who it has already written to,
and presses twice will send twice. The chase list shows when each client was last reminded so the
decision is the practice's, but the threshold itself is a decision and not a default I should invent.

The one thing to watch when reading the code: the message a reminder contains is built by **one**
function, `messageFor`, used by both the single-request page and the run. Two implementations of "what
does a reminder say" would be two things free to disagree, and the place the disagreement would show up
is a client's inbox.

## Phase 3 — Find out if anyone wants it

**Status: not started, and it is Phase 0.** Running the demand check, and then the first session
`docs/first-user.md` describes in spirit: a practitioner with a document that matters, watched without
help.

This is the phase that decides whether Phase 4 is worth anything. It cannot be done by an agent, and it
is the only item on this list whose absence is not a gap in the software.

## Phase 4 — Grow the surface

**Status: not planned, deliberately.** Candidates, in the order they would be worth considering, and
none of them before Phase 3 says so:

- **Integration with the tax software practices already run** (Lacerte, ProSeries, Drake, UltraTax).
  The incumbents charge for this and it is how they win firms — but it is also the moment this stops
  being a small self-hosted thing.
- **SMS reminders**, which is what some clients actually read.
- **A client portal without a link**, so a client can log in and see everything they owe.
- **Per-practice branding** on the client's page.

## What is not on this list, and will not be

Written down so that it does not get suggested in six months as though it were new:

- **Merges or sync.** One practice, one server. Two people editing the same document is a different
  product.
- **A hosted "verify this online" service.** Everything runs on the operator's hardware; the only page
  that leaves the machine is the client's link.
- **A mobile app.** Responsive pages, and nothing else.
- **Anything with an LLM in it** whose operation would mean sending a client's financial documents
  somewhere else. That was the one exception in the previous project's audit, and it is the single
  thing that would make this product's central claim false.
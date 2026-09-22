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
          2f chase everyone at once     COMPLETE
          2g removing a member          COMPLETE
          2h a chase cadence            COMPLETE
          2i clients as records         COMPLETE — see docs/clients.md
          2j a design system            COMPLETE — see docs/design.md
          2k the SaaS wrapper           BUILT, UNPROVEN — see docs/saas.md
          2l finding things             COMPLETE — search, orders, CSV export
          2m the client's receipt       COMPLETE
          2n editing, and asking        COMPLETE — a request can change, and be emailed
          2o identity, and being guessed at COMPLETE — signed letters, a named portal, and a cap on sign-in
          2p the last four gaps       COMPLETE — relabelling, bulk close, the practice's calendar, password reset
          2q/2r a list you keep       COMPLETE — templates, and asking every client at once
          2s being told what arrived  COMPLETE — the practice hears when a client does their part
          2t an answer is a state   COMPLETE — the client replied, so the request needs the practice
          2u the year coming round  COMPLETE — who is due an ask, and the seasonal bulk ask that follows
          2v the contact that was not an email  COMPLETE — a call in the record, and the cadence counts it
          2w the review loop         COMPLETE — one press to check off what arrived, and a "ready" that no longer lies
Phase 3   Find out if anyone wants it  NOT STARTED — and it is Phase 0
Phase 4   Grow the surface             NOT PLANNED
```

**Everything in version one and every phase of Phase 2 is now built.** What is left is not a feature
list: it is 2k, which has never been driven against a real Stripe account, and Phase 3, which is the
same question Phase 0 asked and which still has no answer.

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

**Removing a member** — the last named gap, and it shipped in 2g below. It was held back because the
honest version needed the "no wrapped copy of the newest key" state to be visible *and* a page that says
what removal cannot do. `docs/members.md` records the decision and the three things about it a reader
would not guess.

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
  than stored, so it cannot drift away from the thing it describes. (A fourth, `answered`, was added in 2t
  when it turned out that the state list could not tell a client's reply from a client's silence.)
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

One thing is deliberately not here, and it is named in `docs/product-needs.md`: **recurring requests** on a
schedule, which needs a decision about what happens when the schedule fires while the previous request is
still open. **A cadence the run respects** was the second thing on that list, and 2h below is where it
went.

The one thing to watch when reading the code: the message a reminder contains is built by **one**
function, `messageFor`, used by both the single-request page and the run. Two implementations of "what
does a reminder say" would be two things free to disagree, and the place the disagreement would show up
is a client's inbox.

### 2g. Removing a member

**Status: complete.** The last named gap, and the one `docs/members.md` had held back for three passes
because a button that looked like revocation of the past would have been worse than no button.

Two routes — `GET /members/<id>/remove` asks, `POST` acts — and the page that asks is the feature rather
than the plumbing. It states three things before anything happens: what will be destroyed (their copies
of the keys, counted; their sessions, counted), **what it cannot do** (a key they kept still opens under
their passphrase, and a document they downloaded is theirs), and the one that is easy to miss: if they
are the last person holding a copy of the newest key, removing them leaves nobody able to open those
files.

Three details worth their own sentences:

- **The row is not deleted.** Every client, request, upload and key records which practitioner made it, so
  a deletion would leave the history pointing at nobody. The members page therefore shows current members
  and a **Removed** list with dates.
- **An invitation is the way back in**, and it had to be: `practitioner.email` is `UNIQUE`, so without
  that path somebody who left could never be invited again. `claimInvite` restores the existing row — new
  password, fresh copy of the key, removal cleared, **same practitioner id** — so history keeps pointing
  at the same person. Their old sessions do not come back.
- **Two rules overlap, and one is unreachable from a browser.** Self-removal is refused, and the store
  also refuses removing the last member; the last member is always the person asking, so the first rule
  always fires first. The store's rule is kept as the invariant that no practice ends up with nobody in
  it, and `test/removal.test.js` says where each is exercised.

**Five mutations were run against it**, each alone, each restored and verified in one process: dropping
the `key_wrapping` deletion, dropping `endAllSessions`, dropping the removed-account check at sign-in,
moving that check *before* the password check, and refusing every existing email in `claimInvite`. Each
produced exactly its own failure. One of them was instructive: **deleting the sessions did not fail the
"open session stops working" assertion**, because `sessionFor` refuses a removed member independently —
defence in depth, and the same conclusion as 2b's key-id guard, which is that a single mutation does not
always tell you whether a test bites.

**And one environment finding, from the declared floor.** The migration test originally simulated an old
database by dropping the column, which works on Node 26's SQLite 3.53.3 and **fails on Node 24's 3.49.1**
with `error in table practitioner after drop column: incomplete input` — the column's comment lives
inside the stored schema text, and rewriting that text trips older SQLite. Node 24 is the declared floor,
so the test now writes the old table by hand, which is both portable and more faithful. The failure was
also wearing a disguise: the throw skipped `close()`, the handle stayed open, and the `EPERM` from the
cleanup was reported instead of the real error. **A `finally` that can fail can hide the exception it is
cleaning up after**, which is worth knowing anywhere a test closes a handle and deletes a directory.

### 2h. A chase cadence the practice sets

**Status: complete.** The last item `docs/product-needs.md` named as not built, and the one where the
design decision *is* the feature.

The problem it solves is small and specific: the run has no memory of who it already wrote to, so pressing
the button twice in an afternoon writes to everybody twice. A practice would stop trusting the button over
that. The fix is a threshold — and **a threshold is a decision about a firm's own clients**, which is why
Tickmark does not ship one. The setting starts at **0, "no limit"**, and a practice chooses its own number.

That decision is what makes the feature honest, so the page says it out loud: *"How often it is acceptable
to chase a client is your judgement about your clients, not a number this should pick for you — which is why
there is no default."* Even a cadence of 1 day fixes the accident that matters, because a client reminded
five minutes ago is inside it.

**Four things had to be true, and each is a failure the feature would otherwise have:**

1. **The number is the practice's, stored per practice** (`practice.cadence_days`), validated as a whole
   number between 0 and 365 — with 366 refused, because a cadence longer than a season silences the button
   for a season, which is not what the setting is for.
2. **Clients held back are named, never dropped.** The report counts them in its summary and lists each one
   with the reason and how long ago they were reminded. A run that quietly skipped people would be
   indistinguishable from a run that wrote to them, which is the one thing a report must never be.
3. **The page and the run cannot disagree about who is in scope**, because both read one function,
   `chaseSplits`. A banner saying "this sends 4" over a run that sends 2 is the same class of lie as any
   other overstatement.
4. **The single-request reminder is never held back.** On one request's page you are looking at that
   client, and the words are on the screen in front of you; the cadence exists for the button that writes
   to everybody without anybody reading each message. The page says this in as many words rather than
   leaving it to be discovered by the person who wants to send one.

**The ordering inside the split is a decision too:** no address beats the cadence, because a client with no
address could not be written to whatever the cadence says, and reporting them as "held back by your cadence"
would name the wrong problem. There is a test whose whole job is that the two reasons do not get swapped.

**Five mutations were run against it**, each alone, each restored and verified in one process. Four are
worth naming:

- `return days < cadenceDays` → `return false` (cadence disabled): **4 fail**, each exactly the assertion
  about holding back.
- The report's table guard reverted to `results + skipped` without `held`: **fails** *"and the table names
  them"* — which is precisely the bug the tests found while this was being written, so the fix is now
  permanently guarded rather than merely made.
- `withoutAddress` set to empty: **fails** *"the client with no address is named"*.
- The validation removed: **fails** *"\"-1\" is refused"*.

The fifth mutation was a mistake worth recording: the first thing tried was `if (false) return false;`
inserted at the top of `heldBackBy` — which is a **no-op**, because it never fires, and the suite went
green. A mutation that does not change behaviour proves nothing, and a green result from one is not
evidence that a test bites. It was caught by asking what the mutation actually did rather than by the
suite.

## Phase 2i — Clients as records

`docs/clients.md` carries the decision and the bug it fixed. The short version:

Requests have always pointed at a `client` row rather than carrying a copy of a name and an address — the
schema was right from the beginning. What was missing was every way of seeing or fixing one, and that gap
had teeth:

- **An address typed on a later request was discarded.** `findOrCreateClient` returned early when the name
  matched, so a client created before anyone knew their email could never be given one. Since the chase
  reads the client's address, the symptom was "Tickmark will not write to this client" with nothing on
  screen to explain it, and no way to repair it.
- **A typo forked a client silently.** Nothing on the request form said which names already existed, so
  `Northwind` and `Northwind Ltd` became two records — and the second one started with no history.
- **There was no way to reach a client** except through one of their requests, so "who do I work for, and
  who is late?" was a board read sideways.

Three screens and one rule: a `/clients` directory with what each client owes, a client's own page with
their history and their details (editable, so a typo is repairable and the whole history moves with it),
and a client carried into a new request by `?for=<id>` rather than re-matched by name. The rule is that
matching a name updates the address and never creates a second row.

**What it deliberately does not do:** merge two clients. Merging decides which history survives, which is
not a thing to do because a form was filled in twice — so the second name is refused and the practice
chooses.

## Phase 2j — A design system

`docs/design.md` carries this one. A hand-written stylesheet in `src/style.js`, split from `src/views.js`
so that what a page says and how it looks are separate files: tokens, element styles, then components.
No framework, no build step, no icon set, and light and dark from one set of custom properties.

The interesting part is what the tests forced. Every page's copy is asserted somewhere, from
`chase everyone outstanding` to a disabled button's exact markup, and those assertions are the product's
promises rather than incidental strings. So the styling was built *around* them: the primary-button rule
is `form.card > button[type=submit]` precisely so a button whose markup a test pins can still look right
without a class. Two assertions were updated, both because the markup they named was genuinely wrong, and
one of those was a heading this pass had reworded — which is the suite having opinions about copy.

## Phase 2k — The SaaS wrapper

`docs/saas.md` carries the whole plan, and the status is `BUILT, UNPROVEN`: the gateway, the registry, the
Stripe checkout and webhook, the billing wall and the tenant resolver all exist and are tested against a
real registry, real tenant files and correctly-signed webhooks — but no real Stripe account has ever been
driven end to end, and the doc lists the seven things that would bite before charging a customer.

## Phase 2l — Finding things, and getting them out

Three things, and the thread between them is what happens at scale rather than on the first day. A
practice with three clients can read a board top to bottom. A practice with two hundred cannot, and the
failure is not that the page is slow — it is that the practice stops looking and works from memory instead.

- **Search on the board and in the client directory.** A substring match over client, request title and
  address, composed with the tab and the state filter that are already on screen: a search made inside the
  closed tab stays inside it, and every link on the page carries the rest of the filters forward, because a
  URL assembled by hand at each call site is how one filter quietly goes missing.
- **Three orders**, chosen by the question the season is asking — whose turn it is (the default, files to
  check first), due date, or client name. Undated requests sort *last*: "no date" must not read as "due
  now", which sorting them first would say.
- **CSV export** of both lists, honouring the filters it was downloaded from and the order on screen. The
  file carries a byte-order mark so Excel reads an accented client name correctly — the one program the
  export exists to serve — and quotes and escapes a cell containing a comma or a quote.

### What building it found

**A bug the search exposed, not a missing feature.** The closed tab listed *open* requests. `requestsFor`
took `includeClosed: true`, which returned everything, and the closed tab passed exactly that — so the tab
said "closed" over a list that was not, and nothing had ever noticed because every request in every test's
fixture was open. A search inside that tab matched a client whose request was still open, which is how it
surfaced. The option is now one of three words — `open`, `closed`, `all` — because a boolean could not say
what the closed tab meant.

**Two of my own mistakes, both in the harness rather than the product.** An assertion expected the CSV's
first row to be a request the database put second: the export was right and the test was wrong. And a
page-scraping helper collected each item id *twice* — every item has two forms pointing at it, the upload
and the "says" one — so a test that meant to withdraw a second item withdrew the first one, the one it had
just uploaded to. Both fixes are comments in the tests now, because the next person to scrape that page
will make the same assumption.

## Phase 2m — The client's receipt

The client's page has always said what had arrived, item by item. It never let them *check*. "Did you get
it?" is a phone call to a practice that then has to look it up, and the person best placed to answer it is
holding the link.

So the page now says **"You have sent 2 of 3 documents"**, and against each item, the name of the file they
sent and the day it arrived. They chose those filenames, so showing them back is their own message
returning rather than a disclosure. When everything has arrived the count is replaced by a thank-you, and
the asking stops — the last thing a client should see on a page they have finished with is a list of things
they owe.

What it deliberately does not show is anything the practice has since stopped asking for: the client's page
is the *current ask*, and the history is the practice's page. Withdraw an item and its receipt line goes
with it, which is why a test pins exactly that.

## Phase 2n — Editing a request, and asking for it

Two gaps in the *core loop* rather than new surface, and both were the kind a practice hits in week one and
concludes "not ready" from.

**A request could not be edited.** A title and a due date were set at creation and never again — and deadlines
are the most changeable fact in an accountant's week. The only fix was to close the request and start again,
which throws away the link the client already holds and the record of what they already sent. There is now an
edit page: title, due date (clearable — that is how "no deadline" is said), the note to the client, and the
client itself, because "this was filed against the wrong client" is a correction rather than a new request.
Moving a request moves it: the checklist goes with it and nothing is copied.

An edit that changes nothing writes **no event**: a form submitted twice is not history. An edit that changes
something records what changed in words — `title → 2025 return — amended, due → 2026-04-30` — because an event
saying "edited" without saying what would be the least useful row in the record.

**The first ask was still manual.** The practice could make a link and the server could send mail, so the only
way to *ask* was to copy a link out of one page and paste it into another program. That is the step where a
practice decides the tool is a spreadsheet with extra steps. `Email this request` drafts the opening letter —
the practice's own note to the client quoted at the top, the checklist, a fresh link — puts it in the same
editable textarea a reminder uses, and sends it. It is recorded as `request.sent`, not as a reminder, because
"we asked on the 3rd" and "we chased them on the 20th" are different sentences and the record should say which
happened.

**A bug the tests found on the way:** the ask page's browser-tab title still said *"A reminder for Northwind
Ltd"*, because the page's `<title>` was the one part of the shared reminder layout that had not been made
aware of which flow it was serving.

## Phase 2o — Who is asking, and being guessed at

Two things that only become visible when somebody other than the author reads the product.

**The practice had no identity on anything a client receives.** Every letter it sends asks a stranger for their
financial records, and every one ended `Thanks,` and nothing else — unsigned — while the portal the client was
sent to said "Tickmark" and never said which firm wanted the documents. That is what a phishing email looks
like, and it was the default. The letters now end with the practice's own name, the portal names the firm above
the list and in the browser tab, and both take the name **as it is at the time of sending**, so a practice that
renames itself does not go on signing letters with the name it had at signup. It is a draft, so a practice that
signs its letters differently can change it — the point is that the default is not anonymous.

**Nothing was watching `/signin`.** It is the one endpoint a stranger can reach without a link, a token or an
invitation. `src/ratelimit.js` is a small in-process limiter with an injected clock, wired into sign-in:
failures are counted per account, expire on their own, and a correct password wipes the count.

The design decision is the **bucket**, and it is the opposite of the obvious one. Bucketing by IP address
would let one attacker guess at many accounts, and — behind the documented reverse-proxy deployment, where
every request arrives from the proxy — would let one attacker lock the entire practice out of its own software
by failing ten times. A guessed password threatens one account, so one account is what is limited, and a
colleague signing in from the same office is never affected. The limiter is a separate module with no
knowledge of HTTP, so a hosted deployment can swap it for a shared store without touching a route.

## Phase 2p — The last four gaps a practice would find

Four things, two of which were missing operations rather than missing features.

**A document's wording can be corrected.** A typo in a checklist line could only be fixed by withdrawing the
document and asking for it again, which marks it as something the practice *stopped* wanting and re-adds it as
a new item — two entries in the record for a spelling mistake. It is now a rename behind a disclosure in the
item's own row: the same id, one event saying what it was and what it became, and nothing the client has
already sent is disturbed.

**A season can be closed in one go.** Closing was the last one-at-a-time operation in the year's cycle, which
is exactly when there are forty of them. `/requests/close` lists everything open, **ticks the ones with
nothing outstanding** — finished by the product's own definition — and lists the rest unticked with what is
still missing. The software suggests; the practice decides, because "close the year" is not the same as
"abandon what is outstanding". Each closure goes through the single-request path, so a request records its own
event and the bulk route cannot drift from the individual one.

**Dates are read on the practice's calendar.** Everything stored is UTC and stays UTC, but the one piece of
arithmetic the product does about time — *is this overdue* — was answered in UTC, which says "overdue" a day
early in Auckland and a day late in Honolulu, for part of every day. `practice.timezone` holds an IANA zone
(chosen from a list, refused if the runtime does not know it, falling back to UTC rather than breaking a page),
and `src/clock.js` reads dates through `Intl` — a zone rather than a stored offset, because an offset is wrong
twice a year in exactly the weeks an accountant is busy.

**A lost password is replaced from the command line.** `tools/reset-password.mjs --email … ` sets a new one,
generating a strong password if none is given, and **ends every session for that account** — a live session
does not care what the password is, so leaving one alive would make the change pointless. It is a tool rather
than a page on purpose: an emailed reset link assumes a mail server is configured, and the moment somebody
needs to get back into their own software is a poor time to discover that it is not. Whoever can run the
command can already read the database, so it grants them nothing they did not have — it just saves them
writing SQL against a scrypt hash. And it says what it cannot do: the passphrase that unwraps the encryption
key is untouched and unrecoverable, because that is the design.

`MIN_PASSWORD` moved from the routing into `src/auth.js` on the way, because two things now have to agree on
it — the sign-up form and the tool — and a policy enforced in one place and assumed in another is a policy
that drifts.

## Phase 2q/2r — The year-start workflow: a list you keep, and asking everyone at once

The research is blunt about where a practice breaks: **manual tracking breaks down past 50 clients**, and a
season's document-gathering is 150–175 hours of following up. Every other part of the year can now be done in
bulk — chase everyone, filter the board, export the season, close forty requests at once — except the one that
starts it. Sending the same standard request to sixty clients, one at a time, is an afternoon of typing, and a
firm that would rather not spend that afternoon is a firm that quietly narrows what it asks for.

**A template is a saved checklist.** Named, edited, used for one client (`/requests/new?template=…`) or for
everyone (`/ask-everyone`). Two decisions worth recording:

- **It is the one thing in the product that can be deleted outright.** Everything else keeps a row forever
  because something points at it and something happened; a template is a *starting point*, and a request copies
  its documents at the moment it is made. Deleting a draft nobody needs is housekeeping, not the loss of a
  record — and `docs/mvp.md` says so where it counts the tables.
- **A request can be saved as a template, which is how the first one appears.** A practice that has just built a
  good checklist by hand has no reason to retype it in another page, and a template that has to be retyped is a
  template nobody makes.

**Asking everyone at once** is the feature the incumbents sell by that name. One list, one title, one deadline,
and a request per client with **its own link** — because a link belongs to a request, and a shared link would
mean one client's uploads landing in another's file. Three rules, and they are the chase's three, because a
second set of rules for the same job is a second chance to get it wrong:

1. **The page is the preview.** Every client is listed with whether they can be written to and why not, so
   nothing happens that the practice did not see first. That is why there is no "are you sure?" step.
2. **A failure never stops the run and is never hidden.** One dead mailbox among fifty must not stop the other
   forty-nine, and the report gives the relay's own words for the one that failed.
3. **Creation and sending are separated.** Making sixty requests is a fast database operation; sending sixty
   emails is sixty round-trips, any of which can hang. Every request exists *before* the first email is
   attempted — each with its link already issued — so what the run did not reach is unsent **and finishable**
   rather than lost, sendable from its own page by hand.

The report counts who was **asked**, not who was reached: a heading of "1 client asked" beside two requests and
one bounced email would be false, and this is the page a practice looks at to decide whether to trust the
button. Clients with no email address are listed on the page *before* anything is sent and named on the report
afterwards — an "ask everyone" that quietly skips the people it cannot reach is exactly the omission this
feature exists to prevent.

## Phase 2s — Telling the practice when a client does their part

Every email this product sent was one the practice pressed a button to send. The loop had a missing half: a
practice with sixty clients cannot poll a board, so a document arriving was something the *software* knew and
its owner did not — and the research's whole argument is that the practice's problem is not knowing where each
client is. *"A job should flip to ready when the document set is complete, not when files arrive"* is a
sentence about the person doing the work being told.

**Four decisions, and the restraint in each is the feature.**

**1. The client is answered first, and the notification happens after.** This is the load-bearing rule. The file
is stored and the response sent before any mail is attempted, so a relay that is down, slow, or refusing the
practice's own address can never fail a client's upload, never delay it, and never turn it into an error that
looks like their fault. A test drives a relay that says `550` to every recipient and asserts the client still
gets a `201`, the file is still stored, and the failure is recorded as an event rather than swallowed.

**2. It will not be noisy, because a noisy notification gets filtered and then the practice is blind again.**
One message per request per day, counted on the practice's own calendar — the timezone from 2p, doing a second
job. A client sending six files gets one message, not six. The message that goes out on the first file of a
sitting says *"that is where it stood when this was sent — the request itself shows the current position"*,
because a snapshot that pretends to be a running total is worse than no snapshot at all.

**3. The subject says something that stays true.** *"Northwind Ltd has sent something for 2025 return"* rather
than *"sent 1 of 3"*: a subject is the part people read in a list a week later, and arithmetic that has moved on
is a lie with a short shelf life. When the set is complete the subject says so outright — *"Everything has
arrived for …"* — because that fact does not go stale.

**4. It never claims more than it knows.** A request where everything has arrived but one document has been
flagged reads *"3 of 3 documents… 1 document has been sent but flagged as needing sending again"*, with the
practice's own reason repeated. "We have all of it" and "we have all of it and one of them is the wrong year"
are different mornings.

**What is deliberately absent:** the filenames. The labels are named, the files are not. Filenames are metadata
the server can see and the practice can see, but an email is a copy that leaves the building — quoted,
forwarded, sync'd to a phone in plaintext — and the practice is one click from the real names. The narrower
choice is the right one, and it is stated on the page where the setting lives.

**The setting defaults to on**, which is the one place in the schema where a nullable column does not read as
"the behaviour before it existed". The reasoning is on `notify_on_upload` in `src/db.js`: a practice that
configured a mail server in order to write to clients wants to be told when work arrives, and a product that
knows something and says nothing is worse than one that does not know. The column records the *decision to
stop*, one checkbox, on the page where the practice's name and timezone already live.

## Phase 2t — A client's answer is something that happened

Everything a client could do *except* send a file was invisible at the request level. An item the client had
explained they could not supply counted as outstanding, so the request read **"waiting on the client"** —
character for character what a client who had said nothing at all looked like. The item-level record had kept
the distinction since version one (`client_says` is its own column, and the schema says why: *"silence and a
stated reason are different things in the list"*). The list had not.

The damage was not cosmetic. The chase writes to every request with something outstanding, so a practice could
be pointed at a client who had already explained themselves — and the product's own reminder wording calls
chasing somebody about a document they cannot produce *"the fastest way to make a client stop answering"*. The
information was in the database the whole time; it was not on the screen where the decision is made.

**A fourth state: `answered`.** "Ready to work on", "files to check" and "waiting on the client" describe whose
turn it is, and this one is the missing fourth answer to that question — the client has replied and the practice
owes them a decision. It sits between the two: material nobody has looked at comes first, because that is the
work; then a client's answer, because somebody has to decide something and the client is the one waiting; then
simply waiting. It has its own colour, its own count on the board (`with an answer to read`, a link to
`/requests?state=answered`), and its own sentence on the request page instead of "waiting on the client".

**And the practice is told.** The notice from 2s now fires on either trigger — a file arriving or a client
answering — under the same once-per-request-per-day rule, because the rule is about the practice's attention and
a client who sends a file *and* answers a question has told them two things without needing two emails. The
client's words are quoted rather than summarised: "I do not have this" and "I will send this later" are different
situations, and telling them apart is the entire reason the client was offered the buttons. Clearing an answer
("actually, I will send it") notifies too, because that is news in the other direction.

The subject line is *derived* from the facts rather than passed in as a trigger — nothing received with an answer
present means the answer is what happened — so a subject can never contradict its own body. Two event kinds were
renamed on the way: `upload.notified`/`upload.notify-failed` became `notice.sent`/`notice.failed`, because one
concept with two triggers should have one word.

**What this deliberately does not do: change the chase.** A client with an answer is still on the chase list, and
the reminder still repeats their reason back — that is the documented design from 2e, and the practice is the one
who decides whether the answer is acceptable. What is new is that the practice can now *see* it before they get
there, from the board, in a state they can filter to.

## Phase 2u — The year coming round

The research's capability table lists "templates and recurrence" as one row, and this product has had templates
since 2q and no recurrence at all — twice deferred, each time because a scheduler raises a question nothing in
the product answers: *what happens when the schedule fires while last year's request is still open?*

The question dissolves once you notice that a scheduler was only ever standing in for something simpler. What a
practice needs in December is not a robot that emails sixty clients; it is the answer to **"who did I do this for
last year?"** — which is a question about data the product already holds, on a page a person reads. So there is
no schedule, no queue and nothing that sends without a button: there is a tile, a filter, and a rule.

**The rule is the anniversary of the last ask.** A client is due when nothing is open for them and the last time
they were asked was in **this month, in an earlier year**. Three properties, and each is the reason for that
shape rather than a threshold:

- **It discovers the practice's own cycle instead of assuming one.** A practice that asks in September sees its
  list in September. There is no cycle length to configure and no number here for anybody to disagree with.
- **It empties itself.** Asking a client gives them an open request, and an open request is the answer to "should
  they be asked" — so the list is a to-do list that shrinks as it is worked, not a standing report.
- **It cannot nag anybody.** The page sends nothing. The bulk ask it links to still shows every name and address
  before anything leaves the building; arriving with `?due=1` only makes the sixty ticks a person would have made.

**The honest limit, stated rather than papered over:** a practice on a quarterly or monthly cycle keeps an open
request in front of its clients most of the year, so the anniversary never comes round and this list stays empty.
A "cycle length" setting would fix that for whoever read it and be wrong for whoever did not. The list is for the
annual cycle the research describes and the one the bulk tools were built for; a practice on a faster cycle has
templates and *ask everyone* and does not need this.

**The bug worth recording.** The first version compared the whole `YYYY-MM` of the last ask against the whole
`YYYY-MM` of today *while also requiring the years to differ* — a comparison that can never be true. It shipped
for exactly one test run, because a test that backdates a request by a year and expects the client to appear is
the only thing that could have caught it. The comment in `src/store.js` says so, next to the two lines that get
it right.

## Phase 2v — The contact that was not an email

The product could only represent one kind of contact: an email it had sent itself. Everything else a practice does
— the phone call, the letter, the conversation in the office — left no trace, which meant two things were quietly
wrong:

- **The chase cadence could contradict a person.** A practice that rang a client on Monday, wrote the call in
  their diary and forgot about it, would be told on Tuesday that this client "has not been written to" and invited
  to send them a chase email. The setting exists to stop a client hearing from the practice twice in an afternoon;
  it was only ever counting half the ways a client hears from the practice.
- **The record was incomplete in the place the research says the work actually happens.** *50% of tax
  practitioners name "uncooperative clients" their #1 concern*, above staffing — and uncooperative clients are the
  ones who do not answer email. A product for chasing clients that can only remember emails is a product that
  forgets the calls that worked.

**So: one action, one event, and it sends nothing.** The request page's chasing card asks what happened, in the
practice's own words — *"Phoned — Sarah says the statements are with the bank"* — and records `request.contacted`.
Three decisions in that:

1. **It is a record, not a message.** The client is not told, nothing goes near the mail relay, and a test proves
   it: the whole point is that the *practice's* view becomes true, not that a client receives anything. A tool that
   emailed somebody because a note was written about a phone call would be a different and much worse thing.
2. **The note is required.** It is the entire content of the event. A row reading `request.contacted` with nothing
   after it is a row somebody has to open the request to interpret, which is the opposite of what a record is for.
3. **It counts against the cadence, and the wording changed to match.** The cadence now reads *any* contact, and
   everywhere it explained itself it no longer says "reminded" or "written to" — the clients page column is **Last
   contact**, the CSV header with it, and the chase page says *"in touch 3 days ago"* and *"held back by your
   cadence — in touch just now"*. `last_reminded_at` became `last_contact_at`. **A column name that lies about its
   contents is the defect this project keeps finding**, and this one would have started lying the moment a phone
   call could land in it.

What it deliberately does not do: record *who* the contact was with, or how it happened. A dropdown of channels
would be the software guessing at a distinction the practice makes in the sentence they type anyway.

## Phase 2w — The review loop: a bug found by looking, and one press instead of eight

This pass started as friction and turned into a bug report, which is the usual order of these things.

**The bug: "ready" could be a lie.** A request whose documents had all arrived and been checked — but where one of
them had been **flagged as unusable** — reported itself as *ready to work on*. `received` counts a file that
arrived, and a document the practice rejected has arrived; so the state machine saw a complete packet. The chase
page, reading the same request, saw `outstandingOf` and listed the client as owing something. **Two screens,
one request, disagreeing** — the board said "ready", the chase said the client owed a document, and the chase was
right. It is the same defect as the `answered` gap in 2t, one layer down: a fact the record holds that the state
did not.

It was found by asking what a practice actually sees when they open a request in the morning, and then writing a
throwaway script that produced the sequence a real rejection produces — file arrives, practice checks it, practice
flags it, client re-sends, practice checks the replacement — and printing the state. **277 tests had nothing to
say about the flagged case**, which is exactly why it lived as long as it did.

The fix is one condition: `needsAttention` keeps a request off `ready`, because something has arrived *and has to
arrive again*. What it becomes is `waiting on the client`, which is true. The naive fix would have produced the
sentence *"Waiting on the client for 0 of 3 documents"*, so the request page got its own honest line instead:
**"Waiting on a replacement. Everything asked for has arrived, but one of them is going to be sent again."**

**The friction: eight page loads for eight documents.** The morning's work is opening a request, downloading what
arrived, and ticking it off — and each tick was a form post and a full re-render, which loses your place in the
list. One press now does the usual case: **"Mark all 3 as checked"**, on the page that already says there are files
to check. Four decisions in it:

1. **It goes through `setItemReviewed`, once per document.** Not an `UPDATE` over the table: a request's history
   must not depend on which way the checking was done, so there is no second implementation of a check.
2. **Only what has arrived.** An item with no file cannot be checked — the rule that stops a request reporting
   itself ready while the client has sent nothing.
3. **A flagged document is checked and stays outstanding**, because "somebody looked at this file" and "this file is
   no use" are different facts. That interaction is the bug above, and it has its own test.
4. **It says how many it did** — `?checked=3` and a confirmation — so a press that did nothing cannot look like one
   that worked.

**And the snapshot tool was lying about what it showed.** The cycle demo from 2u backdates and closes the request
the rest of the fixture is built on, and it sat in the middle of the file — so eight screenshots, including every
request page and both client pages, were quietly pictures of a **closed** request, and the bulk-check button
appeared in none of them. Moved to the end, with a comment saying why the order matters. A development tool that
misrepresents the page is worse than no tool, because the whole reason it exists is to check the page.

**The honest note on the friction half:** this saves a handful of minutes a season, not hours. It is worth having
because the review loop is the one thing a practice does every single morning, but it is not a headline, and
`docs/product-needs.md` does not pretend otherwise.

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
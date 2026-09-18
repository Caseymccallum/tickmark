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
          2b several people per practice  A and B done; C-i done; C-ii NEXT
          2c re-encrypting old files      NOT STARTED
          2d other install paths          NOT PLANNED
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

**Stage C is under way: the key can now be shared and stored per member.** What is left of it is the
pages — an invitation flow that a practice can actually use, a members page, removing a member, and a
practice name that is not the placeholder `My practice`.

**C-i (done, this pass): the key can move, and a practice can hold one sealed copy per member.**

Two pieces, both of which had to exist before an invitation could mean anything:

1. **The invitation crypto**, in `web/tickmark-crypto.js`. The practice's private key is sealed under a
   random 32-byte **secret** with HKDF and AES-GCM, and the secret is meant to travel in the part of a
   link a browser never sends to a server — the fragment. The functions work with PKCS#8 *bytes*, not a
   `CryptoKey`, deliberately: the passphrase-unwrapped key is imported as **not extractable**, and that
   is a property worth keeping, so rather than making every unwrapped key exportable, one narrowly-named
   function hands out the bytes for the one operation that has to move a key.
2. **`key_wrapping`**, one row per member per key. Before this, a key carried a single wrapped copy and a
   practice had a single login, so "whose passphrase" was not a question. It is now.

The test that matters is not that two rows exist. It is that **a member invited after a document was sent
can open that document** — proved by sealing a file to the practice's public key, running the invitation
steps, and decrypting with the new member's own passphrase. Both that and its mirror (the original
passphrase still opens the original record, so inviting nobody rotated anything) are in
`test/crypto.test.js` and `test/tenancy.test.js`.

One bug found while writing it, and it was a security one: `replaceWrappedKey` wrote only to the new
table, which would have left the **older column** holding a stale copy that still opened under the old
passphrase. A passphrase change is supposed to make the old passphrase useless. The column is kept as a
mirror of the *creator's* copy and updated when the creator re-wraps, and a test asserts it does not go
stale.

Two mutations proved the new tests bite:

| Mutation | What failed |
| --- | --- |
| every member shown the key creator's copy instead of their own | 3 tests, including *"and is told he has no copy of it"* — a member was handed a colleague's sealed private key |
| the wrapping backfill never runs | exactly the assertion that counts the wrappings |

**C-ii (next):** the invitation pages. The owner's browser seals the key under a secret it generates and
keeps; the server stores the sealed blob and a digest of a token; the link is
`/invite/<token>#<secret>`; the new member's browser opens the blob with the fragment secret, re-seals it
under their own passphrase, and posts only that.

### 2c. Re-encrypting old files, so a key can be deleted

**Status: not started.** The only thing that would let an old key be removed, and the reason there is no
delete button. It needs the old passphrase, a pass over every stored envelope, and a way to resume if
the browser is closed halfway through — a project rather than a patch. Until it exists, old keys stay,
which is the safe direction to be wrong in.

### 2d. Packaging beyond Docker

**Status: not started, and probably never.** A Helm chart, a Debian package, a hosted one-click. Each is
a promise to maintain an installation path, and none of them is why a practice would choose this.

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
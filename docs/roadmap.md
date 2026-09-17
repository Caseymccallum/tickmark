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
          2b several people per practice  NOT STARTED
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
send a password to a server offering no encryption, STARTTLS being requested, timeouts, refusals
naming the step, and the whole path through the app. **Not covered: the TLS handshake**, because
generating a certificate needs a tool this machine does not have. `docs/mail.md` says so.

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

**Status: not started.** A practice with two partners shares one login today, which means a shared
password and a shared passphrase. That is worse than inconvenient: it is a security property that
cannot be expressed. It needs separate logins against one practice, and a decision about whether the
passphrase is per person or per practice — which is a design question, not a coding one, because
per-person passphrases mean per-person copies of the key.

It waits because it changes the shape of the data model, and because a sole practitioner is the buyer
this is written for.

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
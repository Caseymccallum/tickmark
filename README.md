# Tickmark

**The list of documents a client owes you, and a tick as each one arrives.**

Tickmark is a self-hosted web app for accountants, bookkeepers and other professional
practices. You build a checklist of what you need from a client — last year's return,
bank statements, an ID scan, a signed engagement letter — send them a link, and watch
the list get ticked off. Nobody needs an account to send you a file. The reminders, the
tracking and the record of what arrived and when are yours, on your own server.

**Status: early, and the central claim now holds.** A client's document is encrypted in their
browser before it leaves it, and the server stores bytes it cannot read — checked by tests that
read the file back off disk, require the document itself not to appear in it, and then open it with
nothing but the passphrase. [What is encrypted, and what is not](docs/encryption.md) is the honest
account of that, including the seven things it does not protect.

Every workflow step the research named is built, and `docs/roadmap.md` says where each one's reasoning lives.
The demand check in `docs/verify-demand.md` has been run once and is still running: practitioners have been
interviewed (their words, recorded there), and a competitor's own revenue — 1,300 firms paying for "so
nothing gets chased twice" — settles that the problem is real while leaving the segment open. That is the
honest state of this: feature-complete for a first version, the need proven by somebody else's invoice, and
the question narrowed to who buys this one.

What works today: creating a practice, making an encryption key, building a request, **adding to it
and taking things off it later**, creating a link the client opens with no account, receiving
encrypted uploads, **a check against every document that arrives — so a request says "files to check"
and then "ready to work on", rather than pretending that received means ready** —
**a board that sorts every client by whose turn it is, marks the overdue ones, and counts what is in
each state**, **chasing everyone who owes something in one action** — with a page naming exactly who
will be written to before anything is sent, and a report afterwards saying what went out and what did
not — **starting a new request from an old one** so next year's list is not built from nothing,
**the client saying "I do not have this" or "I will send it later" instead of going quiet**,
**drafting the reminder** for what has not arrived — and **sending it**, if you point Tickmark at a mail
relay — **closing a request** when there is nothing left to ask for, **opening what arrived in the
browser** — the passphrase is typed into the page, the file is decrypted there, and the server never
sees it — **rotating the key**, with the old one kept so that nothing already sent becomes unopenable, and
**a keys page that says how many files each key is holding** — which is the question that decides whether
an old key can ever be thrown away, and had no answer before this;
**moving those files onto the current key, so an old key can be retired** — the browser opens each file with
the old key's passphrase, seals it to the current one, checks the round trip before anything is replaced, and
carries on from where it stopped if the page is closed. Retiring destroys the key's copies and keeps the
record that it existed;
**inviting a second person into the practice**: each member gets their own login and their own
passphrase, holds their own sealed copy of the practice's key, and can open documents that arrived
before they did. The invitation carries the key sealed under a secret that travels in the part of a
link a browser never sends to a server; and **removing a member**, which destroys their copies of the
key and ends their sessions, keeps the record of who did what, and says on the page that asks that it
cannot take back a key they already have.

Since then, and in the order a practice meets them:

- **Clients are records**, not names retyped: a directory of everyone you ask, with what each still owes
  and whether they can be written to at all. An address typed on a later request updates the client
  instead of being discarded — which is what it did, silently, until this existed.
- **Lists you use again**: a checklist saved under a name, made either on its own page or from a request
  that already has the right list on it. A template is a *starting point* rather than a record, so it is
  the one thing in Tickmark that can be deleted outright.
- **Ask everyone at once**: one list, one title, one deadline, and a request per client with **its own
  link** — every name and address on the page before anything is sent, and a report naming every outcome.
  A failure to one client never stops the other forty-nine.
- **Being told when a client does something** — the only email nobody presses a button to send. One
  message per request per day: what arrived, what has not, and what the client said, in their words. It is
  sent **after** the client's own upload has been answered, so your mail server can never fail or delay
  somebody else's file. Turn it off on the page where your practice's name lives.
- **The year coming round**: the clients page names who is due an ask — nothing open for them, last asked
  in this month of an earlier year — and *ask everyone* arrives with them already ticked. No scheduler and
  no cycle length to configure; the rule reads your own history, and asking somebody takes them off the list.
- **Finding things**: search over client, request and address that composes with the tab and state filter
  already on screen; three orders; and both lists as CSV, honouring the filters and the order on screen,
  because reconciling a season happens in a spreadsheet.
- **A request that can change**: title, due date, the note to the client and the client itself, all
  editable after creation — deadlines move constantly, and the old fix was to close the request and start
  again, losing the client's link — and the first ask can be emailed from the request itself rather than by
  copying a link into another program.
- **A practice the client can place**: every letter is signed with your practice's current name, and the
  page a client lands on says which firm is asking. Before this, an email asking a stranger for their bank
  statements ended `Thanks,` and the page said "Tickmark", which is what a phishing attempt looks like.
- **A receipt for the client**: their page says how many documents they have sent, names each file and the
  day it arrived, and thanks them when the list is complete — which answers "did you get it?" without a
  phone call.
- **Closing a season in one go**: the finished ones ticked, the unfinished ones left as a decision, and each
  closure recorded exactly as the single-request path records it.
- **Your own calendar**: overdue dates are read where *you* are rather than in UTC, which said "overdue" a
  day early in Auckland and a day late in Honolulu for part of every day.
- **Your own account**: change your password — it costs the current one, and ends every other session —
  change your address, and see where you are signed in, with a button per session. And for the day the
  password is lost entirely, `tools/reset-password.mjs` replaces it from the command line. The passphrase
  that unwraps the key is untouched and unrecoverable, because that is the design — see [the encryption
  document](docs/encryption.md).
- **An invitation you can take back**: a link that hands over a copy of the practice's key can be revoked
  before it is used, instead of waiting seven days for it to die.
- **A letter, not a memo**: the ask and the reminder leave as plain text *and* as a styled letter with
  your name at the top and the link as a button — the same words in both, so what the draft shows is
  what gets sent.
- **The change that gets announced**: when a key is added or the membership changes, the owners hear by
  email. That is the one change that silently decides who can read what arrives next, so it is never
  silent here.
- **A mail relay you can test**: a hidden page that sends one message through your own configuration and
  reports the relay's exact reply — `535` for credentials, a refused connection for the port — rather than
  leaving you to guess which of the three things is wrong.
- **A page a client cannot lose a file to**: the browser checks the file's size against your limit before it
  uploads, so a 50 MB scan against a 10 MB limit is a sentence rather than a raw 413.

`docs/product-needs.md` explains where the states came from: the research, with sources, on what
practices actually lose time to. The short version is that the chase is not a collection problem —
every portal collects — it is that "received" and "ready" are different things and most tools conflate
them.

**Chasing everybody at once** has a cadence, and the number is yours: Tickmark starts at "no limit" and
will not pick a threshold for you, because how often it is acceptable to chase a client is your judgement
about your clients. Set it and clients inside it are held back and named in the report — never dropped
quietly. Sending one request's reminder by hand is never held back, because there you are looking at that
client.

**And you can record the contact that was not an email** — a phone call, a letter, a conversation in the
office. It goes in the record, it counts against the cadence like a reminder does, and it sends nothing: the
point is that the tool stops offering to chase somebody you spoke to this morning. Until this existed the only
contact the product could represent was an email it had sent itself, which meant a practice that chased by
phone was either nagging by email or not trusting the software at all.

What does not exist yet: **recurring requests** on a schedule — a request that makes *itself* and emails a
client because a date came round. That is still not built, and the reason is the one thing a schedule cannot
answer: what happens when it fires while last year's request is still open. What exists instead is the half of
it a scheduler was standing in for: the clients page says who is *due* an ask, and sending it is one action you
press. And **files that arrived before their key was recorded**, which no move can touch because the move works
from the record — the keys page says how many there are. Three things are refused rather than pending, and
`docs/product-needs.md` says why: reading the documents (OCR and inference, which would mean sending a client's
records to a third party), integrations with the tax software practices already run, and a robot that writes to
your clients without a person reading the list first.

`docker compose up` is verified: the image builds, the container serves, the volume holds ciphertext,
and the records survive a restart. That sentence is here because it was tested, not because it was
written — an earlier version of this file claimed the opposite, and running it found a missing copy
of `web/` that the build itself could not detect.

## Running it

```
node src/server.js
```

Then open <http://localhost:3000>. It needs Node 24 or later and nothing else — no
`npm install`, because there are no dependencies to install. Data goes in `data/`.

Behind anything other than localhost, set `TICKMARK_PUBLIC_URL` to the address you reach it at: the
links inside emails are built from it, and without it they are built from whatever the request claimed.
`.env.example` has the full list of settings.

You will be asked for a passphrase the first time you try to send a client a link. It protects the
key your clients' documents are encrypted to, it is never sent to the server, and nothing can
recover it. Read [the encryption document](docs/encryption.md) before choosing it.

`docker compose up` is the intended install and it is verified — built, run, driven through the whole
loop including a rotation and the re-encryption pass, then restarted to confirm the volume keeps the
records. One container, one volume, no external database and no third-party service: `node:sqlite` and
`node:crypto` are in the runtime. You can run that check yourself against your own container:

```
docker compose up -d
node tools/check-container.mjs                 # a practice, uploads, a rotation, the move, a retirement
docker compose restart
node tools/check-container.mjs --after-restart # signs back in and opens the files the volume kept
```

It exists because `npm test` cannot check the install path — the suite runs on the host, where `web/` is
on disk, and the image once built successfully and then died on `ERR_MODULE_NOT_FOUND` because it had
not copied that directory. `npm test` runs the suite itself (386 tests today), and CI runs it on both
Windows and Linux, runs the style/navigation/site checks, renders every page and boots that container
on every push. `docs/mvp.md` has the design, and `docs/verify-demand.md` has the demand check — run
once, still running, with the interviews and the decision recorded in it.

## The problem it exists for

Every practice has the same recurring conversation between the end of one tax season
and the start of the next: *"Did we ever get the bank statements?"* and *"I sent those
in March."* The work is not collecting the documents. It is (a) asking for the right
ones, (b) knowing which are still missing, and (c) having a record of what arrived and
when, so that the same question does not have to be answered from memory eleven months
later.

The tools that solve this are paid, per-firm, and hosted by someone else
(`docs/mvp.md` names them and their prices). For a small practice the monthly cost is
real, the client's financial records sit on a third party's infrastructure, and the
practice cannot answer the simplest due-diligence question about them: *where,
exactly, is our client data, and who can read it?*

Tickmark's answer is: **on your server, and nobody else.**

## What it does

- a **request** for a client: a titled checklist, with a due date, and one item per
  document you need
- a **link** the client opens with no account, no app and no password — an unguessable
  token, with an expiry you choose
- **uploads** against individual items, so a received file belongs to the item it
  answers, and "signed engagement letter" cannot be satisfied by a utility bill
- **the client's own words and their own files**: a client can send a document nobody
  asked for — the VAT return, a covering letter — and write a message that is not a
  file at all. Both are encrypted or kept the same way as everything else, and neither
  ends up in an ordinary email, which was the only route out of this product until
  they existed. The practice can also leave **an address and a phone number** on the
  page the client is already looking at
- a **status** per item — outstanding, received, needs attention — and a per-request
  view of what is still owed. **A client who answers is a state of its own**, because
  "I do not have this" and silence are different facts and the board says which is which.
  **One press checks off everything that arrived** — each document still recorded on its own —
  and a document flagged for re-sending keeps the request off "ready", because a file that
  is no use is not a file that is in
- **every document in one place**: `/files` lists everything clients have sent — searchable by filename, client
  or request, and exportable — and says plainly that it searches *names* rather than contents, because the server
  has never seen inside a file. **Opening one is recorded too**, so a firm can say who has looked at a client's
  file
- **two-factor sign-in**: a six-digit code from any authenticator app, asked for after your
  password, with single-use recovery codes for the day the phone is gone. It is what stops
  a stolen password from becoming a stolen practice — somebody signed in as you can add a
  key of their own, and from then on every upload is sealed to them. `src/totp.js` is
  RFC 6238 in about a hundred lines of `node:crypto`, checked against the specification's
  own test vectors
- **client records you can reuse**: a directory of everyone you ask, with what each still owes and
  whether they can be written to at all, and **who is due an ask** — shown on the board when the year
  has come round, and with the ask already ticked. See [docs/clients.md](docs/clients.md).
- **a list you use again**: a checklist saved under a name, and **ask everyone at once** —
  one list, one deadline, a request per client with its own link, and a report naming every
  outcome
- **reminders**: the tool tells you who is outstanding and drafts the message — and sends it,
  if you configure a mail relay, with every attempt recorded whether it worked or not. It
  also tells *you* when a client sends something, once a day at most, so you are not the last
  to know about your own work
- a **record**: an append-only log of what was sent, what arrived, and when, so the
  question "did we get it?" is answered by reading rather than remembering
- **end-to-end encryption**: files are encrypted in the client's browser to your
  public key. The server stores ciphertext it cannot read, including if you self-host
  it — which matters when the host is a VPS you do not physically control.
- **several people in one practice**, each with their own login and their own passphrase,
  each holding their own sealed copy of the practice's key — so a second partner can be
  added mid-season and open the documents that arrived before they did. An invitation
  carries a copy of that key without the server ever seeing it, and **removing a member**
  destroys their copies and ends their sessions without deleting the record of what they
  did.
- **three roles** (see [docs/roles.md](docs/roles.md)): an **owner** who holds the keys and decides who else
  is in the practice, an **accountant** who does the client work, and an **assistant** who can ask clients for
  documents, chase them and record a phone call — **and cannot open what comes back.** That last one is not a
  checkbox: files are sealed to the practice's key, a key is opened by a copy that belongs to a *member*, and
  an assistant holds no copy. The permission is enforced by the same arithmetic that keeps the server out, so
  there is no setting to get wrong and no operator — including us — who could grant it. Inviting one is a
  choice on the invite form, and the link then carries no key at all.
- **two checks before a file is even encrypted**: a **password-protected PDF** (bank statements arrive locked
  more often than not, and the client has no idea, because it opens fine on their machine) and **the same file
  sent twice**. Both happen in the browser, because the file is still there — the alternative is reading every
  document on the server, which this design rules out. Both warn rather than refuse, because stopping somebody
  sending the only copy they have would be worse than the problem.

## What it will not do

Stated here rather than discovered later. Each of these is a deliberate cut from the
first version, not an oversight:

- **no e-signature.** Signing is a different problem with a different liability.
- **no KYC or AML screening.** A regulated service, not a feature.
- **no integration with tax software** (Lacerte, ProSeries, Drake, UltraTax). The
  incumbents charge for this and it is how they win firms. It is out of scope until
  asked for by someone who needs it.
- **no compliance badges.** No SOC 2, no "IRS-compliant", no "GDPR-certified". The
  honest claim is narrower and better for this buyer: your data is on your hardware,
  and the operator cannot read the files.
- **no read-only seat, and no per-client permissions.** Three roles cover the boundaries that exist in a real
  practice — see [docs/roles.md](docs/roles.md) for the two that were considered and refused. Everybody sees
  the board, because somebody who cannot see that a document is outstanding cannot help collect it.
- **no mobile app.** Responsive pages only.
- **no AI.** Nothing here sends a client's documents anywhere. The browser-side checks above are the only
  document inspection this product can ever do, and they are possible *because* nothing is uploaded to a
  server to be read — see [docs/roadmap.md](docs/roadmap.md) 2y for the reading of a competitor that took the
  opposite route.
- **no scheduled requests.** The year coming round is a notice on your board — with the count, and one link
  into the ask you press — not a robot that writes to your clients because a date arrived. If you want
  something that acts while nobody is looking, this is deliberately not it.

## The honest limits of the encryption

Worth being precise, because it is the product's main claim:

- Files are encrypted **in the browser** to the practice's public key, so the server —
  including whoever hosts it — holds ciphertext only.
- The practice's private key is unlocked with a passphrase and never leaves the
  browser unwrapped. **If the passphrase is weak, someone who obtains the encrypted key
  can try guesses offline.** The only defence against that is the cost of each guess,
  which is why the key derivation is deliberately expensive and why the parameters are
  recorded with the key.
- Metadata is **not** encrypted: the server knows which client, which request, which
  item, and when. That is inherent to running the workflow at all, and pretending
  otherwise would be a lie of omission.
- Encrypting a file to a key is not the same as knowing who holds the key. Tickmark
  proves a file arrived intact and unread by the server. It does not prove the person
  who uploaded it was who they claimed to be.

## Documents

- [mvp.md](docs/mvp.md) — the data model, the event vocabulary, and what version one does not have
- [roadmap.md](docs/roadmap.md) — what was built, in what order, and the reasoning for each refusal
- [product-needs.md](docs/product-needs.md) — the needs, and what meets them
- [encryption.md](docs/encryption.md) — the envelope, the key hierarchy, and what a compromise would mean
- [members.md](docs/members.md) — several people in one practice, and how a key reaches a second one
- [roles.md](docs/roles.md) — who can do what, and why an assistant genuinely cannot open a file
- [clients.md](docs/clients.md) — clients as records rather than strings
- [design.md](docs/design.md) — the look, and the rules that keep it consistent
- [security.md](docs/security.md) and [audit.md](docs/audit.md) — what the product promises about security and
  performance, how each claim is checked, and what is knowingly not done
- [mail.md](docs/mail.md) — configuring a relay, and testing it
- [saas.md](docs/saas.md) — the hosted layer, and what is not proven about it
- [verify-demand.md](docs/verify-demand.md) — the research: what was asked, what came back, and the reading
- [demand-posts.md](docs/demand-posts.md) — where to ask, and what the room rules actually say

| File | What it is |
| --- | --- |
| `NAMING.md` | Why it is called Tickmark, and every name that was rejected with a reason |
| `SECURITY.md` | How to report a vulnerability, what is already known and accepted, and what is in scope |
| `docs/mvp.md` | The scope of the first version, the stack, the data model, and what is cut |
| `docs/encryption.md` | What is encrypted, what is not, and why — the document the central claim rests on |
| `docs/members.md` | The decision about several people in one practice: one key, wrapped once per person, and what it costs |
| `docs/clients.md` | Clients as records: the directory, the bug that made this necessary, and what it deliberately does not do |
| `docs/design.md` | The look: what it is, the rules behind it, and how to review a page |
| `docs/saas.md` | The audit of a multi-tenant codebase, and the plan for wrapping this one — including which parts of it are built and which are unproven |
| `docs/mail.md` | Sending reminders: what to configure, why a relay, and what the tests cover |
| `docs/operations.md` | Running it for a practice: backup and restore, the storage ceilings, and what a restore means |
| `docs/security.md` | The security posture: what is promised, how each promise is kept, and the one gap left open on purpose |
| `docs/audit.md` | A full audit: the feature gaps, what was slow and what it measured, and the plan for the code that needs splitting |
| `docs/roadmap.md` | What comes next and why, including what is deliberately not being built |
| `docs/verify-demand.md` | The pre-build check: who is asked, what is asked, and what the answers decide |
| `docs/demand-posts.md` | The posts for that check, ready to send |

## Licence

**AGPL-3.0-or-later** — the GNU Affero General Public License. The reasoning, and
what it protects, are in `docs/mvp.md`. The short version: anyone may read this,
run it for their own practice, change it and share it, for free. What it asks of
anybody offering it to others as a service is that they publish the changes they
made — which is the line between a community edition and somebody taking this and
calling it theirs, and it is why the hosted edition can exist without being
undercut by a closed copy of itself.

The source is public and always will be; the self-hosted edition is free forever;
and the hosted edition has to be paid for because running servers for people is
work. That is the whole of the bargain.

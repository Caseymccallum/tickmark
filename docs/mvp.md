# The first version

This is the plan the code is written against. It says what ships, what does not, and
what would make the whole thing not worth building.

## Where the build is

Written down so that this document is never mistaken for a description of the software.

**Built:** accounts and sessions; the practice's ECDH P-256 key, made in the browser and stored
with the private half wrapped under a passphrase the server never sees; requests, clients and
items; the client link with an expiry and a revoke; **encrypted uploads** the server cannot read;
the append-only record of what arrived; the practice's view of what is outstanding; **the reminder
draft**; **closing and reopening a request**; **opening what arrived, in the browser**; **a list that
stays alive** — documents added after the fact, withdrawn without losing the record of having asked,
flagged as needing attention with a reason the client reads, and notes the client attaches to what
they send; and a command line tool that opens a stored file for scripting.

**Three of those were not missing from the code so much as missing from the truth.** `docs/mvp.md`
claimed *"the client … can add a note"* and *"per item: outstanding, received, needs attention"*, and
nothing in the source mentioned attention at all — the column for a client note existed and no
browser ever sent one, so it could only ever be null. The list also could not be added to after
creation, which meant a practice who remembered one more document had no way to ask for it. All three
are now built, and the finding is recorded here because the pattern is worth watching: a plan written
in the future tense is a list of claims, and claims drift.

**Two things here were not in the plan, and both for the same reason.** *Closing a request* was
missing, and without it a practice's list grows all season and never empties — a list that never
empties stops being read, which makes the tool useless in its second season rather than its first.
*The reminder needs a link*, and the link cannot be recovered from the server by design, so
drafting a reminder makes a fresh one. That is the visible cost of a deliberate decision, and it is
on the screen where the practice can see it rather than in a footnote.

**Not built:** re-encrypting old files to a new key, which is the only thing that would let an old key
be deleted safely. Everything else in the first version's scope is done, and the honest limits of the
encryption are in `docs/encryption.md` rather than in this file.

## Keys are a history, not a value

The plan said one key per practice. It is a table, and the reason is that rotation cannot be a swap:
every file already stored is encrypted to the key that was current when it arrived, so a practice
must keep its old keys or lose access to its own records. The newest row is the one new uploads use,
older rows open the files sent while they were current, and there is no way to delete one.

That last part is deliberate. A delete button would be a button that orphans a season of client
documents, and until there is a way to re-encrypt them first, the feature should not exist.

**Two of the three claims in the wedge below are now true of the software** — it runs on the
operator's own hardware with no dependencies, and files are encrypted to a key the server does not
hold. The third, one-command installation, is written but unverified: Docker is installed on the
author's machine and its daemon was not running, so `docker compose up` has never been run. That is
recorded rather than assumed away.

## The market, as measured

Not guessed — read off the incumbents' own pricing pages on 2026-09-17:

| Product | Price | What it is |
| --- | --- | --- |
| Content Snare | **$35 / $71 / $119 per month** (annual), by active requests and users | The closest comparable. Request documents from clients, reminders, client portal, approvals. Its own website names its industries: *accounting & bookkeeping, legal, mortgage & finance, digital agencies.* |
| SmartVault | **$12.50 per tax return** for AI document requests, plus DMS tiers | Document management and client portal for accounting firms, with integrations into Lacerte, ProSeries, ProConnect, UltraTax and Drake. |
| TaxDome, Liscio, FileInvite, Karbon, Canopy | comparable recurring pricing | Practice-management suites that include document collection as a feature. |

Two things follow. **The demand is real and already being paid for** — that is what a
price list is evidence of. And **the open-source option in this category is thin**:
ProjectSend, Atrium, Sprag and papra exist, but they are *file-sharing portals*. The
thing practices pay for is not storage, it is the **request-and-chase loop** — ask for
a specific list, know what is missing, keep asking. That is the gap this project aims
at, and it is narrower and more specific than "a client portal".

## The wedge

Three claims, each of which an incumbent cannot make:

1. **It runs on your server, and you can read the code.** No per-request pricing, no
   per-seat pricing, no client records leaving your infrastructure.
2. **Files are encrypted to your key in the client's browser.** The server stores
   ciphertext, so a compromised or dishonest host still cannot read a client's
   financial records.
3. **One command to install.** No external database, no third-party service, no
   runtime dependencies.

## What ships in version one

Seven things, and nothing else:

1. **Sign in.** One practice, one account: email, password, and a passphrase that
   unwraps the encryption key. Local accounts — no OAuth provider, no email
   verification dependency.
2. **Build a request.** Title, optional due date, and a list of items, each with a
   label and an optional note. Items are ordered.
3. **Send a link.** An unguessable token with an expiry you choose. The client opens
   it with no account.
4. **Receive uploads.** The client sees the checklist, uploads a file per item, and can
   add a note. Multiple files per item.
5. **Track status.** Per item: outstanding, received, needs attention. Per request: what
   is still owed, at a glance.
6. **Remind.** The tool shows exactly which items are outstanding per client and drafts
   the message to send. **In version one you send it yourself** — see the cut list.
7. **Record.** An append-only log per request: link sent, file received, reminder
   drafted, request closed. This is the part that answers "did we get it?" a year later.

## What ships after version one, and why it waits

The live version of this list is `docs/roadmap.md`, which carries the status of each item. What
follows is the original ordering, kept because the reasons are the interesting part.

- **Email sending.** *Shipped in Phase 2a* — see `docs/mail.md`. The original reasoning was right and
  is worth keeping: this was the biggest cut, and it was cut because automated sending means
  deliverability, bounces, SPF/DKIM documentation, retry logic and silent-failure modes, and none of
  those is why a practice would choose this tool. Shipping the *tracking* first tested whether the
  client portal gets used at all, without a mail server in the way. What the build added to that:
  the deliverability problem is answered by pointing the tool at the practice's own provider as a
  relay, a failed send keeps the text and reports the relay's own words, and there is deliberately no
  queue or retry.
- **Multiple users per practice.** Version one is one login for one practice.
- **Decryption in the browser for download.** *Shipped.* The browser viewer came before the export
  tool turned out to be needed.
- **Docker Compose as the only install path.** *Shipped and verified by running it.* A Helm chart, a
  Debian package and a hosted one-click are all later, or never.

## The stack, and the trade-offs

| Decision | Why | What it costs |
| --- | --- | --- |
| **One Node process, server-rendered HTML** | No build step, no framework churn, no client bundle to audit, and the pages are forms and lists — the case where server rendering is simply better. It also avoids the failure mode of a large app whose dependencies age underneath it. | No rich interactions. If a drag-and-drop builder is ever wanted, this decision has to be revisited. |
| **`node:sqlite`** — measured, not assumed. It works with no flag on 23.4, 24.0 and 26.5, and Node **22.5.0 refuses it outright** (`No such built-in module: node:sqlite`), which is why the declared floor is Node 24 | The database is a file, owned by the user, backed up with `cp`. No native module to compile, no database service to run, no ORM. | SQLite is single-writer. Correct for one practice; not the design for a hosted multi-tenant service. |
| **Zero runtime dependencies** | A self-hosted tool's dependency tree is a liability the *operator* inherits, and a supply-chain surface for software that handles client financial documents. `node:crypto` covers hashing, keys and AES-GCM. | Some things are written by hand that a library would provide (an SMTP client, a ZIP reader) — so those are deferred rather than pulled in. |
| **Browser Web Crypto for the client side** | The encryption must happen where the plaintext already is. | Web Crypto has PBKDF2, not scrypt or Argon2. The passphrase-derived key uses PBKDF2-SHA256 with a high iteration count, which is the strongest available primitive in that environment. |
| **Docker image on `node:24-alpine`** | One command, one volume, no host toolchain. | Docker becomes a prerequisite for the easy path; running it directly on Node is still possible. |

## The data model

Nine tables, and the count went up twice during the first week of building. `session` was added because
**signing out has to actually revoke access**, which needs server-side state. `practice_key` was added
because **rotation cannot be a swap** — a key is a history, not a value, and a schema that cannot hold
a second key cannot rotate. The plan said seven; the code says nine, and the code is right.

The **record** is a table, not a log file, because the product's value includes being
able to answer questions about the past.

- `practitioner` — email and password hash. **No key columns**: a practice's keys are a history, in
  `practice_key`, and a schema that cannot hold a second key cannot rotate
- `practice_key` — a key the practice holds: the public half, the private half already wrapped under a
  passphrase the server has never seen, and when it was made. The newest is the one new uploads use
- `client` — belongs to a practice; name and optional email
- `request` — belongs to a client; title, due date, closed date
- `request_item` — belongs to a request; label, note, position
- `access_token` — belongs to a request; **the SHA-256 of the token, never the token**,
  plus expiry and revocation. A stolen database must not let anyone open a client's link.
- `upload` — belongs to an item; filename, MIME type, size, SHA-256 **of the
  ciphertext**, a storage path, the client's note, and a timestamp
- `event` — append-only, and the product's entire vocabulary for what has happened:
  `request.created`, `items.added`, `item.withdrawn`, `item.restored`, `item.needs-attention`,
  `item.attention-cleared`, `link.issued`, `link.revoked`, `upload.received`, `reminder.drafted`,
  `request.closed`, `request.reopened`. Twelve kinds, and the reason there is no thirteenth is that
  anything worth knowing later has to justify a new word here.

  Two habits in that list are deliberate. An act on several items at once is *one* event — adding
  four documents is `items.added`, not four rows — because a log that records one act four times is a
  log nobody reads. And a status that can be set can be unset, and both are recorded: withdrawn and
  restored, flagged and cleared, closed and reopened.
- `session` — a signed-in practice; the token is stored hashed, like a link token

Three choices inside that are worth stating:

1. **Tokens are stored hashed.** Same reasoning as passwords, and the same failure it
   prevents.
2. **The upload digest is over the ciphertext**, computed server-side. It proves what
   arrived is what is stored, and it leaks nothing.
3. **Nothing is deleted.** A file removed from an item is marked, not unlinked, until a
   retention rule says otherwise. A record that can be edited is not a record.

## The encryption, and the lesson carried over

The design is direct: the client's browser generates an ephemeral P-256 key, derives a
symmetric key with HKDF-SHA-256 against the practice's public key, and encrypts the file
with AES-256-GCM; the practice unwraps the file with the private key behind their
passphrase. The server never sees a plaintext byte or a private key.

**One specific mistake will not be repeated.** In the author's earlier encrypted-forms
project, an independent audit found a *verification token* — a known constant
encrypted under the passphrase-derived key and stored, so the server could tell whether
a passphrase was correct. The finding was that it hands an attacker who obtains the
database a free offline oracle for guessing passphrases: salt plus ciphertext of a
*known plaintext* is a testable guess. Tickmark stores no such token. Whether a
passphrase is right is answered by whether AES-GCM's authentication tag validates on
the wrapped private key — an oracle that already exists, cannot be removed, and is not
made cheaper by a stored copy.

Second carry-over: **the cost of one guess is the entire defence** against someone who
takes the encrypted key file, so the derivation parameters are chosen deliberately,
recorded alongside the key, and the parameter ceiling is bounded so that a hostile file
cannot demand a gigabyte of memory or a minute of CPU from a victim who was merely
handed it.

## Deployment

One container, one volume, no services to provision:

```
data/
  tickmark.db          the SQLite database
  blobs/<request>/<upload>.bin   ciphertext, one file per upload
  key/                 the practice's wrapped private key, backed up separately
```

`docker compose up` starts it. `docker compose down` stops it. Backing up means copying
`data/` and keeping the passphrase somewhere else — and the README will say the second
half loudly, because a backup of an encrypted key without its passphrase is a file
nobody can open.

Version one serves HTTP on a port. Client links must be HTTPS in anything but a local
trial; the documented path is a reverse proxy the operator already has (Caddy, nginx,
Traefik) rather than a certificate story invented here.

## Definition of done for version one

The same bar the author's previous project was held to, because it is the bar that
catches the failure mode where a thing is 90% built and never arrives:

- a practice can install it with one command and send a real client a real link
- a client can submit a document **without instructions**
- a practice can see what is outstanding without reading any documentation
- a file uploaded through the browser decrypts to the same bytes the client sent, and
  there is a test that proves it byte-for-byte
- the server can be inspected: it holds ciphertext, not documents
- `README.md` describes what exists and nothing that does not
- it is announced somewhere a practitioner can find it

## The licence, and why AGPL

**AGPL-3.0-or-later.** Anyone may run Tickmark for their own practice, modify it, and
share it. Anyone who runs a *modified* version as a network service for others must
offer their changes back.

The alternative was MIT, which is what the author's previous open-source project uses,
and the difference is the commercial question rather than a philosophical one. The plan
included a hosted edition paid for by practices that do not want to run a server. MIT
would let any competitor take this code, host it, and compete with the hosted edition
without contributing anything. AGPL makes that specific move unattractive while leaving
every self-hoster — which is the audience this project needs first — entirely
unaffected, since running software for yourself carries no obligation.

This is a decision worth revisiting if it turns out to be the reason a practice or a
contributor walks away. Recorded as reversible on purpose.

## What would make this not worth building

Written down before the code, so that a later decision is a reading rather than a
feeling:

1. **Practitioners say the chase is not their problem.** If the demand check
   (`docs/verify-demand.md`) comes back with "our portal already does this and we are
   happy", the project stops there, having cost a day.
2. **The privacy claim turns out not to matter to the buyer.** If practices happily
   store client records with a third party and would not run a server to avoid it, then
   the wedge is a preference and not a need — and the incumbents are cheaper than
   building this.
3. **The install is not genuinely one command.** A self-hosted tool that needs a
   tutorial has no advantage over a hosted one, for this audience especially.

Any of those is a reason to stop, and stopping is a cheaper outcome than a seventh
half-finished project.
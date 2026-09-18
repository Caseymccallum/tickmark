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
account of that, including four things it does not protect.

What works today: creating a practice, making an encryption key, building a request, **adding to it
and taking things off it later**, creating a link the client opens with no account, receiving
encrypted uploads, **seeing what is still outstanding and what needs re-sending**, **drafting the
reminder** for what has not arrived — and **sending it**, if you point Tickmark at a mail relay —
**closing a request** when there is nothing left to ask for, **opening what arrived in the browser** —
the passphrase is typed into the page, the file is decrypted there, and the server never sees it —
**rotating the key**, with the old one kept so that nothing already sent becomes unopenable, and
**inviting a second person into the practice**: each member gets their own login and their own
passphrase, holds their own sealed copy of the practice's key, and can open documents that arrived
before they did. The invitation carries the key sealed under a secret that travels in the part of a
link a browser never sends to a server.

What does not exist yet: **re-encrypting old files to a new key**, which is the only thing that would
let an old key be deleted; and **removing a member**, which is the state you can see on the members page
but not yet an act — `docs/members.md` says what it would take and why the honest version has to come with
a sentence about what it cannot do. Until old files can be re-encrypted, old keys stay, and
`docs/encryption.md` says why.

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

You will be asked for a passphrase the first time you try to send a client a link. It protects the
key your clients' documents are encrypted to, it is never sent to the server, and nothing can
recover it. Read [the encryption document](docs/encryption.md) before choosing it.

`docker compose up` is the intended install and it is now verified — built, run, driven through the
whole loop including a rotation, and restarted to confirm the volume keeps the records. One container,
one volume, no external database and no third-party service: `node:sqlite` and `node:crypto` are in the
runtime. `docs/mvp.md` has the design, and `docs/verify-demand.md` is the check that was supposed to
come before the code.

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
- a **status** per item — outstanding, received, needs attention — and a per-request
  view of what is still owed
- **reminders**: the tool tells you who is outstanding and drafts the message — and sends it,
  if you configure a mail relay, with every attempt recorded whether it worked or not
- a **record**: an append-only log of what was sent, what arrived, and when, so the
  question "did we get it?" is answered by reading rather than remembering
- **end-to-end encryption**: files are encrypted in the client's browser to your
  public key. The server stores ciphertext it cannot read, including if you self-host
  it — which matters when the host is a VPS you do not physically control.
- **several people in one practice**, each with their own login and their own passphrase,
  each holding their own sealed copy of the practice's key — so a second partner can be
  added mid-season and open the documents that arrived before they did. An invitation
  carries a copy of that key without the server ever seeing it. There are no roles or
  permissions, and removing a member is not built; see [docs/members.md](docs/members.md).

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
- **no roles or permissions.** Several people can be in one practice, each with their own login and
  their own passphrase — but everyone can see and do everything. There are no seats, no per-user
  pricing, and no "read only" colleague. If you need permissions rather than shared access, this is not
  it yet.
- **no mobile app.** Responsive pages only.
- **no AI.** Nothing here sends a client's documents anywhere.

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

| File | What it is |
| --- | --- |
| `NAMING.md` | Why it is called Tickmark, and every name that was rejected with a reason |
| `docs/mvp.md` | The scope of the first version, the stack, the data model, and what is cut |
| `docs/encryption.md` | What is encrypted, what is not, and why — the document the central claim rests on |
| `docs/members.md` | The decision about several people in one practice: one key, wrapped once per person, and what it costs |
| `docs/mail.md` | Sending reminders: what to configure, why a relay, and what the tests cover |
| `docs/roadmap.md` | What comes next and why, including what is deliberately not being built |
| `docs/verify-demand.md` | The pre-build check: who is asked, what is asked, and what the answers decide |
| `docs/demand-posts.md` | The posts for that check, ready to send |

## Licence

AGPL-3.0-or-later. The reasoning, and what it protects, are in `docs/mvp.md`. The
short version: anyone may run this for their own practice, change it, and share it;
anyone who offers it to others as a service must publish their changes. That is the
line between a community edition and somebody else's product.
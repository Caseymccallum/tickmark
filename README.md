# Tickmark

**The list of documents a client owes you, and a tick as each one arrives.**

Tickmark is a self-hosted web app for accountants, bookkeepers and other professional
practices. You build a checklist of what you need from a client — last year's return,
bank statements, an ID scan, a signed engagement letter — send them a link, and watch
the list get ticked off. Nobody needs an account to send you a file. The reminders, the
tracking and the record of what arrived and when are yours, on your own server.

**Status: early, and honest about it.** What works today: creating a practice, signing
in and out, and building a request — a titled list of documents for a named client, with
the items you need. What does not exist yet: **the client link, the uploads, the
encryption, and the reminders.** The pages say so where a user would otherwise assume
they were there.

## Running it

```
node src/server.js
```

Then open <http://localhost:3000>. It needs Node 24 or later and nothing else — no
`npm install`, because there are no dependencies to install. Data goes in `data/`.

`docker compose up` is written and is the intended install, but it has not been built on
a machine with Docker yet, and this file will not claim it works until it has been.

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

## What it will do

- a **request** for a client: a titled checklist, with a due date, and one item per
  document you need
- a **link** the client opens with no account, no app and no password — an unguessable
  token, with an expiry you choose
- **uploads** against individual items, so a received file belongs to the item it
  answers, and "signed engagement letter" cannot be satisfied by a utility bill
- a **status** per item — outstanding, received, needs attention — and a per-request
  view of what is still owed
- **reminders**: the tool tells you who is outstanding and drafts the message, so
  chasing is a decision rather than a chore
- a **record**: an append-only log of what was sent, what arrived, and when, so the
  question "did we get it?" is answered by reading rather than remembering
- **end-to-end encryption**: files are encrypted in the client's browser to your
  public key. The server stores ciphertext it cannot read, including if you self-host
  it — which matters when the host is a VPS you do not physically control.

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
- **no team roles, seats or per-user pricing.** One practice, self-hosted, unlimited
  clients. If you need multi-user permissions, this is not it yet.
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

## Running it

Not yet built. The intended experience, which the plan is written against:

```
docker compose up
```

One container, one volume, no external database, no third-party service, and no
runtime dependencies — `node:sqlite` and `node:crypto` are in the runtime. See
`docs/mvp.md` for the design and `docs/verify-demand.md` for the check that comes
before the code.

## Documents

| File | What it is |
| --- | --- |
| `NAMING.md` | Why it is called Tickmark, and every name that was rejected with a reason |
| `docs/mvp.md` | The scope of the first version, the stack, the data model, and what is cut |
| `docs/verify-demand.md` | The pre-build check: who is asked, what is asked, and what the answers decide |

## Licence

AGPL-3.0-or-later. The reasoning, and what it protects, are in `docs/mvp.md`. The
short version: anyone may run this for their own practice, change it, and share it;
anyone who offers it to others as a service must publish their changes. That is the
line between a community edition and somebody else's product.
# Tickmark

**The list of documents a client owes you, and a tick as each one arrives.**

Tickmark is a web app for accountants, bookkeepers, tutors, lettings agents — anyone whose week involves
asking clients for paperwork. You build a checklist of what you need from a client (last year's return, bank
statements, an ID scan, a signed engagement letter), send them a single link, and watch the list get ticked
off as things arrive.

Your client needs **no account, no app, and nothing to sign up for**. They open the link, see your name at
the top, and work down the list. The reminders, the tracking, and the record of what arrived and when are
all yours.

## Why this beats chasing over email

Asking for six documents over email sounds fine until you've done it. The list scatters across threads.
Half the files arrive unnamed. You can't tell what's still missing without re-reading everything. And the
"did you get my bank statements?" call is one more interruption in a day already full of them.

Tickmark keeps the whole thing in one place:

- **One clear list.** Your client sees exactly what you need, in plain words, with the deadline — no
  guessing, and no "which email was that in?".
- **A tick as each thing arrives.** You watch the list fill in, so it's obvious who still owes what and what
  is late.
- **Nobody gets chased twice.** Tickmark remembers what's already been asked for and sent, so you're never
  the practice that asks for the same thing twice.
- **It says when it's genuinely done.** A request is finished when every item has arrived *and* been
  checked — not merely when files landed. So "ready to work on" really means ready.

## Why clients actually get it done

Clients ignore document requests because they are a faff. Tickmark makes their part genuinely easy:

- **One link, no account.** No password to forget, no app to install, nothing to sign up for.
- **Your name at the top.** They know who is asking and why, so it does not look like spam.
- **A list they can tick off.** They can see what is done and what is left.
- **Receipts they can check themselves.** Every file they send is named back to them with the date, so "did
  you get it?" is a question they answer without ringing you.
- **A way to say "I don't have this."** If they cannot find something, they mark it as unavailable, or
  promise it later — instead of simply going quiet.

## What you get

- **A board of every client**, sorted by whose turn it is, with the overdue ones marked and each state
  counted — so your morning starts with knowing, not hunting.
- **Chasing in one action.** Remind everyone who owes something at once, after a page that shows exactly who
  will be written to, and a report afterwards saying what went out and what did not.
- **Reminders drafted for you.** Tickmark writes the follow-up; you edit and send it (if a mail service is
  connected) or copy it.
- **A record of everything asked.** Every ask, every file, every call, every "no", with dates. So "I asked on
  the 3rd and again on the 10th" is something you can read, not remember — and can show.
- **A check on what arrives.** Tick things off as correct, or flag them and say why. The reason sits beside
  the client's file, not buried in an email.
- **Next year in one action.** Start a new request from an old one, instead of rebuilding the list.
- **Clients as records**, not names on an email — each with their own page, timeline and files.

## Your client's end

This is the whole of what your client deals with: one link that opens to a page with your name on it and the
list. They upload files (or photograph them with their phone), see what is still needed, download anything
they have already sent you, and ask you a question — all from that one page. Nothing to install.

## Keeping it private

What sets Tickmark apart from "email me the scans" is what happens to the files.

**Everything a client sends is encrypted on their own device before it leaves it.** Your server ends up
storing files it cannot open. Only someone with your practice's key and the passphrase can read them — so
even the people running the server cannot read your clients' documents.

That is not a marketing line; it is what the product is built around, and it is tested. No system is perfect,
so we are straight about it: [what is encrypted and what is not](docs/encryption.md) is written down in
full, including the seven things it does not protect.

## Two ways to run it

**Hosted — we run it for you.** £49 a month, flat. Unlimited clients, never priced per client, per return or
per person: your busiest month costs the same as your quietest. A 14-day trial, no demo call, no sales
process. Best if you just want it to work.

**Run it yourself — free, forever.** Tickmark is open source (AGPL-3.0). Put it on your own server and it is
yours: no fees, no limits, and full control over where your clients' files live. Best if you would rather
keep everything on your own machines. Instructions below.

## Who it is for

Accountants, bookkeepers and tax agents chasing returns and records. Tutors and teachers collecting consent
forms and assignments. Lettings agents gathering references and checks. Anyone whose work starts with "if
you could just send me…".

## Getting started

- **Want it hosted?** Start a 14-day trial — no call, no card up front.
- **Want to run it yourself?** It is a Node app you can have running locally in a couple of minutes. See
  [Run it on your machine](#run-it-on-your-machine).

---

# For developers & self-hosters

Everything below is for the people who install, run, or build on Tickmark.

## Run it on your machine

```sh
npm ci
npm test
npm start
```

Then open <http://127.0.0.1:8787>.

`TICKMARK_DATA` chooses where the data lives, and `TICKMARK_ORIGIN` sets the address clients should use in
links. To let it send reminders, point it at a mail relay (`TICKMARK_MAIL_*`) — see [docs/mail.md](docs/mail.md).
Tickmark needs no third-party auth, no email reading, no cloud storage, no telemetry and no CDN.

## Run it for a practice

- **One practice, one person** — create the practice, choose a key passphrase, and go. One key per practice,
  used for everything.
- **One practice, several people** — invite a colleague. Each has their own login and passphrase, and holds
  their own sealed copy of the practice's key, so either of you can open documents that arrived before the
  other joined. The invitation carries the key sealed in the part of a link a browser never sends to a
  server.
- **Several practices** — run a second practice in the same install. They stay separate: different clients,
  different keys, and the passphrase typed into one practice cannot reach another's data.

## The workflow, in order

1. **Create a request** — the checklist, the items, the due date, an optional note to the client.
2. **Send the link** — one link per request; no account needed on the client's side.
3. **What the client sees** — their list with your name, uploads, receipts, and "I don't have this".
4. **Chase what is missing** — one action, with a preview of who is written to and a report afterwards.
5. **When it is all in** — close the request, or start next year's from this one.

## Making sure what arrived is what was needed

Files arriving is the start, not the end. Every arrival is checked: tick what is correct, flag what is not,
and say why. A request reads "files to check" until then, and "ready to work on" after — and the board keeps
the two apart, so nobody starts work on something that has not been verified.

## How the encryption works

Tickmark keeps its central promise — the server cannot read your clients' files — with standard, audited
cryptography rather than anything exotic. Each document is encrypted in the client's browser before it is
ever sent; the key that opens it is held by the practice, not the server. Keys are per-request and strongly
derived, and can be rotated (with old keys kept, so nothing already saved becomes unopenable). Recovery is a
printed sheet of words — never a way for anyone at Tickmark to read your files.

The full account — the key hierarchy, what is protected, what is not, and what a compromise would mean — is
in [docs/encryption.md](docs/encryption.md) and [docs/security.md](docs/security.md).

## What it deliberately does not do

The boundaries are as much a part of the product as the features. Tickmark does **not**:

- Read your calendar or email, post to social media, send text messages, or chat in-app.
- Look inside documents, run OCR, or turn a photograph into searchable text.
- Store documents in the ordinary sense — it holds encrypted bytes it cannot open.
- Use magic links as an authentication system, or keep files in third-party storage or a CDN.
- Offer e-signature, invoicing, or a full document manager.
- Let several people review and approve one document — there are no roles and no approval chain.
- Act as a general file-transfer or storage service.

These are deliberate, and together they say exactly what a client's file is and is not used for. What is
planned next, and what is deliberately not being built, is in [docs/roadmap.md](docs/roadmap.md).

## Project status

**Early, and the central claim now holds.** A client's document is encrypted in their browser before it
leaves it, and the server stores bytes it cannot read — checked by tests that read the file back off disk,
require the document itself not to appear in it, and then open it with nothing but the passphrase.

Every workflow step the research named is built. The demand check ([docs/verify-demand.md](docs/verify-demand.md))
has been run once and is still running: practitioners have been interviewed (their words are recorded there),
and a competitor's own revenue — 1,300 firms paying for "so nothing gets chased twice" — settles that the
problem is real while leaving the segment open. The honest state: feature-complete for a first version, the
need proven by somebody else's invoice, and the question narrowed to who buys this one.

## Documentation

Guides, and the reasoning behind the decisions:

- [roadmap.md](docs/roadmap.md) — what was built, in what order, and the reasoning for each refusal
- [product-needs.md](docs/product-needs.md) — the needs, and what meets them
- [encryption.md](docs/encryption.md) — the envelope, the key hierarchy, and what a compromise would mean
- [members.md](docs/members.md) — several people in one practice, and how a key reaches a second person
- [roles.md](docs/roles.md) — who can do what, and why an assistant genuinely cannot open a file
- [clients.md](docs/clients.md) — clients as records rather than strings
- [design.md](docs/design.md) — the look, and the rules that keep it consistent
- [security.md](docs/security.md) and [audit.md](docs/audit.md) — what the product promises about security
  and performance, how each claim is checked, and what is knowingly not done
- [mail.md](docs/mail.md) — configuring a relay, and testing it
- [sms.md](docs/sms.md) — texting a reminder: the gateway, the one-line message, and what it never carries
- [saas.md](docs/saas.md) — the hosted layer, and what is not proven about it
- [operations.md](docs/operations.md) — running it for a practice: backup and restore, and storage
- [verify-demand.md](docs/verify-demand.md) — the research: what was asked, what came back, and the reading
- [go-succeed-prep.md](docs/go-succeed-prep.md) — the business-prep pack for a Go Succeed NI application
- [splitting.md](docs/splitting.md) — how the code is split into modules, and the recipe for the rest
- [demand-posts.md](docs/demand-posts.md) — where to ask, and what the room rules actually say
- [competitive.md](docs/competitive.md) — the nearest competitor (Zendoc): what to match, what to protect, and what to refuse

| File | What it is |
| --- | --- |
| `NAMING.md` | Why it is called Tickmark, and the names that were rejected |
| `SECURITY.md` | How to report a vulnerability, what is already known, and what is in scope |
| `docs/mvp.md` | The first version's scope, the stack, the data model, and what is cut |
| `docs/encryption.md` | What is encrypted, what is not, and why — the central document |
| `docs/members.md` | One key per practice, wrapped once per person, and what it costs |
| `docs/clients.md` | Clients as records: the directory, and what it deliberately does not do |
| `docs/design.md` | The look: what it is, the rules behind it, and how to review a page |
| `docs/saas.md` | The multi-tenant hosted layer, and which parts are built vs unproven |
| `docs/mail.md` | Sending reminders: what to configure, why a relay, and what the tests cover |
| `docs/sms.md` | Texting a reminder: the gateway, the one-line message, and what it never carries |
| `docs/operations.md` | Running it for a practice: backup, restore, and the storage ceilings |
| `docs/security.md` | The security posture: what is promised, and how each promise is kept |
| `docs/audit.md` | A full audit: feature gaps, performance, and the plan for the code |
| `docs/roadmap.md` | What comes next and why, including what is deliberately not being built |
| `docs/verify-demand.md` | The pre-build check: who was asked, and what the answers decide |
| `docs/competitive.md` | The competitor read: Zendoc's bets, and what Tickmark matches vs refuses |

## Licence

**AGPL-3.0-or-later** — the GNU Affero General Public License. Anyone may read this, run it for their own
practice, change it and share it, for free. The one thing it asks of anybody offering it to others as a
service is that they publish the changes they made — which is the line between a community edition and
somebody taking this and calling it theirs, and it is why the hosted edition can exist without being
undercut by a closed copy of itself.

The source is public and always will be; the self-hosted edition is free forever; and the hosted edition has
to be paid for, because running servers for people is work. That is the whole of the bargain.
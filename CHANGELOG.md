# What changed, and when

One entry per release, newest first, written for somebody deciding whether to upgrade rather than for a
changelog reader. `docs/roadmap.md` has the reasoning behind each of these; this is the summary.

Versions follow the ordinary convention: the first number changes when the schema or a promise does, the second
when features arrive, the third for fixes. **Downgrading is not supported** — migrations only go forwards — so
the entry that matters most is the one that says the schema changed.

## 0.1.0 — 23 September 2026

The first release. Everything before it was development, and the version number went from `0.0.0` to something
that means "this is the one to run".

**What it is.** A practice makes a checklist for a client, sends a link, and the client uploads documents through
it with no account. The files are encrypted in the client's browser to a key the practice holds, so the server
stores what it cannot read.

**The promises worth knowing before you rely on it:**

- **The server cannot read the documents.** Not as a policy — it never receives a key. Anyone can check that by
  reading `src/crypto.js` and the upload path.
- **Losing the passphrase destroys the documents.** There is no recovery, no backdoor and no reset. This is the
  one thing to tell a practice before they start.
- **The self-hosted edition is free forever**, and the licence cannot be taken back: AGPL-3.0, with no clause
  that would let a future version be pulled.
- **Backups are `node tools/backup.mjs`**, not a file copy. See `docs/operations.md`.

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

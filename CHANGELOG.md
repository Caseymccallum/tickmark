# What changed, and when

One entry per release, newest first, written for somebody deciding whether to upgrade rather than for a
changelog reader. `docs/roadmap.md` has the reasoning behind each of these; this is the summary.

Versions follow the ordinary convention: the first number changes when the schema or a promise does, the second
when features arrive, the third for fixes. **Downgrading is not supported** — migrations only go forwards — so
the entry that matters most is the one that says the schema changed.

## Unreleased, expected in 0.1.0 — the audit

Features, performance and security, end to end. Nothing below is published yet; it is in the tree and will go out
with the first version.

**One serious problem found and fixed, and it was in the feature whose whole purpose is stopping somebody who
already knows the password.** The two-factor sign-in accepted unlimited wrong codes: a six-digit code with no
attempt limit is a million guesses against a door that stays open for ten minutes, and the password rate limiter
never saw any of them because it is consulted *before* the password is checked. There is now an account-level
limiter in a bucket of its own, plus a five-attempt ceiling on the challenge itself so that a deployment which
replaces the limiter still cannot be walked. `test/security.test.js` attacks it, and the test that proved the gap
asked for sixty wrong codes and got sixty answers.

**Two smaller hardening fixes.** Two script tags built their own JSON-in-a-script-element markup with a bare
`JSON.stringify`, bypassing the one helper that escapes the one sequence that matters — nothing could break there
today, which is exactly why it was worth fixing before something could. And there were **no security headers at
all**; responses now carry `Referrer-Policy: no-referrer` (a client's URL is a credential, so it must not travel
to whoever they link to next), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Cross-Origin-Opener-Policy: same-origin`, on every response type including served documents.

**Performance was measured rather than guessed.** Every `prepare` is a parse and this code prepares on every call,
so a board with five hundred clients re-parsed the same two statements a thousand times per render — measured at
**5.8× the work** versus preparing once. Connections now cache their statements: at 500 clients the board went
176 ms → 94 ms and the chase 99 ms → 38 ms. Two N+1 patterns remain and are documented against the client count
where they would start to matter, with a plan rather than a shrug.

**Withheld on purpose:** no Content-Security-Policy. One worth having needs a per-response nonce threaded through
every rendering path, and `unsafe-inline` in a CSP is the claim that a page is protected when it is not.

`docs/security.md` states every promise with how it is checked and every known gap with why it is open;
`docs/audit.md` has the feature and performance halves. Four tools arrived with them: `npm run bench`,
`npm run find:unused`, `npm run tables`, and `tools/bench-prepare.mjs`. The schema changed by one column
(`login_challenge.attempts`), and the migration adds it in place rather than rebuilding.

## 0.1.0 — 23 September 2026

The first release. Everything before it was development, and the version number went from `0.0.0` to something
that means "this is the one to run".

**What it is.** A practice makes a checklist for a client, sends a link, and the client uploads documents through
it with no account. The files are encrypted in the client's browser to a key the practice holds, so the server
stores what it cannot read.

**The promises worth knowing before you rely on it:**

- **The server cannot read the documents.** Not as a policy — it never receives a key. Anyone can check that by
  reading `src/crypto.js` and the upload path. It also means `/files` searches filenames and never contents.
- **Losing the passphrase destroys the documents.** There is no recovery, no backdoor and no reset. This is the
  one thing to tell a practice before they start.
- **The self-hosted edition is free forever**, and the licence cannot be taken back: AGPL-3.0, with no clause
  that would let a future version be pulled.
- **Backups are `node tools/backup.mjs`**, not a file copy. See `docs/operations.md`.
- **Opening a document is recorded**, with who did it, so the practice can answer "who has seen this file?".
- **Two-factor is available** per member, and worth turning on: a stolen password can otherwise add an encryption
  key of its own, and every upload after that would be sealed to somebody outside the practice.

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

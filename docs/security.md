# The security posture, stated rather than assumed

Written after a full audit of the code — an audit that found four things, three of which are fixed and one of
which is a piece of work rather than a header. `docs/audit.md` has the feature and performance halves of the same
exercise.

The point of this file is that a claim about security is worth exactly as much as the evidence behind it, so every
section says how a claim is *checked* as well as how it is implemented.

## What the product promises, and how each promise is kept

| Promised | How | Checked by |
| --- | --- | --- |
| **The server cannot read a client's documents** | The browser encrypts to an ECDH key the practice holds. The server stores an envelope and never receives a key it could open. | `test/stack.test.js`; and by reading `src/crypto.js` and the upload path, which is rather the point |
| **Losing the passphrase destroys the documents** | The private key is wrapped under a PBKDF2/AES key derived from a passphrase that never leaves the browser | A test asserts no route accepts a passphrase |
| **One practice cannot see another's records** | Every query is scoped by `practice_id`, and each handler fetches a record *through* a scoped lookup before using its id | **`test/security.test.js` attacks this**: two practices, one trying every address with the other's ids |
| **A link opens one request** | The token's digest maps to one request; item addresses are checked against that request | The same file, from a client's side |
| **A stolen database is not a set of working sessions** | Session, link, invite, challenge and recovery tokens are stored as SHA-256 digests | `test/stack.test.js` asserts a link token is never stored |
| **Passwords are not crackable in bulk** | scrypt at `N=2^16` (64 MiB per guess), 16-byte salt, constant-time compare | `src/crypto.js`; the parameters are one exported constant |
| **A stolen password is not enough** | TOTP second factor, per member | `test/two-factor.test.js`, against the RFC's own vectors; and `test/gateway.test.js` proves the platform sign-in cannot walk around it |

## The five findings

### 1. The second factor could be ground down — **fixed, and the most serious thing here**

It was in the feature whose whole purpose is stopping somebody who *already knows the password*. A six-digit code
with unlimited attempts is a million guesses against a door that stays open for ten minutes. The password rate
limiter did not cover it: that limiter is consulted *before* the password is checked, and here the password is long
since accepted.

The test that proved it asked for sixty wrong codes and got sixty answers. It now stops at five.

Two independent guards, because either alone is a single point of failure:

- **The account limiter, keyed by the practitioner** rather than by the challenge — so re-entering the password for
  a fresh challenge does not hand an attacker a fresh allowance. In a bucket of its own, so a person fat-fingering
  a code does not lose the password path they would use to start again.
- **`login_challenge.attempts`**, which lives on the challenge and therefore survives a swapped-out limiter: five
  wrong codes and the challenge is destroyed. A deployment that injects no limiter at all still cannot be walked.

`test/security.test.js` asserts the property rather than the mechanism — *the number of free guesses is bounded* —
and leaves which guard does the bounding free to change.

### 2. Two script tags hand-rolled what the escaping helper exists for — **fixed**

`jsonTag` exists for one purpose and its own comment says so: JSON inside an HTML script element has exactly one
dangerous sequence, and it escapes it. Two call sites built their own `<script type="application/json">` with a
bare `JSON.stringify`.

Nothing there could contain a `<` today — the ids are generated and the wrappings come from this product's own
crypto — **but a defence that holds only because nothing yet writes the dangerous character is a coincidence, not
a defence.** Both now go through the helper, and a grep for the hand-rolled shape returns nothing.

### 3. No security headers at all — **fixed**

Three of the four added are specific to this product rather than general hardening:

- **`Referrer-Policy: no-referrer`** — a client's URL *is* a credential: `/r/<token>` and nothing else
  authenticates them. Without this, any outward navigation from that page hands the token to whoever is linked to.
  There are no outbound links today; a policy that depends on that staying true is not a policy.
- **`X-Content-Type-Options: nosniff`** — an uploaded envelope is served as `application/octet-stream` precisely so
  a browser cannot decide it is HTML. This is what tells the browser not to second-guess that.
- **`X-Frame-Options: DENY`** — the buttons on these pages are "close this request", "remove this member" and "turn
  two-factor off". Clickjacking a practice into switching off its own second factor is cheap, and so is the answer.
- **`Cross-Origin-Opener-Policy: same-origin`** — nothing here opens a window or embeds a frame.

They ride on every response type — pages, JSON, CSV and served documents — not only on the ones that render HTML,
because the document response is the one a browser could most easily be persuaded to misinterpret.

### 4. No Content-Security-Policy — **deliberately not done, and here is why**

This is the honest one. The pages are built from inline `<style>` and small inline `<script type="application/json">`
blocks, so a policy strict enough to be worth having needs a **per-response nonce threaded through every rendering
path**. That is a real piece of work rather than a header, and adding a weak policy so that one can be said to exist
would be worse than none: `unsafe-inline` in a CSP is a claim that a page is protected when it is not.

**What it would take**: `page()` is already the single function every response's markup passes through, so the
nonce has one natural home. The work is threading it into the four places that emit inline `<script>` or `<style>`,
then a test asserting the nonce in the header matches one in the body and that no inline script lacks it. Worth
doing before a hosted launch, where the pages sit on a public origin; less urgent self-hosted behind TLS.

### 5. Platform sign-in walked around the second factor — **fixed**, and found by accident

Found by asking a navigation question, of all things: while checking that every gateway page had a way onward, the
question *"what happens if this person has a second factor?"* had no answer in the code at all.

The gateway's platform sign-in verifies the registry password and then **bridges** — it mints a session *inside the
practice's own database* and hands back the core's cookie, so the workspace pages find the person they expect. That
bridge called `createSession` directly. It never asked whether the practice had a second factor armed.

So: **a practice with TOTP enabled could be entered without a code by signing in at the platform rather than at the
practice's own sign-in page.** Two-factor exists to stop somebody who already knows the password — that is its entire
threat model — and a second door that does not ask defeats it completely, because the attacker simply uses the front
door. Same shape as the unbounded-code finding in §1: the feature was implemented correctly and one path around it was
missed.

**The fix, and why it is this one.** When the practice's member has a second factor armed, **no session is minted by
the bridge.** The platform session still exists — the dashboard and the billing pages need it — and the person is sent
to the dashboard with a sentence saying what to do:

> *You are signed in here. Your practice asks for a code from your authenticator, so open your workspace and sign in
> there to enter it.*

The alternative was to teach the gateway the core's challenge flow: a challenge row, a code page, verification, a
recovery path. That is a **second implementation of the one thing in this product that must not be got wrong**, and
this project has already paid three times for keeping two copies of one rule. Not asking is smaller, and cannot be
wrong.

`test/gateway.test.js` arms a second factor inside a hosted practice's own file and then signs in at the platform,
asserting the redirect, the absence of a `tickmark_session` cookie, the presence of the SaaS session, and the sentence
on the dashboard.

**What this costs, stated rather than discovered.** A practice with a second factor now has two sign-ins rather than
one: the platform login gets them to the dashboard and billing, and the practice's own sign-in gets them into their
documents. That is more steps for the most security-conscious customers — and the alternative is a second factor that
does not stop the attack it exists for.

## What was checked and found sound

Recorded so the next audit does not have to redo it:

- **SQL injection: none.** Every value is a bound parameter. The SQL that varies — the `WHERE` clause in
  `progressRows` and `outstandingRows` — takes its text from a **closed set of hard-coded strings** in the calling
  functions and its values as bound parameters, so no request data reaches the statement text. The only string
  interpolation into SQL is `pragma_table_info('${table}')` in the migration, where `table` comes from a hard-coded
  list, and a migration that inserts a list of column *names* which is also hard-coded.
- **Path traversal: none.** The asset route resolves a name against an allow-list *before* joining it to a
  directory, so the join can never see anything a person did not type into the source. Uploads are stored under an
  id this process generates, and a client's filename is never used to build a path.
- **XSS: none found.** The template literal escapes by default. Every `raw()` call was read individually: three are
  literal script tags, several are boolean attributes (`checked`, `disabled`, `aria-current`), one is the
  stylesheet, and the rest are JSON through the escaping helper.
- **A passphrase or private key reaching the server: none.** A grep for `passphrase` across `src/` returns labels,
  comments and page copy, never a value. The server receives a public key and a *wrapped* private key.
- **Secrets in logs: none.** Nothing logs a token, a password or a key.
- **Sessions:** 256-bit tokens stored as digests, `HttpOnly`, `SameSite=Lax`, `Secure` unless an operator
  explicitly opts out for a local trial (`TICKMARK_INSECURE_COOKIES`).
- **CSRF:** `SameSite=Lax` means a cross-site form post does not carry the session cookie, which covers the
  state-changing routes — all of which are POST. **No GET route changes anything that matters**: the one write on a
  GET is the `file.opened` audit entry, which is a log line rather than a state change. An `Origin` check would be
  belt-and-braces and is not there.
- **Rate limiting** on the password path, per account rather than per address — deliberately, so that an attacker
  behind a reverse proxy cannot lock a whole practice out of its own software.
- **No dependencies at all**, so there is no supply chain to audit: `package.json` has empty `dependencies`.

## Known gaps, stated rather than discovered

| Gap | Why it is not fixed | How bad |
| --- | --- | --- |
| **No CSP** | Needs a per-response nonce threaded through four rendering paths — work, described above | Medium on a public origin, low self-hosted |
| **Sign-up reveals whether an address has an account** | A returning user needs to be told, and the alternative — emailing a link — needs a mailer the product may not have | Low. A stranger can learn that a given address uses Tickmark. On a self-hosted install there is nobody to enumerate |
| **No rate limit on sign-up** | Each signup creates a real directory in hosted mode | Low — resource use rather than access, and `pending_payment` tenants cannot sign in |
| **An operator can turn two-factor off** by editing the database | They run the server and can read everything about an account anyway. Said on the page rather than left to be found | By design. What they cannot do is read documents |
| **No signed releases or reproducible-build attestation** | The Dockerfile copies source and there is nothing to build | Low today; worth having before distributing binaries |

Two of these are worth doing before a hosted launch rather than before a self-hosted one: **the CSP**, and
**email-verified sign-up** — which fixes the enumeration leak and gives the hosted product a way to reach a
practice that has lost its password.

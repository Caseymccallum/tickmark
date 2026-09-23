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

### 4. No Content-Security-Policy — **fixed at last**, and here is how it landed

This is the honest one. The pages are built from inline `<style>` and small inline `<script type="application/json">`
blocks, so a policy strict enough to be worth having needs a **per-response nonce threaded through every rendering
path**. That is a real piece of work rather than a header, and adding a weak policy so that one can be said to exist
would be worse than none: `unsafe-inline` in a CSP is a claim that a page is protected when it is not.

**What it would take**: `page()` is already the single function every response's markup passes through, so the
nonce has one natural home. The work is threading it into the four places that emit inline `<script>` or `<style>`,
then a test asserting the nonce in the header matches one in the body and that no inline script lacks it. Worth
doing before a hosted launch, where the pages sit on a public origin; less urgent self-hosted behind TLS.

**Landed afterwards**, with the trade paid rather than avoided. Every page now carries
`default-src 'none'` with a **per-response nonce** blessing the one inline style block and the one
inline script; `script-src 'self'` covers the browser-side modules; `frame-ancestors 'none'` joins the
`X-Frame-Options` it was going to replace. No `unsafe-inline` anywhere. The nonce is minted and stamped
in `sendPage` — the one seam every page already passes through — instead of being threaded through
sixty render sites, which is how nonces get forgotten. The two things a nonce cannot bless were removed
from the product entirely: thirteen inline `style="width: …"` attributes became classes in
`src/style.js`, and the two inline `onclick` handlers became one nonced script plus a data attribute.
`tools/check-pages.mjs` now fails any rendered page that reintroduces any of the three, and
`test/csp.test.js` holds the header to its own markup.

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

## The second pass: ten findings from a fresh full-codebase audit

A whole-repo review (every file in `src/`, `src/tenancy/`, `web/`, `tools/` and the tests) found ten things the five
above did not. All ten are addressed, and each fix has a regression test — `test/hardening.test.js`,
`test/account.test.js`, `test/two-factor-flow.test.js` or `test/ratelimit.test.js` — that fails against the code as
it was.

| # | Finding | What was done |
| --- | --- | --- |
| 1 | **CSV formula injection.** `csvCell` exported attacker-chosen text — a client's name, a filename a client typed — that began `=`, `+`, `-` or `@`, which a spreadsheet executes when the bookkeeper opens the export | Cells that begin like a formula are prefixed with an apostrophe, the standard mitigation (`src/views.js`) |
| 2 | **Host-header poisoning of links inside emails.** `originOf` trusted `Host`, and a *client's* action builds the link that goes into the practice's notification email — so a link holder could stamp `Host: evil.example` on an upload and poison the practice's next click | `TICKMARK_PUBLIC_URL` wins over both headers whenever it is set; the header fallback remains because a local trial has no canonical address (`src/app.js`, `.env.example`) |
| 3 | **No rate limit on sign-up** — the one unauthenticated endpoint that costs a scrypt hash per hit (64 MiB, ~100 ms) and creates rows. On both the core and the platform door | Two buckets per attempt — the address and the caller — and every attempt counts, successful ones included (`signUp`, `handleSignup`) |
| 4 | **The two-factor management actions had no guess budget.** Turning 2FA off and minting recovery codes would accept unlimited codes for the life of a session — a stolen session played for permanence | The sign-in limiter now bounds them too, in a bucket of their own so a fumbled sign-in code cannot lock the account page (`codeAuthorises`) |
| 5 | **A malformed cookie took every page down.** `decodeURIComponent('%ZZ')` throws a `URIError`, and cookie parsing runs before every route | An undecodable value is kept raw; it matches no token and the request reads as signed out (`src/auth.js`) |
| 6 | **The tenancy fallback password record was a guessable placeholder** (`scrypt$N=2,…$AAAA$AAAA` verified against *some* short password) | A random salt and a random 32-byte target under the real cost parameters (`UNVERIFIABLE_PASSWORD_HASH`, `src/tenancy/registry.js`) |
| 7 | **Removed members kept being emailed about clients.** `requestOwner` answered with the request's creator forever, so removal stopped their sessions but not their inbox | A removed creator is passed over for an owner, then any member (`src/store.js`) |
| 8 | **A client link had no throttle on writes.** Messages and "I do not have this" were bounded in bytes but not in count | 30 writes a minute per link, refused with a sentence rather than dropped (`clientWriteAllowed`) |
| 9 | **An invitation could be claimed twice under a race** — the consume was unconditional and came after the rows it protected | The claim is conditional (`AND used_at IS NULL AND revoked_at IS NULL`) and made *before* anything is created (`src/store.js`) |
| 10 | Assorted: a dead `'check-clear'` guard name that could never match an action, `/assets` responses missing `SECURITY_HEADERS`, a stray expression left beside `FAVICON` | All fixed |

Alongside them, the audit's five missing capabilities are now built: **changing a password and an address** from
the account pages (each costing the current password — and a password change ending every other session, which is
the point of changing one), **taking an invitation back before it is used** (`invite.revoked_at`, a status like
every other end-of-life column here), **an email to the owners when a key is added or the membership changes** —
the *detection* half of the key-hijack story in `src/totp.js`, which nothing in the interface could ever show — and
**the sessions page**: where the account is signed in, sign one out or all the others. In hosted mode a credential
change is mirrored to the platform account through the same injected seam the link recorder uses, so one password
stays one password (`onCredentialChanged`).

Three performance fixes went in with them: uploads and downloads **stream** to and from disk instead of through
memory (the per-file ceiling used to be a memory ceiling times every concurrent client), `clientSummaries`
aggregates in two grouped joins rather than four correlated subqueries per client, and expired sessions and
half-finished sign-ins are swept at open. The documents list — the one list that grows without bound — now pages.

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
| **Email-verified sign-up does not exist** | A returning user needs to be told they have an account, and the alternative — emailing a link — needs a mailer the product may not have | Low. A stranger can learn that a given address uses Tickmark. On a self-hosted install there is nobody to enumerate |
| **`/healthz` is unauthenticated** and names the version and one count | It is the one address an operator can reach when *sign-in is the thing that is broken*, and a health check that requires the broken thing is a health check that lies. The count carries no names | Low |
| **An operator can turn two-factor off** by editing the database | They run the server and can read everything about an account anyway. Said on the page rather than left to be found | By design. What they cannot do is read documents |
| **No signed releases or reproducible-build attestation** | The Dockerfile copies source and there is nothing to build | Low today; worth having before distributing binaries |

The last of these worth doing before a hosted launch is **email-verified sign-up** — which fixes the enumeration leak and gives the hosted product a way to reach a
practice that has lost its password.

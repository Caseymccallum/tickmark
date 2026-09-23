# Reporting a vulnerability

**The honest position first: this is an early project maintained by one person.** There is no security team, no
rotation, no 24-hour acknowledgement and no bounty. What follows is a real channel and a real set of expectations
rather than the shape of a programme that does not exist.

## How to report

**Use GitHub's private vulnerability reporting** — the repository's **Security** tab, then **Report a
vulnerability**. That opens an advisory only the maintainer can read, which is the entire reason to use it instead
of an issue: an issue is a description of how to attack a self-hosted install, published before a fix exists.

If that form is not available on the copy you are looking at (this is AGPL software, so copies exist), open an
issue that says **only** that you have a security report and how to reach you. Put the detail nowhere public.

**Please do not** test against an installation that is not yours. Every install of this holds some practice's
clients' documents, and a scan is not a proof of concept. A quickstart instance you started yourself is the right
place, and `README.md` is one command.

## What to expect

| | |
| --- | --- |
| An acknowledgement | days, not hours |
| An assessment | whether it is a vulnerability, what it affects, and how bad it is — in the same plain terms `docs/security.md` uses |
| A fix, or a written reason not to | If the answer is "that is a known limit, recorded in `docs/encryption.md`", you will get the link rather than a dismissal |
| Credit | in `CHANGELOG.md` and the advisory, under whatever name you ask for — including no name |

There is **no bug bounty**. This is free software with no revenue behind it, and a promise of payment that could
not be kept would be worse than saying so.

## Read these two first, because they may already answer it

`docs/security.md` states every security claim the product makes **and how each one is checked**. `docs/encryption.md`
states what is encrypted **and what deliberately is not**. Findings of the second kind are recorded there as limits
rather than oversights, which means they are not news — but a *demonstration* that one of them is worse than
described absolutely is.

Known and accepted, all with their reasoning written down:

- **The operator can read the metadata** — which client, which request, which item, the filename, the size of the
  envelope, and when it arrived. Running the workflow requires it.
- **A weak passphrase can be attacked offline** by whoever obtains the wrapped key. 600,000 rounds of
  PBKDF2-SHA-256 is the defence, and it is the only one that exists.
- **A lost passphrase loses the documents.** Nothing can recover or reset it, by design.
- **The server cannot tell which practice an envelope was addressed to**, because telling would mean being able to
  open it.
- **A compromised browser reads everything** — an extension, injected script, or an operator who serves the page.
  The claim is about the server, not about either machine.
- **An invitation link that reaches the wrong person makes that person a member**, once, before it expires.
- **Anyone holding a client's link can upload.** Encryption says nothing about who is holding the other end.

## What is most certainly in scope

Roughly in the order they would matter, and the first one is why this file is worth reading rather than skimmed:

- **Anything that moves decryption to the server, or the key to the server** — an upload path that stores plaintext,
  a page that encrypts to a key the server chose or can use, a route that accepts a passphrase, or a way to make an
  unwrapped key exportable in a page. The central claim is that the server stores bytes it cannot read; a way to
  break that is the most serious finding this project can receive.
- **One practice reading another's records**, self-hosted or through the multi-tenant gateway (`MULTI_TENANT=1`).
  Every query is meant to be scoped by practice rather than checked beside it, and a place where that is not true is
  both a bug and a demonstration.
- **Authentication and sessions** — sign-in, the second factor *and every way around it* (a previous finding was
  exactly that: the platform sign-in bridge minted a session without asking for a code), recovery codes, invite
  claims, session revocation, and the password and credential paths.
- **Escaping and injection** — a way to get markup or script into a page, an email, a CSV or a served document, or
  to defeat the Content-Security-Policy's per-response nonce.
- **The hand-written protocol code**, which is where a memory of a specification is most likely to be wrong: the
  SMTP client in `src/mailer.js` (against `node:net` and `node:tls`), the body and multipart parsing in
  `src/http.js`, and the ZIP reader.
- **File handling** — a path that escapes `blobs/`, a stored envelope that is not what its header claims, or a size
  limit that can be exceeded rather than refused.
- **The container and its defaults** — a file served that should not be, a permission wider than the README says, or
  a secret written to a log.

**Out of scope**, because a report here would be answered with one of the links above: anything requiring an attacker
who already has the operator's shell or database; a denial of service by volume; missing headers on a local trial
served over plain HTTP; anything that needs an unpatched Node runtime (the floor is 24, and `docs/mvp.md` records
why); and the limitations listed above.

## Supported versions

**The tip of `main`, and the latest tag.** There are no backports and no long-term branches: there is no dependency
tree to patch, an upgrade is `git pull` followed by reading the lines the server prints, and a fix goes into the next
release rather than into a parallel branch that would have to be maintained and tested. `CHANGELOG.md` says what
changed; `docs/operations.md` says how to upgrade and what a restore means.

## One thing worth knowing about this codebase

**Every security claim in `docs/security.md` is paired with the test that attacks it or the reading that backs it.**
If you think a claim is false, the fastest way to settle it is to make that test fail — and a pull request that adds
the failing test is a more useful report than a paragraph describing one, whether or not you also have a fix.


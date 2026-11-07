# R1 operator qualification — email, configuration, backup

**Status:** the parts marked *verified here* were run in this milestone on Node 24.22.1 and 26.5.0, on Windows, against
fictional data. Everything marked *unverified* needed a credential, a host or a network this milestone did not have, and
is written as a procedure for whoever holds them. Nothing here claims a result that was not observed.

---

## 1. Email delivery

### What is verified here

| Claim | How | Result |
| --- | --- | --- |
| The SMTP client speaks the protocol and handles TLS | `test/mail-tls.test.js` against `test/smtp-relay.js`, a hand-written local relay | pass |
| A refused message is reported rather than swallowed | `test/mail.test.js` — a relay that rejects at `RCPT TO` | pass |
| The message body is plain text *and* a styled copy | `test/html-mail.test.js` | pass |
| A practice with no relay is told so, and gets no button that would fail | `test/r1-surfaces.test.js`, `test/mail.test.js` | pass |
| An operator can watch a session by hand | `tools/smtp-transcript.mjs` | present, not run against a real relay |

### What remains unverified

**A real relay has never carried a Tickmark message.** No credentials were available and none were requested. So these
are unproven, and each is a real way a beta fails on day one:

1. STARTTLS against a real server, with a real certificate chain.
2. `AUTH PLAIN` and `AUTH LOGIN` acceptance, and what the server says when the password is wrong.
3. A message the provider *accepts* and then bounces asynchronously — the common case for a mistyped client address.
4. Provider-side rate limits and per-day caps.
5. Whether the styled copy renders in Outlook desktop: the one client everybody has and nobody tests.

### The qualification run, when a relay exists

Once, with a fictional practice, before any real client address is used:

```
TICKMARK_SMTP_HOST=…  TICKMARK_SMTP_PORT=587  TICKMARK_SMTP_USER=…  TICKMARK_SMTP_PASS=…
TICKMARK_SMTP_FROM="Tickmark <tickmark@your-domain.example>"

node tools/smtp-transcript.mjs --to you@your-domain.example
```

Then the product paths: an opening message, a reminder, and an invitation. Record for each: accepted or rejected, the
provider's queue id, time to delivery, whether the plain part and the styled part both arrived, and whether the link
works. **A message that is accepted is not a message that was delivered** — check the mailbox, not the transcript.

### DNS, before the first real send

| Record | What it must say | Why it matters here |
| --- | --- | --- |
| SPF | the relay's sending hosts are authorised for the From domain | without it the first real send is likely junked |
| DKIM | the relay signs; the public key is published | it is what survives forwarding |
| DMARC | `p=none` to start, with a reporting address | you cannot fix what you cannot see |
| PTR | the sending IP resolves to a name in your domain | some providers refuse otherwise |

Send from a **subdomain** (`tickmark.your-domain.example`) so a reputation problem cannot reach the practice's own mail.

### Bounces and complaints

Tickmark does not parse bounces, and this milestone did not add that. An address that bounces is therefore discovered by
the practice noticing a client did not reply — the failure mode the product exists to reduce. Until a bounce path
exists: use a relay with a suppression list and read it, treat "link never opened **and** email bounced" as a wrong
address rather than a lazy client, and treat any complaint as stop-and-investigate.

### Secrets

The SMTP password belongs in the environment or an env file readable only by the service user — never in the data
directory, never in a backup, never in a support transcript. `tools/smtp-transcript.mjs` redacts the `AUTH` line; check
that it did before pasting a transcript anywhere.

---

## 2. Production configuration review

Reviewed against `Dockerfile`, `docker-compose.yml`, `.env.example`, `src/app.js` and `docs/operations.md`. Findings
that needed a change are marked **fixed**; the rest are statements about what is already correct, with the one item that
is a decision rather than a defect called out.

| Area | State | Note |
| --- | --- | --- |
| TLS | terminated at the proxy, as documented | the app must not be exposed directly; `x-forwarded-proto` is honoured for links |
| Public URL | `TICKMARK_PUBLIC_URL` | **now load-bearing for CSRF** (R1). A malformed value falls back to the request's own headers rather than refusing every form; a proxied deployment should set it |
| Cookies | `Secure` unless `TICKMARK_INSECURE_COOKIES` | the opt-out is for a local trial over http and should never be set in production |
| Persistent storage | `data/` volume holding the database **and** `blobs/` | a volume with only the database is a restore that delivers nothing |
| Blob paths | absolute (`upload.storage_path`) | restoring to a different directory needs the rebase statement now in `docs/operations.md` |
| Container user | non-root | verified in the `Dockerfile`; not run in this milestone (no Docker available) |
| Health check | `/healthz` | **minimal in hosted mode now** (R1): `{ok:true}` only, and it still touches the database |
| Access log | one JSON line per request, `/healthz` excluded | bearer-link paths are redacted; observed in the restore drill's output |
| Rate limits | per account on the password path | deliberately not per address, so one attacker cannot lock a practice out of its own software |
| Storage ceilings | per file, per request, per practice | enforced server-side; a client cannot raise them |
| Backups | `tools/backup.mjs` + `--verify` | verify is not optional: manifest checksum, database checksum, and every `upload` row checked against the blob directory |
| Reconciliation | `reconcile-uploads`, `finalize-deletions`, `reap-pending-tenants` | present; the last two gained their first tests in R1 |
| Update and rollback | forward-only migrations | restore the backup taken in step one — which is why step one is first |
| Export and offboarding | `export-tenant`, `offboard-tenant`, `verify-tenant-export` | present; not exercised in this milestone |

**The decision, not the defect.** Tickmark has no startup check that refuses to boot when `TICKMARK_PUBLIC_URL` is absent
in a non-local deployment. Adding one was considered and not done: the app cannot tell a LAN trial from a public host,
and refusing to start on a first run would be worse than a warning. The recommendation for the next milestone is a
**single log line at boot** naming the configured public URL, or saying it is unset and will be taken from the request —
quiet, and enough to spot the mistake in the first ten lines of a log.

---

## 3. Backup and restore checklist

Proven end to end by `docs/reviews/evidence/r1-restore-drill.mjs` — **12 of 12 checks**, fictional data, temporary
directories, removed afterwards. Run it yourself:

```
node docs/reviews/evidence/r1-restore-drill.mjs
```

**Nightly, on another machine:**

- [ ] `node tools/backup.mjs --data <data> --to <elsewhere>/<date>` exits 0
- [ ] `node tools/backup.mjs --verify <elsewhere>/<date>` exits 0 — *in the same job*
- [ ] the backup is off the machine before the next one is taken
- [ ] there is room on disk for two backups at all times

**Quarterly, on a copy:**

- [ ] move the live data directory aside (never delete it)
- [ ] copy the backup's contents into a data directory, keeping the layout
- [ ] if the path differs, run the rebase statement in `docs/operations.md`
- [ ] start the server; migrations report themselves
- [ ] sign in, open a request, **decrypt one document** — the only end-to-end proof
- [ ] run the drill and see 12/12

**Still unverified:** an off-site restore from real remote storage (no Restic repository and no paid account were
created, deliberately), consistency during a key rotation that overlaps a backup, and recovery from a backup taken
*while* an upload was in flight. The manifest checksum would catch a torn database; a half-written blob would surface as
a decryption failure at step 5 rather than as silence — the right failure, but untested.

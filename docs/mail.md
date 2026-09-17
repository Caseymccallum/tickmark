# Sending reminders

Tickmark drafts a reminder without a mail server. Set two variables and it sends them too.

> **The short version.** Point `TICKMARK_SMTP_URL` at **your existing mail provider's relay**, not at
> the machine Tickmark runs on. Put an address your provider lets you send from in
> `TICKMARK_MAIL_FROM`. Restart. The reminder page grows a Send button, and the practice stops
> copying anything anywhere.

```
TICKMARK_SMTP_URL=smtp://user@example.com:your-password@relay.example:587
TICKMARK_MAIL_FROM=Tickmark Practice <office@practice.example>
```

## Why a relay, and not sending directly

This is the part that has nothing to do with code. A message sent straight from a self-hosted server
to a client's mail provider will usually be filed as spam if it arrives at all, because the machine
has no sending reputation, no SPF record, no DKIM signature and no feedback loop. That is a
reputation problem, and no amount of careful SMTP gets around it.

Using **the provider the practice already sends mail with** as a relay solves all four: the
reputation is already earned, the SPF and DKIM records already exist, and bounces already go
somewhere somebody reads. This is why the configuration is a URL with credentials in it rather than a
built-in mail server.

If a relay is not available, `docs/roadmap.md` records the alternative honestly: don't set these
variables, and Tickmark keeps drafting reminders for you to send from wherever you normally do.

## What it sends

Plain text, UTF-8, `Auto-Submitted: auto-generated` so a well-behaved out-of-office does not answer
it. Non-ASCII subjects are RFC 2047 encoded words, so a subject in any language survives. The body is
base64 with CRLF line endings, which needs no extension from the server.

**The reminder carries a fresh link**, because the original is not recoverable — only its digest is
stored. Every send therefore issues a new one, which also means a link the client lost works again.

| Variable | Required | What it does |
| --- | --- | --- |
| `TICKMARK_SMTP_URL` | yes, to send | `smtp://user:pass@host:port` — STARTTLS when offered. `smtps://` is TLS from the first byte |
| `TICKMARK_MAIL_FROM` | yes, to send | The sender, as `Name <address@host>` |
| `TICKMARK_SMTP_TIMEOUT_MS` | no, default 20000 | How long to wait on the relay before calling it a failure |
| `TICKMARK_SMTP_INSECURE` | **only for a relay on this machine** | Accepts any certificate, and allows a password to be sent to a server that offers no encryption |

Setting both URL and sender is required: with only one of them, Tickmark refuses at startup and says
which is missing, rather than silently drafting instead of sending. With neither, drafting is normal
and the pages say so.

Credentials are percent-encoded in the URL, so a password containing `@` is `%40`. The startup log
prints the relay's host and port and **never** the password.

## When something goes wrong

A send either works or it fails, and **a failure is never silent**. The practice gets a page with the
relay's own words in it — `the recipient (client@example.com): 550 5.1.1 no such user` — their text
still in the fields, and the attempt in the request's history as `reminder.failed`. There is no queue
and no retry: a reminder that failed is one a person can see and send by hand, which is worse than a
quiet retry and much better than a message that vanished into a queue nobody watches.

Every send is recorded, succeeded or failed:

```
reminder.drafted  2 still outstanding
reminder.sent     to accounts@northwind.example (<id@practice.example>)
reminder.failed   to accounts@northwind.example — the recipient (...): 550 5.1.1 no such user
```

The identifier is shown on the page the practice lands on, because "did it actually go?" deserves an
answer that can be quoted to a mail provider.

**A reminder with no link in it is sent, and the practice is told.** The message is editable — it is
their message — and if they delete the link the client has nowhere to send anything. Tickmark does not
refuse: it sends what they wrote, and the page says plainly that the client cannot act on it. That is
the same rule as the rest of the product: the words are the practice's decision, and the consequences
are stated rather than hidden.

## What is not covered here, and why

**The TLS paths are not exercised by the test suite.** Testing STARTTLS and implicit TLS needs a
certificate; generating one needs a tool this machine does not have, and a certificate fetched from
the internet does not belong in a repository. What *is* tested: the client asks for STARTTLS when the
server offers it, a handshake that fails produces a clean error naming the step, the certificate is
required unless `TICKMARK_SMTP_INSECURE` says otherwise, and a password is never sent to a server that
offers no encryption. The first real relay will exercise the rest — so if you set this up, watch the
first send rather than assuming.

**Document tests cannot replace a real inbox.** A conformance kit proves the conversation is what SMTP
asks for. It cannot prove a message arrives, and it cannot prove it does not land in spam, because
both of those are properties of the receiving provider rather than of the message.
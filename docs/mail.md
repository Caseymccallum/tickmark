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
| `TICKMARK_SMTP_CA_FILE` | no | A PEM file of extra trusted CAs, for a relay whose certificate comes from your own authority |
| `TICKMARK_SMTP_INSECURE` | **only for a relay on this machine** | Accepts any certificate, and allows a password to be sent to a server that offers no encryption |

Setting both URL and sender is required: with only one of them, Tickmark refuses at startup and says
which is missing, rather than silently drafting instead of sending. With neither, drafting is normal
and the pages say so.

**If your relay's certificate comes from your own authority** — an internal mail server, a corporate
relay, one you run yourself — set `TICKMARK_SMTP_CA_FILE` to that authority's PEM file. This exists so
that trusting one CA does not require `TICKMARK_SMTP_INSECURE`, which turns verification off for
everything. Trusting one named authority is strictly safer than trusting anything, and a path that
cannot be read is reported at startup with the path in it rather than as a failed send later. The
startup log line says `with your own CA` when it is in use.

Credentials are percent-encoded in the URL, so a password containing `@` is `%40`. The startup log
prints the relay's host and port and **never** the password.

## Testing it

Signed in, there is a page at **`/admin/test-email`** — an address field and a button, deliberately
off the navigation because it is a setup tool rather than part of the day's work. It sends one
plain-text message through the configured relay *exactly the way a reminder is sent*, so a success
there is a relay a reminder will work with. When it fails, the page shows the step that failed and the
relay's own reply — `550 5.1.1 no such user` is quotable to a mail provider — with one sentence
naming which of the four usual causes it was: the credentials, the port, the firewall, or the
certificate.

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

## What the tests cover, and what they cannot

**Covered, including the handshake.** `test/mail-tls.test.js` runs the client against a real TLS server
with a certificate from a throwaway CA committed in `test/fixtures/tls/`:

- a message sent over `smtps://`, with the certificate verified;
- a **real STARTTLS upgrade** — a relay that performs the handshake on the socket, so what is asserted
  is that the login and the message arrived *after* the upgrade, not merely that STARTTLS was asked for;
- a certificate the client does not trust being refused, with nothing said to the server at all;
- the same refusal during a STARTTLS upgrade, and **nothing sent afterwards** — the assertion that
  matters most, because a client that failed the handshake and then carried on in the clear would hand
  a password to whoever answered the port;
- a certificate for the **wrong name** being refused.

That last one is worth a sentence of its own. The client sends no SNI when the relay is addressed by IP
address, because Node refuses an IP as `servername` — so a reader could reasonably assume the name check
is skipped. It is not: Node verifies the certificate against the address it dialled, and the test failed
exactly as it should when `rejectUnauthorized` was forced on in a mutation proof.

**Not covered: whether a message arrives, and whether it lands in spam.** A conformance kit can prove
the conversation is what SMTP asks for. It cannot prove delivery or reputation, because both are
properties of the receiving provider rather than of the message. **Watch your first real send** rather
than assuming — set the relay up, send yourself a reminder, and confirm it arrives.

## What a message looks like

The letters that go to **clients** — the opening ask and the reminder — leave as
`multipart/alternative`: the words as plain text, and the same words as an HTML letter with the
practice's name at the top and the link as a button. The plain part is byte-for-byte the text in the
draft; the HTML is a rendering of it that adds no words of its own (see `mailHtml` in
`src/mailer.js`), so "what you see is what gets sent" survives the styling. The notes that go to the
**practice** — the arrival notice, the key-change notice, the test message — stay plain text: a
status note does not need a letterhead.

Email HTML follows email's rules rather than the web's: no scripts, no external anything (most
clients block remote content by default), every style inline, and a table for the frame — because a
good share of financial inboxes render mail with Microsoft Word.

What the conversation looks like on the wire, recorded: `npm run transcript` runs five real sends
against the test double — a plain send with the message exactly as it went out, STARTTLS with the
handshake marked so the login is visibly inside it, `smtps://` from the first byte, the refusal to
send a password in the clear, and a `550` rendered as the sentence a support ticket needs — and
writes them to `tmp-transcript/smtp-transcript.md`.
# Sending reminders by text

The half that talks to the outside world: a gateway the practice points at, and one line-and-a-link
message — built beside `src/mailer.js` and tested against a gateway written into the test. **What is
here is the sender and the words**; the last step of wiring it to the chase — a phone number on each
client, and a text sent beside the email — is recorded as the next thing in `docs/roadmap.md`.

> **The short version.** Point `TICKMARK_SMS_URL` at your SMS gateway's send endpoint (the one your
> provider gives you), put the number texts come from in `TICKMARK_SMS_FROM`, restart.

```
TICKMARK_SMS_URL=https://user:password@api.example.com/2010-04-01/Accounts/abc/Messages.json
TICKMARK_SMS_FROM=+441234567890
```

## What a text says, and what it never carries

One line and a link: who is asking, what is still needed (two documents named, the rest counted), and
the link that opens the request. No greeting, no list, no sign-off — a text is a sentence, not a
letter. `smsReminder` in `src/sms.js` builds it, and a test pins its exact words.

**A text never carries a document.** The link opens the same encrypted portal the email's does, so the
files stay between the client's browser and the practice's key — the same zero-knowledge promise
whatever channel the nudge arrived on. This is why texting fits at all: the channel carries a sentence
and an address, and nothing that was ever a secret.

## Why a gateway, and not this machine sending texts

There is no such thing as a self-hosted mobile network. A text leaves through a gateway your practice
signs up to — Twilio, Vonage, MessageBird, or an SMS API your carrier provides — and that gateway has
the carrier relationships, the sender IDs, the delivery receipts and the consent records that a program
cannot conjure. So the configuration is a URL, exactly like the mail relay: point it at the provider
you already use.

The format is the common one — a `POST` with `To`, `From` and `Body` as a form — which is what Twilio's
`Messages.json` and most others accept directly. A gateway that speaks another way is reached through
the smallest adapter; the shape is all of `src/sms.js`, which is short enough to read in one go.

## The sending number, and consent

Two things the software cannot do for you:

- **The number texts come from** (`TICKMARK_SMS_FROM`) must be one your gateway is allowed to send
  from — a number you own, or an alphanumeric sender ID where the country allows one.
- **Consent.** Texting a client about their documents is a message they asked for as part of the work,
  but the rules on who may be texted are yours to keep. In the UK that is PECR; the practice knows its
  own clients and its own basis. Tickmark holds the number and sends when asked — it does not decide
  who may be texted.

## How it sends, and how it fails

Each text is one form-encoded `POST`, signed in with the URL's credentials (as Basic auth) or a bearer
token. A number that is not a phone number is refused before a message is spent; a gateway that refuses
is reported with its own reply ("401 — Authenticate"), never a bare "the send failed". Like the mailer,
there is **no queue and no retry** — a send either works or it is reported in front of the person who
pressed the button.

| Variable | Required | What it does |
| --- | --- | --- |
| `TICKMARK_SMS_URL` | yes, to text | The gateway's send endpoint. `https://user:pass@…` signs in with Basic auth; a bearer token goes in `TICKMARK_SMS_TOKEN` instead |
| `TICKMARK_SMS_FROM` | yes, to text | The number (or sender ID) texts come from |
| `TICKMARK_SMS_TOKEN` | no | A bearer token, for a gateway that authenticates that way rather than with the URL |
| `TICKMARK_SMS_TIMEOUT_MS` | no, default 15000 | How long to wait on the gateway before calling it a failure |

Setting only one of the two required variables refuses at startup and names the missing one. With
neither, texting is simply off.

## Testing it

`test/sms.test.js` drives the real sender against a gateway written into the test — the request, the
auth, the refusal and the message shape are all asserted against what actually crossed the wire, the
same idea as `test/smtp-relay.js` for mail.
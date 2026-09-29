# The field: Zendoc, and what is worth matching

> A point-in-time read of the nearest competitor, written 29 September 2026 so the reasoning is on
> record. Zendoc is a waitlist product ("Join waitlist", "Launching soon"), so its pricing and
> features will move. The durable part is the analysis: what is worth matching, what is worth
> protecting, and what is worth refusing.

[Zendoc](https://zendoc.ai) is the closest thing to Tickmark that exists — "Stop chasing clients for
documents. Give every client one link to upload files, fill forms, and sign." It is horizontal (law,
accounting, mortgage, HR and more), it is **$149/month flat per firm** (up to 10 people, 50 GB), and
it rests on two headline bets.

## The two bets

1. **SMS document requests.** Requests go out by text as well as email, and the client answers without
   logging into a portal. Zendoc's own comparison pages claim TaxDome and SafeSend have "No SMS" and
   make this their first argument: *email is not where the clients are during filing season.*
2. **AI document review on arrival.** Every upload is read server-side as it lands — wrong document
   type, illegible scan, missing page, expired ID — flagged with a reason, clean files filed
   themselves, exceptions queued, and the follow-up already drafted.

Everything else — a one-link portal, checklists per return type, e-signatures, a CRM, a form builder —
is either table stakes Tickmark already has, or a different product.

## Where each thing stands

| | Zendoc | Tickmark | Reading |
|---|---|---|---|
| One-link client portal | ✅ | ✅ | parity |
| Checklists / reusable asks | ✅ | ✅ + recurring cycle + bulk ask | Tickmark |
| Email reminders | ✅ | ✅ (they name what is missing) | parity |
| **SMS reminders** | ✅ | ❌ | **match — the clearest gap** |
| **Review a document on arrival** | ✅ reads every file server-side | ✅ **in the browser** (`web/preflight.js`) | **match the outcome, refuse the method** |
| **E-signatures** | ✅ | ❌ | gap — see below |
| **Form builder** | ✅ | ❌ | gap — a scope call |
| Accounting-software integration | ❌ ("does not integrate with tax preparation software") | ✅ Xero + QuickBooks | Tickmark |
| **Zero-knowledge (the server cannot read)** | ❌ its AI reads everything | ✅ the product | Tickmark — the moat |
| **Self-hosting / data residency** | ❌ SaaS + subprocessors | ✅ on the practice's own machine | Tickmark |
| Price | $149/mo | £49/mo hosted, self-host free | Tickmark |
| Accounting depth (the season, return types) | generic "matter type" | ✅ | Tickmark |

## What to match, and how

**SMS reminders.** The clearest gap and the clearest customer pain ("clients texted my cell asking
where to send their W-2s"). A text carries a link and a short line — never a document — so it costs
nothing of the zero-knowledge promise. Build it the way mail is built: a relay the practice points at
(`TICKMARK_SMS_*`), hand-written against the gateway, no dependency. *Not yet built.*

**Review on arrival — built here, and deliberately narrower.** Tickmark already checks a file in the
client's own browser before it is encrypted (`web/preflight.js`), because the plaintext is already
there and looking at it costs nobody their privacy. This phase widened that from two checks to four:

- a **password-protected PDF** the practice could not open — *already there*;
- the **same file twice**, by name and size — *already there*;
- a **PDF that stops before its `%%EOF`** — a cut-off scan: the "missing pages" case;
- a **photo too small to read** (below `MIN_READABLE_SIDE` on its short side) — the "illegible scan"
  case, judged from the pixel size in the file's header rather than from a word of the image.

All four **warn, never refuse**, and all four read a file the browser already holds. None of them
needs the server to see a byte. That is the whole answer to a competitor whose review works *because*
their systems open every document.

## What to protect — not for trade

- **Zero-knowledge.** Zendoc's review works because their systems read every client's financial
  document. "Never trained on your files" still means *read*. For a practice holding client bank
  statements and tax returns, **"we cannot read them" beats "we read them but do not train on them."**
  This is the product; no feature is worth trading it.
- **Self-hosting / data residency.** Zendoc is SaaS with a subprocessor list and a DPA. Tickmark runs
  on the practice's own machine. For a UK accountant under ICO/GDPR this answers a question Zendoc
  cannot.
- **Accounting-software integration.** Zendoc concedes it integrates with no tax-prep software and
  advertises no accounting one. Tickmark already syncs Xero and QuickBooks.
- **Price and narrowness.** Cheaper, self-hostable, and built for accountants rather than for every
  profession that collects a document.

## What to decline, and to say out loud

Zendoc's review also does what no honest client-side check can: *semantic* judgement — "this is a pay
stub where a W-2 should be", "this ID expired in March". Both need a machine that reads the document,
and the only way to have one read it is to hand it over, which is the trade this product exists to
refuse. So this is **not** a missing feature to schedule; it is the line. The browser catches what is
wrong with the *file* and never comments on what is inside it. If a document ever has to be read, the
answer is an explicit, opt-in, per-document choice — the shape the books-behind signal already takes —
never a quiet model behind the upload button.

## Still genuinely missing

Filtering for what Zendoc has that Tickmark lacks and that a practice would want: **SMS**, **a
signature**, **a form builder**. That is the whole list.

- **SMS** — build next (above).
- **A signature** — engagement letters are real, and Zendoc, TaxDome and SafeSend all collect them.
  A true legally-binding e-signature is its own regulatory lift (eIDAS). The honest near-term answer
  is "send it back signed" as an upload, which the checklist already allows; real e-signature only if
  practices ask.
- **A form builder** — structured answers (an organiser) rather than free-text notes. A scope call:
  it edges Tickmark toward practice management, which is the narrowness it is winning on. There is a
  reference to borrow from (`plain-forms`, an end-to-end-encrypted forms builder) if it is ever built.

Invoicing, time tracking and return assembly are deliberately absent — and Zendoc does not have them
either; it concedes those to TaxDome and SafeSend. They are a different product.
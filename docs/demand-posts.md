# The posts, ready to send

`docs/verify-demand.md` says how the answers are read. This file is what to actually
paste. Three versions because three rooms read differently, and one short version for a
direct message or a group chat.

**Post them, then record the results in `verify-demand.md`.** A question asked and not
written down becomes an opinion by next week.

## Before posting: three practical things

1. **Reddit treats low-karma accounts as spam.** A first post containing a link is
   frequently removed automatically. Lead with the question, not the product, and put the
   link in a comment only if somebody asks — which they will, and that is a better
   conversation anyway.
2. **Ask in the room's own terms.** r/Bookkeeping talks about "chasing clients for
   documents". r/taxpros talks about "PBC lists". Both are the same thing; only one of
   those phrases is right in each room.
3. **Disclose that it does not exist yet, in the first paragraph.** It is the honest
   version, it is the version that gets real answers rather than polite ones, and it
   heads off the "so this is just advertising" reply.

## Version 1 — r/Bookkeeping and r/taxpros

> **How do you chase clients for documents, and would you run your own server to stop paying for it?**
>
> Not a bookkeeper — I build software, and I'm trying to make sure I'm building the right
> thing before I spend a fortnight on it. So this is a question, not an announcement, and
> nothing exists yet.
>
> Every bookkeeper I've talked to describes the same thing at the end of a season: chasing
> clients for the bank statements, the ID scan, the signed engagement letter — and then
> next January doing the whole list again from scratch. Sometimes with a portal you pay
> for, sometimes with an email thread and a shared drive.
>
> What I'm considering is a small self-hosted tool: you make a checklist of what the
> client owes, send them a link (no account, no app for them), and you see exactly which
> items are outstanding. Files are encrypted in the client's browser before they upload,
> so the server — even if it's a £5 VPS you rent — only ever holds ciphertext. No
> per-request or per-client pricing, because there'd be nothing to charge for.
>
> Before I write it, five questions:
>
> 1. How do you get documents from clients now — email, a paid portal, a shared drive, or
>    in person?
> 2. What actually goes wrong? Chasing, items never arriving, clients re-sending the same
>    thing, photos of paper, requests going stale?
> 3. Roughly how many clients per season is this a problem for?
> 4. What do you pay for it now, if anything — and at what price does it stop being worth
>    it?
> 5. If a tool showed you exactly what was outstanding for each client **but you sent the
>    reminders yourself**, would that be useful, or is automatic emailing the whole point?
>
> And the one I care most about: **what would make you close the tab and never come back?**
>
> Not looking for encouragement — if this is already solved for you, I'd genuinely rather
> know that today.

## Version 2 — AccountingWEB (Any Answers) and UK-facing rooms

Same as above, with the vocabulary of the room and the privacy angle sharpened, because
GDPR and "where does client data live" are live questions there:

> **Would you self-host a document-chasing tool rather than pay per client?**
>
> I'm building (early — nothing shipped) a small self-hosted tool for collecting documents
> from clients: a checklist per client, a link they open without an account, and a clear
> view of what's still outstanding.
>
> The one design decision I'd like a view on: files are encrypted in the client's browser
> to your key, so the server only holds ciphertext, and the whole thing runs on your own
> hardware or VPS rather than ours. For those of you with data-protection obligations to
> clients, is "it never leaves my server, and I can prove the operator can't read it" a
> meaningful advantage, or is it a complication you'd rather not administer?
>
> Also: what do you use now, what does it cost, and what does it get wrong?

## Version 3 — a direct message or a group chat (short)

> Quick question for the bookkeepers here. How do you currently chase clients for
> documents, and what's the most annoying part?
>
> I'm building a small self-hosted tool for it (checklist, link for the client, see what's
> still missing, files encrypted in the browser so the server holds ciphertext). Nothing
> shipped yet — I'm trying to find out whether the chasing is a real problem or just the
> cost of doing business. What do you use, and what does it cost you?

## What a good answer looks like, and what a bad one looks like

Worth knowing in advance so that the result is read honestly:

- **A good answer describes a specific failure**, with a season and a client in it: *"last
  year I had three clients who never sent the bank statements and I didn't notice until
  February."* That is a need.
- **A bad answer is encouragement.** *"Looks great, keep going."* That is politeness and
  it predicts nothing.
- **The most valuable answer is a rejection**, because it saves a fortnight: *"we use
  TaxDome, it's fine, I'd never self-host"* tells you the honest truth about the wedge,
  which is that convenience beats principle for most practices.

## What to do with the answers

Record them in `docs/verify-demand.md` — the posts, the dates, the replies, and the
decision from the table that is already written there. If the answer is no, the decision
is written down before the code exists, which is the entire point of asking first.
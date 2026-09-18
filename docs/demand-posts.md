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

## Which rooms allow this at all — checked, and it changes the drafts

The first version of this file had a draft that opened *"I build software, and I'm trying to
make sure I'm building the right thing."* That is the honest sentence, and it is the exact
sentence two of these rooms ban by name. The rules, quoted from a third-party tracker (Reddit
blocks automated reads; the tracker last verified each of these between May and June 2026):

| Room | What its rules say | Verdict |
| --- | --- | --- |
| **r/Accounting** | *"No self-promotion, advertising, solicitations, or research ideas"* | **Do not post.** "Research ideas" is what this was going to be. |
| **r/Bookkeeping** | *"No self-promotion, advertising, or solicitation. Do not post your own blog, website, app, whatever."* | **Only a product-free question.** |
| **r/tax** | *"Do not post or otherwise link to content intended to benefit any business"* | **Do not post.** |
| **r/taxpros** | Not on the tracker; **check the sidebar before posting** | Probably the same as the others |
| **AccountingWEB Any Answers** | Has software-and-suppliers areas; suppliers are expected to disclose | **The best room for the version that names what is being built** |

**Verify every one of these in the sidebar before posting.** Moderators change rules and
the tracker is not authoritative — twenty seconds each, against an account ban.

The drafts below were written **before** this check, and the check changed them. Recorded here
rather than quietly rewritten, because the same mistake is cheap to repeat: an honest
"here's what I'm building, would you use it?" is the single most rule-breaking shape a
research post can have in a professional subreddit.

What the change means: **in the Reddit rooms, the post must contain no product.** A question
about how bookkeepers work is legitimate discussion, which is what those subreddits are for;
a question about whether they would use *your* thing is research, which is what they ban. The
distinction is not a technicality — the answers are better without the product in them, because
"would you use this?" invites politeness and "what goes wrong?" invites specifics.

The version that names the product belongs in the room built for it: **AccountingWEB**, and
practitioner Facebook groups, where suppliers disclosing what they are working on is normal.

## Version 1 — r/Bookkeeping (product-free, and the only version allowed there)

**No product, no link, no "I'm building".** The question is a real one a bookkeeper would ask,
which is what makes it allowed — and it also gets better answers, because "what goes wrong?"
invites specifics where "would you use this?" invites politeness.

> **How do you chase clients for documents, and what actually goes wrong?**
>
> Not a bookkeeper — I build software, and I'd rather understand how this actually works in
> practice than assume it. Not selling anything, and there's nothing to link to.
>
> At the end of a season, how does a client end up getting you the bank statements, the ID scan,
> and the signed engagement letter? Email thread, a portal you pay for, a shared drive, in person?
>
> What I'm curious about:
>
> 1. **What actually breaks?** Chasing, items that never arrive, clients re-sending the same
>    thing, photos of paper, the same list from scratch next January?
> 2. **How many clients per season** is this a real problem for?
> 3. **What do you pay for it now**, if anything — and at what price would it stop being worth it?
> 4. **Does anyone run their own tooling** rather than paying per-client, and does self-hosting
>    ever actually win, or is it a job you would never take on?
> 5. How do you keep track of what each client still owes you — a spreadsheet, the portal's own
>    list, memory?
>
> And the one I'd most like an answer to: **what would make you give up on a tool for this?**
>
> Not looking for encouragement — if this is already solved for you, I'd genuinely rather know
> that today.

**Then, in the comments, and only if somebody asks:** *"Yes — I'm working on something for this.
Nothing exists yet."* That sentence is fine. Leading with it is what the rule is aimed at, and
it is also what turns a conversation into a pitch.

## Version 2 — r/taxpros (same shape, the room's vocabulary)

**Read the sidebar first.** If r/taxpros has the same ban as its neighbours — likely — use this
product-free shape and not the version below it. The vocabulary is the only change: this is the
room where it is a **PBC list**, not "the list of things we're waiting on".

> **How do you build PBC lists, and what slips through?**
>
> Not an accountant — I build software and I'm trying to understand the practice rather than
> assume it. Nothing to sell, nothing to link.
>
> When you send a client a PBC list, how does it get built — from last year's return, from a
> template, from memory? And how do you track what has come back?
>
> - What slips through most often, and how do you find out — at review, or later?
> - Do you send the list once, or chase it in rounds?
> - Does anything you pay for handle this now, and what does it cost you per year?
> - Has anyone here run a self-hosted tool rather than a subscription, and would you again?
>
> Most useful answer I could get: **what would make you stop using a tool for this?**

## Version 3 — AccountingWEB (Any Answers) and practitioner Facebook groups

**This is the room where naming the product is allowed**, because suppliers disclose there as a
matter of course. Use the version that says what is being built — and disclose it in the first
line, not the last.

> **Would you self-host a document-chasing tool rather than pay per client?**
>
> I'm building something for this — early, nothing shipped, and I'd rather find out now whether
> it is wanted than in three weeks when it is too late to matter.
>
> It is a small self-hosted tool for collecting documents from clients: a checklist per client, a
> link they open without an account, and a clear view of what is still outstanding.
>
> The one design decision I'd like a view on: files are encrypted in the client's browser to your
> key, so the server only ever holds ciphertext, and the whole thing runs on your own hardware or
> a VPS rather than ours. For those of you with data-protection obligations, is "it never leaves
> my server, and I can show a client that I cannot read it" a meaningful advantage — or is it a
> complication you would rather not administer?
>
> Also: what do you use now, what does it cost, and what does it get wrong?

## Version 4 — a direct message or a group chat (short)

A DM to somebody who has already answered in a thread, or a post in a practitioner Facebook
group. Here the product can be named, because you are talking to one person who replied to you.

> Quick question, since you replied about chasing clients for documents — how do you do it now,
> and what's the most annoying part?
>
> I'm building a small self-hosted tool for it (checklist, a link the client opens without an
> account, see what's still missing, files encrypted in the browser so the server only holds
> ciphertext). Nothing shipped yet. I'm trying to find out whether the chasing is a real problem
> or just the cost of doing business — what do you use, and what does it cost you?

## In what order, today

1. **r/Bookkeeping** — Version 1, product-free. **Read the sidebar first.**
2. **r/taxpros** — Version 2, same shape with the room's own words. **Read the sidebar first**,
   and if it bans this the way its neighbours do, skip it rather than risk the account.
3. **AccountingWEB Any Answers** — Version 3, the one that names the product. This is the room
   built for it, and the one where a supplier asking practitioners a question is normal.
4. **Practitioner Facebook groups** — Version 3. Many of these are where bookkeepers actually
   talk to each other, and a disclosed "I'm building this, would you use it?" gets a straight
   answer there.

**Do not post to r/Accounting or r/tax.** Their rules name this exact post.

Adapt the text per room. Identical text in four places is the pattern spam filters and moderators
look for, and it reads as an advertisement in every one of them.

**Then stay in the thread for a few hours.** A question with no replies from its author reads as
an advertisement to the second person who sees it, and the second and third replies are usually
where the specific failures get described.

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
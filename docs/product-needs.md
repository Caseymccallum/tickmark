# What practitioners actually need, and what that makes Tickmark

Researched before building, rather than assumed. Every claim below is sourced, and the sources are
vendors, surveys and practitioner-process guides — which means they are all selling something or
arguing something, and are read as such.

## The finding that matters most

**The gap is not collecting the documents. It is what happens after they arrive.**

The clearest statement of it comes from a firm selling automation to CPA practices:

> "Client documents not ready to prep is not a collection problem. Your collection works. It is a
> translation problem, and almost nothing in your current stack is trying to solve it."
> — [Chronexa](https://chronexa.io/blog/client-documents-not-ready-to-prep)

And the same article on why a portal does not fix it:

> "The email says the client uploaded everything. Your portal agrees. Every file is sitting in the
> right folder, attached to the right job, named more or less correctly. And the return is not one
> step closer to being done. Because somebody now has to open each file, work out what it is, decide
> whether it is the current year, and type the numbers into your tax software. That somebody is
> usually not an administrator. It is a preparer you pay properly, doing work you could describe to a
> temp, in the six weeks of the year when their time is worth the most."

The strongest evidence that portals do not close this: **a document-portal vendor ran an ad that
admitted its customers still chase.** From [Gridex's analysis](https://gridex.dev/blog/why-cpa-firms-lose-time-chasing-client-documents/):

> "In October 2025, ShareFile — a document-portal vendor that sells to accounting firms — ran an ad
> that opened with a question: 'Your accounting firm is still chasing clients for documents and
> emails?' The pitch was for their own software. But read the line again. A portal company, whose
> entire product exists to fix document collection, was leading with the admission that firms already
> running portals are still chasing."

And the sentence that should govern this product's design:

> "A job should flip to ready when the document set is complete, not when files arrive."

with its corollary, which is a rule about honesty rather than about features:

> "A system that hides its uncertainty is worse than none, because it removes the signal that someone
> needed to check."

## The numbers on the chase

From the [Conto guide](https://helloconto.com/client-documents/chasing/), citing its sources:

| Figure | Source |
| --- | --- |
| **69%** of US accountants spend too much time gathering documents from clients | Canopy survey of 150 US accountants |
| **79%** spend too much time tracking down files *inside their own firm* | same |
| **9–12 hours per week** lost to follow-up alone, per practitioner | same |
| **50%** of tax practitioners name "uncooperative clients" their **#1 concern**, above staffing shortages | CPA Trendlines 2024 Busy Season Barometer |
| Manual tracking **breaks down past 50 clients** | Conto |

The arithmetic in that guide is this product's business case in one line: *75 clients × 10 minutes a
week = 12.5 hours a week, across 12–14 weeks, is 150–175 hours a season* — spent not on returns.

## What Tickmark is missing, measured against that

The competitive set here is document-request tools for firms — Infile, Content Snare, Tidyflow,
Suralink — and what they have that Tickmark does not:

| Capability | Evidence | Tickmark |
| --- | --- | --- |
| **A review state** — "outstanding, in-review, completed" per client | Infile's own feature list | **No.** An item is received or it is not. Nothing says whether anybody has *looked*. |
| **A ready-to-work signal** per client | Chronexa: "flip to ready when the document set is complete" | **No.** |
| **Bulk send** — "the same organizer to your entire client list in one action" | Infile; and "breaks down past 50 clients" | **No.** One request at a time. |
| **Templates and recurrence** — "monthly or quarterly cycles without rebuilding" | Infile | **No.** Every request is built from nothing. |
| **Prior-year carry-forward** — "returning clients confirm, not retype" | Tidyflow | **No.** |
| **The client can say why** — "Nothing to upload" / "I'll send this later" | Tidyflow | **No.** A client can send a file or say nothing. |
| **Due dates surfaced**, overdue visible | Conto: "set hard internal deadlines, start in January not March" | **Partly.** A due date is stored and shown; nothing is ever overdue. |
| Passwordless client link; no account for the client | universal | **Yes** |
| Encrypted so the operator cannot read it | **nobody in this set** | **Yes — the only row where Tickmark leads** |

That last row is worth pausing on. Every capability Tickmark lacks is a workflow feature; the one thing
it has that none of them have is the one they cannot buy, because their architecture is a server that
reads your clients' files.

## What this makes the product

The evidence says a practice's real question is not "has this arrived?" but:

1. **Who is blocking the work?** (outstanding, and for how long)
2. **What has arrived that nobody has checked?** (the rework nobody measures)
3. **What is ready for me to start?** (the thing a portal cannot answer)

None of those is answerable from "received / not received". So the product's job is to keep the list
honest in both directions: **received is not ready, and a client's silence is a state too.**

One sentence for what Tickmark should be, narrower than "a client portal":

> **Tickmark is the list of what a client owes you, where "received" and "ready" are different
> things, and where a practice can see which clients are which without opening anything.**

## What this pass built, and what it deliberately did not

**Built** — the three questions above, in the order they cost money:

- **A review state per item**, and the rule that new material clears it.
- **A state per request** — waiting, to check, ready — computed rather than stored, so it cannot drift.
- **A portfolio view**: the requests list answers "who is blocking me" and "what is overdue", and can be
  filtered by state.
- **Start one like this**: a request's list copied into a new one — the smallest honest version of a
  template, and the whole of the year-two pain.
- **The client can say why**: "I don't have this" and "I'll send it later", so the list is honest from
  their side rather than only from the practice's.
- **Chase everyone at once** (2f, below): the ordinary reminder to every client with something
  outstanding, with a page listing exactly who will be written to before anything is sent, a run that
  bounds its own time, and a report naming every outcome.

**Not built, and named rather than implied:**

- **Recurring requests** on a schedule. Depends on a decision about what happens when the schedule fires
  while the previous request is still open, and the research's cadence advice — "reminders escalate
  politely on a schedule you control" — is not the same feature as a monthly cycle.
- **A cadence the run respects.** The run has no memory of who it has already written to: it goes to
  everyone still outstanding, every time. The chase list shows when each client was last reminded, so the
  decision is the practice's rather than a surprise — but "do not remind the same client twice inside a
  week" is a rule this does not have, and a practice that presses the button twice in an hour will send
  two reminders. Named here because the fix is a threshold, and a threshold is a decision.
- **Reading the documents** — extraction, reconciliation, "is this the current year". That is the
  translation problem Chronexa names and it is an OCR-and-AI product. It would also mean sending a
  client's financial records to a third party, which makes this product's central claim false. **Named
  here so it is not proposed in six months as though it were new.**
- **Integrations with Lacerte, UltraTax, Drake, ProSeries.** Also real, also large, and it is how the
  incumbents win firms. Out of scope for a self-hosted tool with no dependencies.

## The one thing to watch, having read all this

The research is unanimous that the fix is *process plus automation* — "the firms that have everything
by April 1st don't have better clients, they have better processes". A tool cannot supply the process.
What it can do is stop the practice from having to remember where each client is, and that is what the
five items above are for.
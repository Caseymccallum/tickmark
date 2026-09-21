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
| **A review state** — "outstanding, in-review, completed" per client | Infile's own feature list | **Yes** (2c). An item is received *and* checked, and those are different words on screen. |
| **A ready-to-work signal** per client | Chronexa: "flip to ready when the document set is complete" | **Yes** (2c). A request is *waiting*, *to check*, or *ready*, computed rather than stored. |
| **Bulk send** — "the same organizer to your entire client list in one action" | Infile; and "breaks down past 50 clients" | **Yes** (2r). One list, one deadline, one action: a request per client, each with its own link, with a report naming every outcome. |
| **Templates and recurrence** — "monthly or quarterly cycles without rebuilding" | Infile | **Templates, yes** (2q) — a named checklist kept and edited. **Recurrence, no** — but the *question it was standing in for* is answered: the clients page names who is due an ask (2u), and *ask everyone* makes the seasonal send one action. |
| **Prior-year carry-forward** — "returning clients confirm, not retype" | Tidyflow | **Yes** (2i). A client's page offers last year's list; `?like=last` fills the form. |
| **The client can say why** — "Nothing to upload" / "I'll send this later" | Tidyflow | **Yes** (2e). Two buttons, and the reason is recorded against the item. |
| **Due dates surfaced**, overdue visible | Conto: "set hard internal deadlines, start in January not March" | **Yes** (2d, 2p). A due date is shown, overdue is computed on the practice's own calendar, and undated requests sort last. |
| Passwordless client link; no account for the client | universal | **Yes** |
| Encrypted so the operator cannot read it | **nobody in this set** | **Yes — the only row where Tickmark leads** |
| Encrypted so the operator cannot read it | **nobody in this set** | **Yes — the only row where Tickmark leads** |

**Updated after Phase 2.** Every row above except recurrence is now built, and the reasons are in
`docs/roadmap.md` under the phase that built it. The paragraph that used to follow this table said that every
capability Tickmark lacked was a workflow feature and the one it had was the one nobody could buy; that is no
longer true, and it is worth saying plainly rather than leaving a sentence that flatters the product standing
next to a table that no longer supports it. It now does both — which is the position a product wants to be in,
and it is the point at which "we have something they cannot copy" stops being a reason on its own.

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
- **A chase cadence the practice sets** (2h, below): how many days must pass before the batch run may
  write to the same client again, defaulting to none. The design decision is the point — the number is the
  firm's, not this software's — and clients the cadence holds back are named in the report rather than
  dropped quietly.
- **Clients as records** (2i, `docs/clients.md`): a directory of everyone the practice asks, with what each
  one still owes and whether they can be written to at all; a client's own page with their history and their
  details, editable, so a typo is a repair rather than a fork. This is where *"who do I work for, and who is
  late?"* finally has an answer that is not the request board read sideways — and it fixed a real bug, in
  which an address typed on a later request was silently discarded, leaving a client permanently
  unreachable by the automated chase with nothing on screen to explain why.

- **A client's own receipt** (2m): the client's page says how many documents they have sent, names each file
  they sent and the day it arrived, and thanks them when the list is complete. It answers *"did you get it?"*
  — the phone call a practice otherwise fields — without a call, from the one place the client already has.
- **Finding things** (2l): search over client, request and address composed with the tab and state filter
  already on screen; three orders (whose turn it is, due date, client); and both lists as CSV, honouring the
  filters and the order on screen, because a practice reconciling a season works in a spreadsheet.
- **A request that can change, and an ask that can be sent** (2n): a title, a due date, the note to the client
  and the client itself are all editable after creation — because deadlines move constantly and the only fix
  used to be to close the request and start again, losing the client's link — and the first ask can be emailed
  from the request itself rather than by copying a link into another program. The record says which happened:
  `request.edited` carries what changed, and `request.sent` is not `reminder.sent`.
- **A practice the client can place** (2o): every letter is signed with the practice's current name, and the
  portal a client lands on says which firm is asking — before this, an email asking a stranger for their bank
  statements ended `Thanks,` and the page said "Tickmark", which is what a phishing attempt looks like.
- **A cap on being guessed at** (2o): `/signin` is the only endpoint reachable without a link or an
  invitation, and failures are now counted per account, expiring on their own. Per account rather than per
  address, so one attacker cannot lock a practice out of its own software — see `src/ratelimit.js`.
- **The four gaps a practice finds** (2p): a document's wording can be corrected without withdrawing it; a
  season can be closed in one go, with the finished ones ticked and the unfinished ones left to a decision;
  overdue dates are read on the practice's own calendar rather than Greenwich's; and a lost password is
  replaced with `tools/reset-password.mjs`, which also ends that person's sessions.
- **A list you keep, and asking everyone at once** (2q/2r): a checklist saved under a name and used for one
  client or all of them, made either from the templates page or from a request that already has the right list
  on it; and one action that makes a request per client — each with its own link, each emailed — with a page
  that shows who can be written to before anything is sent and a report that names every outcome. This is the
  gap the research called "bulk send", and the one that makes fifty clients possible.
- **Being told what arrived** (2s): the only email in the product nobody presses a button to send. One message
  per request per day — what has arrived, what has not, and whether anything needs sending again — to whoever
  made the request, **sent after the client's own response** so that a mail server can never fail or delay
  somebody else's upload. The practice can turn it off on the page where its name and timezone live.
- **An answer as a state of its own** (2t): a client who says "I do not have this" is not a client who has gone
  quiet, and the board now says so — a fourth state (*the client answered*), its own count and filter, and the
  same notice to the practice, carrying the client's own words. Before this, a reply and a silence looked
  identical on the one screen where the decision to chase is made.
- **The year coming round** (2u): the clients page names who is *due an ask* — nothing open for them, last asked
  in this month of an earlier year — and *ask everyone* arrives with them already ticked. No scheduler, no
  automatic email, and no cycle length to configure: the rule reads the practice's own history, and asking
  somebody takes them off the list.

**Not built, and named rather than implied:**

- **Recurring requests** on a schedule — a request that makes *itself*, and emails a client, because a date came
  round. Still not built, still for the same reason: a schedule raises a question nothing in the product answers,
  namely what happens when it fires while last year's request is still open. **What 2u does instead** is answer
  the question the schedule was standing in for: the practice is told who is *due* an ask, and the send is one
  action they press. A robot that emails a client without a person reading the list first is not a thing this
  product is going to grow.
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
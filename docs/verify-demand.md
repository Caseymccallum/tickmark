# The check that comes before the code

One hour of asking, before three days of building. This file exists because the
expensive failure is not a bug — it is a well-built thing nobody needed.

## Why this file exists at all

The author's last five months produced seven projects with a git history. Their
lifespans, measured:

| Project | Commits | Lifespan |
| --- | --- | --- |
| DecisionOps | 49 | 3 days |
| LifeOS | 215 | 13 days |
| Plain Books | 104 | 5 days |
| Plain Forms | 282 | 53 days |
| proof-of-waves | 5 | 1 day |
| Vidimus → Charter | 38 + 36 | 1 day each |

The median is three days. None of them stopped because the idea was bad. They stopped
at the point where the interesting 90% was done and the unglamorous 10% — the
deletions, the copy, the pricing decision, the announcement — was left. Every one of
those projects has a plan and no users, and a further project built the same way would
be the eighth.

So the first artefact of this project is not code. It is a question asked of the people
who would use it.

## Who is asked

Practitioners, not developers. This is a working tool for a profession, and the only
people who can say whether it is useful are people who currently chase clients for
documents:

- ~~**r/Bookkeeping**~~ — **ruled out on 20 September 2026.** Its Rule 7 bans *"research questions for your
  software… posts seeking information from users to be used in development"* by name, with a permanent ban
  for breaking it. Asking here was the plan's safest-looking move and it was the plan's worst one; see
  `docs/demand-posts.md`. What is still open on Reddit is *answering* people who have already asked, which
  is a different act and not the one that rule is about
- **AccountingWEB Any Answers** and practitioner Facebook groups — the rooms where a supplier disclosing
  what they are building is normal, and therefore the only places a question about it belongs
- **r/taxpros** — 91,000 members, and heavily software-focused for a trade room: practice-management
  suites like TaxDome and Canopy are compared and complained about there constantly. Worth knowing
  before reading the answers: this is a room that already pays for software, which makes it the best
  place to hear "I would never self-host" and the worst place to expect a free tool to impress anyone
- **AccountingWEB** (Any Answers forum, UK) and **AccountingWEB US** — where practice
  management is actually discussed by owners
- one or two practitioner Facebook groups or a Slack community for bookkeepers

**Post as a person with a question, not as a launch.** A mailing list or a forum
ignores a press release and answers a question. Every post must disclose that the
software does not exist yet — that disclosure is what makes the answers trustworthy,
and it is also the only version of this that is honest.

## What is asked

Eight questions. The number matters: fewer than five, and the answers are politeness.

1. How do you currently get documents from clients — email, a portal you pay for, a
   shared drive, or in person?
2. What actually breaks? (Chasing, items never arriving, clients resending the same
   thing, photos of paper, the same request next year from scratch.)
3. How many clients do you do this with per season?
4. What do you pay for it now, if anything? And at what point is that too much?
5. If a tool told you exactly which items were outstanding for each client, **but you
   sent the reminders yourself**, would that be worth using? *(This question is the one
   that decides the biggest scope cut in the plan.)*
6. Would you run it on your own server to avoid paying per client or per return — or is
   that a job you would never take on?
7. Is there anything you would refuse to put in a tool like this, or anything your
   clients would refuse to send?
8. What would make you close the tab and never come back?

Question 8 is the most valuable one in the list and the one most often left out.

## How the answers are read

Written down **before** asking, so that the result is a reading rather than a mood.

| Outcome | Decision |
| --- | --- |
| Five or more practitioners name the chase in their top three pains | **Build it.** The plan in `docs/mvp.md` stands as written. |
| They name the pain, and most would rather pay for hosted than run it themselves | **Lead with the hosted product.** Keep the self-hosted install for whoever wants it — both ship from one codebase, so this decides what to *market*, not what to build. |
| They name the pain, but nobody would pay anything **and** nobody would self-host | **Stop.** Both paths lead nowhere: free-to-self-host with no appetite for hosted means no revenue, and a product with no revenue is the eighth project with better engineering. |
| The pain is real but *"the provider cannot read your files"* draws no interest | **Reconsider the wedge.** What is left is convenience, and the incumbents are better positioned to sell convenience. |
| Fewer than three people answer at all | **Treat it as no.** Not because the idea is disproven, but because a problem that practitioners will not spend five minutes describing is not a problem worth a fortnight. |

### Why the self-hosting row was removed, and what replaced it

The first version of this table made *"two or more would self-host"* a condition of building at all, and its
second row said **"build the hosted product instead — do not build the self-hosted one."** Both were written
when there was one deployment. There are now two: `docs/saas.md` describes the multi-tenant layer, and the
self-hosted install is unchanged beside it. **The choice that row was protecting against has already been made
in the code**, so asking about it can no longer decide whether to build. Asking it as a gate would have thrown
away a good answer to a question that stopped mattering.

**The plan also bundled two different questions into one wedge.** *"Would you self-host?"* and *"does it matter
that your provider cannot read your files?"* were treated as the same preference. They are not:

- A practice can want **hosted** (no server to administer, someone else on the hook when it breaks) **and**
  care deeply that the host cannot read the documents. That is the hosted customer, and it is the one this
  product is built for.
- A practice can want **self-hosting** for cost or control, with no view about encryption at all.
- A practice can want neither and simply want convenience — which is the answer that matters, because it is
  the one where this product has nothing to sell.

So the self-hosting question stays in the list as **market intelligence** — it says which segment is talking,
and roughly how large the no-admin-burden segment is — but it is no longer a kill switch. What took its place
as a primary counter is **what they pay now and whether they resent it**, because if the answer is "hosted,
please" then the hosted subscription is the business, and pricing stops being a detail.


## What gets recorded here afterwards

The posts, the dates, the answers, and the decision — with the same discipline the
author's other projects apply to their claims. If the answers say stop, that goes in
this file and the repository is archived with it intact, because a recorded "no" is
worth more than a silent abandoned repository.

## Where the answers go

Written here as they arrive. The replies are the whole point of asking, and a good one read once and
not recorded becomes an impression by the following week — which is how the eighth project happens.

### Posts made

| Room | Version used | Date and time | Replies | Removed? |
| --- | --- | --- | --- | --- |
| Bookkeepers Helping Bookkeepers (Facebook, 17k members) | The question, undisguised — "what's the most frustrating part of getting documents out of clients?" | 20 September 2026, evening | 1 so far | no |
| Bookkeepers Helping Bookkeepers (Facebook, 171k members) | The question, **reworded**, and with the pricing question the first post is missing | 20 September 2026, evening (edited while pending) | pending moderation | awaiting approval |

**The duplicate wording was corrected before anybody saw it.** The post went up identical to the first group's,
which is the pattern Facebook's own spam detection looks for and which reaches the same practitioner twice when
they are in both groups. Editing while pending worked, so it now carries different wording throughout **and the
pricing question**. Recorded because the correction was luck rather than method: had a moderator approved it
first, an identical pair would have been live in two overlapping rooms, and the fix would have meant deleting a
post that had already been seen.


Both posts went to Facebook groups. They were chosen over the tracked list because three of the tracked rooms
refused or could not be verified, and because a group is where bookkeepers talk to each other rather than a
forum they visit only when they have a problem.

### Rooms that refused, or could not be used

Recorded because a room saying no is a result, and because it took two attempts to find out:

| Room | Why it was not used |
| --- | --- |
| **r/Bookkeeping** | **Rule 7** bans research questions outright: *"Posts seeking information from users to be used in development of your software… This includes questions like 'what part of ____ do you find most challenging'."* Permanent ban for breaking it. The product-free draft was written to satisfy a *self-promotion* rule and could not satisfy this one. |
| **r/Accounting** | *"No self-promotion, advertising, solicitations, or research ideas."* |
| **r/tax** | *"Do not post or otherwise link to content intended to benefit any business."* |
| **r/taxpros** | Not verified. Its neighbours all ban this shape, and the account was not worth spending on the assumption. |
| **AccountingWEB (US)** | Does not exist. `accountingweb.com` is gone; `accountingweb.co.uk` is the UK site and is live. |
| **AccountingWEB (UK)** | Unverified — the site blocks automated reads, and its threads about practice advertising suggest a disclosed supplier may not be welcome. Left for a human to read the guidelines. |

**The lesson, recorded because it is repeatable:** the first list of rooms came from a third-party
rules tracker, which summarises rules. A *summary* of "no self-promotion" and a *rule* reading "no research
questions" are different constraints, and the difference was the whole post. Where the rules matter, only
the room's own sidebar counts.

### What they said, in their own words

The valuable ones describe a season and a client, not a feeling. Quote them; paraphrase loses the
specifics that make an answer evidence.

- *"When they complain that your not doing your job. I have asked 20 million times give me your last tax
  documents that was filed! Why because you have no clue what they did and I can use this to your
  advantage!! Ugg"* — Bookkeepers Helping Bookkeepers, 20 September 2026. Answers question 2 with something
  the plan did not anticipate: the failure is not the missing document, it is **being blamed for it while the
  client is the reason for it**. The document in question is the **prior-year filed return** — what a practice
  needs to understand a new client's history, and the one the client often does not have or cannot find.

- *"Public accounting firm I work with uses Suralink. They create entity/return and it has the list of items to
  upload. Once you upload the document it marks the item as complete. I think it sends overdue reminders to the
  client and let's preparer know when items have been uploaded. I don't know what the preparer interface looks
  like or how it functions with their other tools, but from a client perspective it is pretty useful. Also I can
  toggle between entities if you have clients with multiple returns. It seems like you could setup task for
  monthly close documents."* — Bookkeepers Helping Bookkeepers, 20 September 2026. Answers question 1 (what do
  you use now) with a **named incumbent**, and answers question 2 by describing it working.

### Competitors named, unprompted

Its own kind of answer, and worth counting separately: every name here is a product the plan either did not know
about or had not weighed against.

- **Suralink** — 20 September 2026, described from the **client** side by somebody with no stake in either
  product. Entity/return-based item lists · an upload marks the item complete · overdue reminders to the client ·
  the preparer is told when items arrive · a toggle between entities for one client with several returns ·
  inferred support for monthly-close task lists.

  **Item for item, that is what this product does**, and that is not a compliment: it means the feature list is
  not the differentiator, and somebody who uses the incumbent calls it *"pretty useful"*.

  Two things it also reveals that the plan had not modelled:
  - **A client with several entities gets one place to look.** Here they get one link per request and no view
    spanning them. Whether that matters depends on how often a practice asks one person for several entities'
    documents at once — which is common in public accounting and less so in a small bookkeeping practice.
  - **Monthly close as a task list** — offered as an obvious use of the tool. That is the first evidence *from a
    user* that a repeating cycle is wanted. `docs/roadmap.md` §2u answers the annual case and deliberately
    refuses the scheduler; this is the monthly case, arriving unprompted, from the client side.

- **SafeSend** — 21 September 2026, by the same respondent, and named only for what it does *not* do well. She
  values it for being consistent — *"all the information is compiled in the same format for each return"* — and
  for *"the reminder emails to make sure I don't miss anything"*. Her one complaint is the same complaint she
  made about Suralink.

### The multi-entity finding, which is now the strongest signal in the exercise

The same respondent, unprompted, about **two different products**:

> *"I can toggle between entities if you have clients with multiple returns"* — of Suralink.
>
> *"We also use SafeSend for tax return distribution and my only issue is I can't toggle between entities. I have
> to log in to each one."* — of SafeSend.

**"My only issue"** is doing real work in that sentence. Asked what is wrong with a product, an experienced user
of thirty partnerships named one thing, and it was not the documents, not the reminders, not the format, and not
the price. It was having to move between entities one at a time.

And the number that makes it concrete is in the same message: **"I cover around 30 partnerships"** — which is
also the first honest answer this exercise has had to *"how many clients per season?"*, the third question on the
list, asked on 20 September and answered on the 21st without being asked again.

Three things follow, in order of how much they should change the plan:

1. **This is the one competitor gap that is not about pricing or positioning.** Suralink has the feature, and it
   is the thing she likes about it. Every other difference found so far is about who is willing to pay what;
   this is about a capability, and it is the only such difference in the whole exercise.
2. **In this product's model it is currently worse, not better.** A client is a row and a link opens one
   *request*, so a group with thirty partnerships gets thirty clients and thirty links. She would be describing
   Tickmark exactly as she describes SafeSend.
3. **Spanning requests for one client is a security decision before it is a build.** A link issued for one request
   that reveals the existence of four others is a link that leaks more than it was sent for, and the practice
   emailed it to one person who may forward it. That is why `docs/roadmap.md` carries it as a design question
   rather than a task, and it is now the top of that list.

### The objection, which is a signal rather than a heckle — 22 September 2026

Anonymous, in the same group, under the posts:

> *"So you have no actual experience but want to build a tool based on what we have already developed for
> ourselves and give to you?"*

Two charges in one sentence, and only one of them is a misreading.

**The true one:** the author is not a practitioner. That was disclosed in the post, deliberately, and it is the
reason the questions are being asked rather than assumed. Nobody was misled, and there is no answer to this
charge — only the acceptance of it.

**The real one:** *founder asks a trade for its expertise and keeps the value.* This is a familiar shape and the
suspicion is reasonable, which is why the answer cannot be "I'm just curious". The position, stated plainly
rather than hedged, because a hedge here would be a lie that a future customer could catch:

- the replies are public and go to everybody reading the thread, not to the author privately;
- **the software can be read and run for nothing** — anyone can run it on their own server at no charge, and it is
  not a cut-down or trial edition. A practice that answered here gets the result for free;
- **there will also be a hosted version, run by the author, and it will be paid.** That is a commercial project
  and pretending otherwise would be both dishonest and pointless — the hosted service is a public thing, and
  anybody who found it later would read the denial as the real answer. What the subscription sells is *running a
  server*, not the knowledge in this thread, and the software is identical either way.

That is the open-source position, and the reason it answers the charge is that it is **checkable**: the source
is readable, the licence is in the repository, and "you could run this yourself" is not a claim anybody has to take
on trust.

**Amended 22 September 2026 — the licence was changed to FSL-1.1-ALv2 and changed back the same day.** The
position first written here said *"the software is open source and will stay that way"*, and that sentence is
true again as written: the project is **AGPL-3.0-or-later**, an OSI-approved open-source licence.

What happened in between, recorded because the reasoning is worth more than the outcome. The concern was a
competitor hosting this software and undercutting the hosted edition, so the licence moved to the Functional
Source License — source-available, free for your own practice, with one restriction (no reselling it as a
competing service) and an irrevocable conversion to Apache 2.0 after two years. On weighing it: **the attack
that prevents is a bad business for whoever attempts it** (they cannot differentiate a copy, and still carry
the servers, billing and support), while the scenario that is actually dangerous — a closed derived product —
**was already blocked by AGPL**. And what it cost was real: *"open source"* is a distribution channel that
works without a marketing budget, and this project has no budget to replace it with. See `docs/mvp.md` for
the full reasoning.

So the drafted reply, *"the software is open source and will stay that way"*, stands and needed no correction.
The general lesson is the one this project keeps relearning: **a claim is worth checking against the artifact,
not against memory** — the licence was asserted in four files and a build check, and three of them were wrong
at least once.


**Why it belongs in this file at all.** It is the first evidence about *how the profession sees an outside
builder*, as opposed to how it sees document chasing, and the two conclusions are different:

1. **A readable source is not a marketing line here; it is the answer to the only objection this research has
   drawn.** A hosted-only product from a non-practitioner — or one whose source nobody could inspect — would have
   no reply to this comment at all. Note that the *readability* is doing the work, not the licence tag: the licence
   changed on 22 September and this conclusion did not.
2. **The community is watching the exchange, not the comment.** A defensive answer confirms the charge for every
   lurker who reads it; a short one that concedes the truth and states the actual position converts some of them.
   That is an argument for answering slowly and briefly, and against deleting it.

No reply had been made at the time of writing.

### Two more things she said, which are smaller and worth keeping



**Reminders are welcome.** *"I love the reminder emails to make sure I don't miss anything."* That is the chase
validated from the **receiving** end — by somebody who is the client, not the buyer, and who has no reason to be
polite about an email. It is the first evidence that the product's central act is wanted by the person on the
other side of it, and the follow-up asks when they would *stop* being welcome, which is the harder half.

**Consistency is a client-side benefit, not just a practice-side convenience.** What she praises is that
everything arrives *"in the same format for each return"*, and what she complains about is that it does not
always: *"when an individual packages the return they are slightly different."* Templates in this product were
built for the practice — the same forty document names not typed again — and this is the first evidence that they
matter to the client as well, because a checklist in the same order every year is one she can work down without
reading it.

**And one operational note for the hosted layer**, not for the product: *"There was only one day early in the
year I had issues logging in… That seems to happen with all software around deadline time."* She forgives it,
which is exactly why it is worth writing down: deadline week is when the load is, and being forgiven is not the
same as being unaffected.


### Suralink, read from their own homepage — 20 September 2026

Found by the author, not volunteered by a respondent. What the front page claims:

> *"Suralink is the agentic automation platform that unifies your entire Request-to-Review workflow, from PBC
> through review, on one platform. **AI agents automate testwork and pre-screen client documents and data as
> they arrive**, so your team escapes the Rework Cycle… Every request, workpaper, and file lives on the same
> platform **800,000+ clients** already use alongside **1,300 firms**, so nothing gets chased twice. Real-time
> dashboards, approval workflows, and a complete audit trail… enterprise-grade security… **Request a Demo and
> Get Pricing**."*

Four things follow, and the first one matters more than the other three together.

**1. The demand is confirmed, and by somebody else's revenue.** 1,300 firms and 800,000 clients pay for a
product whose stated job is *"so nothing gets chased twice."* That is this product's entire problem statement,
sold successfully, at scale. **The question the exercise was written to answer — "is this needed?" — has been
answered independently.** What remains open is not demand but **segment**: who is not buying that, and why.

That is a better question than the one this file started with, and it was not known when it started.

**2. They went upmarket, and left the bottom behind.** *"Request-to-Review workflow, from PBC through review"*,
*"audit automation"*, *"testwork"*, *"approval workflows"*, *"every engagement"*. This is an audit platform now.
The document-request tool a bookkeeper wanted is one feature of it. The pricing is behind *"Request a Demo"*, and
the qualification form asks for **number of professionals and industry** — an enterprise sales motion, an annual
contract, and a call. A three-person bookkeeping practice is not going to have that call.

**3. Their AI is architecturally incompatible with this product, and that is a fork rather than a gap.** *"AI
agents… pre-screen client documents and data as they arrive"* only works if the platform can read every file, in
full, server-side. This product **cannot** — by design, and `docs/roadmap.md` refuses OCR and AI for exactly that
reason. The two are not better and worse versions of one thing: one reads everything to add value, the other
reads nothing so it can promise it will never be read. In 2026 the market is loudly rewarding the first. Whether
anybody is buying the second is the whole remaining question, and it is the one to ask practitioners directly.

**4. Their security claim is a promise, and the difference is the point.** *"Enterprise-grade security"* is a
statement of trust. This product's claim is technical and checkable: the server never receives a key, and the
source is readable. That is the only thing here that Suralink cannot copy without giving away their AI. **It is
also, so far, the thing no respondent has mentioned once.**




**Not yet recorded from the reply:** what she does now (question 1), how many clients (question 3), whether
she would run it herself (question 6). The follow-up asked the one that matters most for the plan — *"would
that require you to manually go through your sent items?"* — because the answer separates two products: if
clients genuinely do not know what is outstanding, then visibility is the fix; if they do know, the only thing
that helps is **a record that proves what was asked and when**.


### Counted against the table above

Not an impression — a count, so the decision below is arithmetic and not mood.

- Named the chase in their top three pains: **0 of 5** — but the counter is the wrong shape and this is the
  evidence. The first respondent named being *blamed* for a late document; the second says she *loves* the
  reminder emails. Neither is a complaint about chasing, and both are about the chase. What the exercise was
  really testing is whether the problem is real, and **somebody paying 1,300 firms' worth of a competitor plus
  a second product for the same job has answered that more convincingly than five replies to a post would have.**

- **How many clients per season:** **30 partnerships** — answered unprompted on 21 September by the respondent
  above. The only honest number in the exercise, and it is large enough for the size argument in
  `docs/product-needs.md` to be worth something.

  A note on why the first reply is not counted here yet. She named a frustration, and a specific one — but
  it is **being blamed**, not the document collection itself. Counting it as "the chase" would be reading the
  answer I wanted rather than the answer she gave. The follow-up asks directly whether it is the chasing or
  the not-knowing-who-owes-what, which is the question the counter is actually for.

- Would rather pay for hosted than run it themselves: **0** *(the counter that decides what to market)*
- Would run it on their own server anyway: **0** *(kept as segment intelligence — no threshold, see above)*
- Described what they pay now, or what would be too much: **0 of 5** *(primary since the hosted route became the likely business)*
- Already pay for a portal and described it as fine or adequate: **1 — and it is the closest thing yet to the row
  that says stop**

  Suralink, by a respondent who uses it as a client: *"from a client perspective it is pretty useful."* Counted
  once but **not fully**, for a reason that matters: the practice is the buyer, and she says outright *"I don't
  know what the preparer interface looks like."* The client side of the incumbent is confirmed good. The side
  that decides whether to pay for an alternative is unexamined — which is the follow-up.

- Named something that would make them close the tab: **0**
- Named something they or their clients would refuse to put in a tool: **0**
- Asked unprompted whether the provider can read the files: **0** *(the wedge, measured as interest rather than as a preference)*

### The decision

**Not yet taken.** Written here when the answers are in, against the table above — including if the
answer is stop. A recorded no is the one outcome this file can produce that is worth more than the
repository.

**Status: running.** First post is up (see *Posts made*). The decision below is not taken, and nothing under
`docs/` claims it is.
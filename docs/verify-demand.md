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

- **r/Bookkeeping** — the trade subreddit, where the same complaints recur every season
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
| Five or more practitioners name the chase in their top three pains, and two or more would self-host | **Build it.** The plan in `docs/mvp.md` stands as written. |
| They name the pain, but everyone wants it hosted and would pay | **Build the hosted product instead. Do not build the self-hosted one.** This is a different and possibly better business, and the code is largely the same. |
| They already pay for a portal and are satisfied with it | **Stop.** The demand is being met. Spending three days to be a slightly cheaper version of a product people already like is the eighth project. |
| The pain is real but the *privacy* claim draws no interest | **Reconsider the wedge.** The self-hosting is a preference, not a need, and the incumbents are better positioned. |
| Fewer than three people answer at all | **Treat it as no.** Not because the idea is disproven, but because a problem that practitioners will not spend five minutes describing is not a problem worth a fortnight. |

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
| | | | | |

### What they said, in their own words

The valuable ones describe a season and a client, not a feeling. Quote them; paraphrase loses the
specifics that make an answer evidence.

- *"…"* — room, and whether they said what they do now
- *"…"*

### Counted against the table above

Not an impression — a count, so the decision below is arithmetic and not mood.

- Named the chase in their top three pains: **0 of 5**
- Would run it on their own server: **0 of 2**
- Already pay for a portal and described it as fine: **0**
- Named something that would make them close the tab: **0**
- Named something they or their clients would refuse to put in a tool: **0**

### The decision

**Not yet taken.** Written here when the answers are in, against the table above — including if the
answer is stop. A recorded no is the one outcome this file can produce that is worth more than the
repository.

**Status: not yet run.** Nothing under `docs/` claims otherwise.
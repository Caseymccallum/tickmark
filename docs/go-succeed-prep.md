# Go Succeed NI — Tickmark business prep

Preparation for Go Succeed (the NI council-led business support programme), and for the
business-model questions that decide whether Tickmark is a business, not just a build.

---

## 0. What Go Succeed NI actually is, and what it will ask of us

- **Led by NI's 11 councils**, funded by the UK Shared Prosperity Fund. The service is **free**.
- **Three tiers**: **Start** (idea → running), **Grow** (existing business with growth potential),
  **Scale** (businesses that can reach **≥ £1m revenue within 3 years**). Support = 1:1 mentoring
  (up to ~13 hrs on Start, ~30 hrs on Scale), masterclasses, peer networks, and **grants** (the grant
  fund is **currently closed**; when open it needs **30% match funding** from the business).
- **Eligibility**: the business must be **legally registered in Northern Ireland** — online businesses
  that sell abroad are explicitly fine. Tickmark qualifies (NI-registered SaaS, sells UK + beyond).
- **Tier fit**: Tickmark is a software product, so the honest tier is **Grow** now (pre-revenue, product
  built) with a **Scale** trajectory. The Scale bar — £1m in 3 years — is the number to plan against and
  it shapes every answer below (it is a growth plan, not a lifestyle plan).
- **What to prepare**: a clear problem/solution, a business model, **pricing**, an understanding of
  customers and competitors, and realistic **financial projections** (they want to see cash-flow thinking,
  and match-funding capacity if a grant opens). There is also **"The Ultimate Pitch"** competition — a
  tight 60-second pitch is worth having regardless.

---

## 1. Tickmark in one line

> **Tickmark stops accounting practices chasing clients for documents — one link, no client logins,
> and files only the practice can ever read.**

Everything else is that sentence unpacked.

---

## 1b. What is already built (working software, not a slide)

The panel's first question is "can you actually build this?" — and the answer takes it off the table. Tickmark is
a **working product today**: a zero-dependency web app with **hundreds of passing tests**, live-tested against
real Xero. What a practice can do right now:

- **Chase clients for documents** — a titled checklist per matter, one link per client (no login, no password),
  automatic reminders, and a board that says exactly whose turn it is.
- **Clients upload from a phone** — several files at once, camera-ready; the practice can also add a document
  **on a client's behalf** for the ones who will never use a link.
- **Everything is encrypted in the client's browser** — the server stores ciphertext it cannot read. A
  **recovery sheet** means a forgotten passphrase never loses the files.
- **The whole matter downloads in one go**, and the same request rolls forward every year in one click.
- **And it reads the client's real accounting setup.** Tickmark connects to Xero or QuickBooks (read-only, a
  credential the practice already grants), reads each client's **entity type, year-end and tax number**, and
  **builds the request on it** — the right checklist for a limited company vs a sole trader, a title naming the
  year, a due date around their real year-end. No retyped January checklists.

That last one is the leap: it turns Tickmark from "a place to collect files" into **a tool that knows the
client's books** — and it is the foundation for the next step (chasing driven by the books themselves), built
on a credential we already hold.

---

## 2. The wedge (the framing decision that matters most)

The one thing to get right is **what we lead with**. There are two stories here and only one of them
opens a sale:

- **Lead with the time and the client experience.** Chasing clients for bank statements, ID and signed
  letters is tedious, eats hours of fee-earner time every week, and delays filings. Clients hate creating
  logins for a portal they'll use twice a year. Tickmark gives each client **one link that just works** —
  no signup, no password — and **chases the stragglers automatically**. This is concrete, urgent, and every
  practice feels it weekly.
- **Close with the encryption.** Client-side end-to-end encryption — **zero-knowledge: the server cannot
  read a client's files** — is the differentiator and the trust-closer. It is *not* the headline, because
  "encryption" is abstract at first contact. But when a practice asks "why should I trust you with my
  clients' bank statements?" (and they will), it is the winning answer — and it is the one thing the
  incumbents and the US competitor cannot honestly claim.

**The rule: open with time and "no client logins"; close with "and only you can read what they send."**
Encryption is the moat and the closer — never the cold open.

**The pitch (60 seconds):**

> Accounting practices spend hours every week chasing clients for documents — bank statements, IDs,
> signed engagement letters — over email, phone and reminders. Tickmark ends that. The practice raises a
> request once; every client gets **one link that just works — no app, no login, no password** — and
> Tickmark chases the stragglers automatically until everything's in. Every file is encrypted **in the
> client's own browser**, so **only the practice can ever read it** — we can't, and neither can a breach.
> And Tickmark **reads the client's real accounting setup** — entity type, year-end, tax number, straight
> from Xero or QuickBooks — and **builds the request on it**: the right checklist, the right date, nothing
> retyped. It's the document chase, done — and the only tool in this space where the vendor genuinely
> cannot see your clients' data. Tickmark: stop chasing, start closing.

---

## 3. Business Model Canvas

| Block | Tickmark |
|---|---|
| **Customer segments** | Small/mid **accounting practices** (1–15 staff) in the UK/NI that chase clients for documents. The wedge: busy small practices drowning in email chases. (Later verticals — bookkeepers, mortgage brokers, law — but **accounting first**.) |
| **Value proposition** | Stop chasing clients for documents. **One link, no client logins.** Automated reminders. Files **only the practice can read** (client-side E2E). The same request rolls forward yearly. Imports from Xero/QuickBooks/CSV. |
| **Channels** | Direct outbound to practices; accountancy communities (ICAEW/ACCA/CIOT, local); **Xero & QuickBooks app marketplaces** (integrations are also a channel); word-of-mouth; content on the "no-login + zero-knowledge" story. |
| **Customer relationships** | Self-serve SaaS; quick onboarding (import existing clients in minutes); email support; a practice community. |
| **Revenue streams** | **Subscription (SaaS)** — monthly + annual (annual discount). See §5. |
| **Key resources** | The product (zero-dependency codebase), the encryption design (client-side E2E), and the **trust** that follows from it. |
| **Key activities** | Product development; onboarding & support; sales/marketing; **security & GDPR** compliance (a feature here, not overhead). |
| **Key partnerships** | Xero / QuickBooks (integrations + marketplaces); Go Succeed & Invest NI (mentorship, credibility); accountancy bodies. |
| **Cost structure** | Hosting (near-zero — zero-dependency, small footprint); founder time; support; sales/marketing; compliance. Low fixed cost = survives on modest revenue. |
| **Unfair advantage** | **Client-side E2E / zero-knowledge** (the vendor cannot read client files — incumbents and zendoc can), **zero-dependency** (no supply-chain breach to fear), and now **it reads the client's real accounting setup and builds the request on it** — an intelligence layer on a credential we already hold. Plus the **workflow lock-in** of the recurring annual cycle and the documents already collected. |

---

## 4. The three business-model questions — answered

### Q1. The wedge: lead with time / no-login, close with encryption
Settled in §2. Time saved and "no client logins" is the **open** (concrete, urgent, weekly pain).
Client-side E2E encryption is the **close** (the trust differentiator when they ask "why you?").
Never cold-open on encryption.

### Q2. Pricing: elasticity vs per-client
**What the market does today:**
- **Senta** — £32/mo first user, less for extra users (**per-user**).
- **AccountancyManager** — £39/user/mo (**per-user**).
- **zendoc** (the US challenger, pre-launch) — **$149/mo flat** for the whole firm, unlimited users.
- The alternative most practices actually use — **email + Dropbox/WeTransfer = free** (but costs hours).

**Per-user vs per-client vs flat:**
- **Per-user** (the incumbent norm) **punishes growth** — hiring more staff raises the bill, which feels
  wrong when the value is the *documents*, not the seats. It is predictable, though.
- **Per-client** ties cost to the thing Tickmark actually saves work on (the client book, which is also
  the practice's revenue base). It is the most **value-aligned** — but a pure per-client meter makes the
  bill **grow unpredictably** as the book does, which small practices fear and which fuels churn.
- **Flat** is the simplest to sell and matches the challenger's move — but leaves money on the table for
  large books and can look arbitrary.

**Elasticity:** practices are **price-sensitive but time-poor**. Willingness to pay is driven by a
credible time saving. A practice with ~200 clients, chasing each ~3× a year (~600 chases, ~10 min each),
spends **~100 hours/year** — £3,000–£5,000 of fee-earner time — before counting the cost of late filings.
So **£50–£150/month is an obvious win** against the status quo, and the per-user reference (£25–39/user/mo,
i.e. £75–£117/mo for a 3-person practice) is the anchor. Demand is elastic below ~£50 (easy yes) and the
value holds to ~£150 for a busy practice.

**Recommendation — flat tiers by client band:**

| Tier | Price | For |
|---|---|---|
| **Solo** | **£29/mo** (up to ~75 clients) | one-person practice — undercuts per-user, an easy yes |
| **Practice** | **£79/mo** (up to ~300 clients) | the core small practice — the volume tier |
| **Firm** | **£149/mo** (unlimited) | larger practices — matches the challenger, undercuts per-user at scale |

- **Simple and predictable** (no metered surprise), **doesn't punish hiring** (unlike per-user), and the
  **band scales revenue with the book** (per-client value without the churn risk of a pure meter).
- **Annual discount** (~2 months free) to lock in and smooth cash. Anchor every sale against both the
  per-user cost *and* the hours saved.

### Q3. Switching barrier: workflow-over-data
The barrier to a practice **adopting** Tickmark is **workflow, not data.** Client data is easy to move
(Tickmark already imports from **CSV and Xero/QuickBooks** in minutes), so data is *not* the moat — and
positioning data-import as the hard part would be both wrong and off-putting.

- **The real barrier is workflow habit** — how a practice organises matters, its reminder cadence, its
  people's muscle memory. So the job is to make the **workflow feel familiar** (match their checklist and
  cadence, a gentle onboarding) and the **data import trivial** (done).
- **The retention moat is workflow + documents.** Once a practice runs its annual cycle in Tickmark
  (the recurring "do this again"), the *habit* keeps them; and the collected files are there, encrypted
  to keys only they hold. But **do not sell the encrypted documents as lock-in** — that scares buyers
  worried about being trapped. Sell it as **"your files, your keys"** (freedom + security), and let the
  **workflow** be the thing that's hard to leave.

**In one line: remove the data barrier entirely, lower the workflow barrier, and let the recurring
workflow — not the data — be the reason they stay.**

---

## 5. Financials — the cash-flow thinking and the Scale trajectory

Tickmark is **low-cost by design** (zero-dependency, tiny hosting footprint), so the burn is mostly
founder time and marketing — the business survives on modest revenue and doesn't need a large raise.

**The unit economics:**
- Average revenue per practice ≈ **£85–£100/month** (blended across the £29/79/149 tiers) ≈ **£1,000–£1,200/year**.
- Cost to serve one practice is near-zero (hosting is trivial; support is the main cost).
- **LTV is high and churn is low** once the recurring annual workflow is embedded (see Q3).

**A realistic 3-year path (base case):**

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Practices on the platform | ~40 | ~180 | ~500 |
| ARR | ~£45k | ~£200k | ~£550k |
| Main channel | direct + first case studies | Xero/QuickBooks marketplaces + referrals | marketplaces + word-of-mouth |
| Costs (hosting, marketing, support) | ~£15k | ~£45k | ~£90k |

**Against the Scale bar (£1m in 3 years):** £1m ARR needs **~1,000 practices at £1,000** or **~500 at
£2,000 ARPU**. The base case above is an honest **£300–550k** business in 3 years — solid and profitable.
The **£1m stretch is reachable** *if* (a) the app-marketplace channel converts (Xero/QuickBooks list a large
share of UK practices), and (b) the **Practice/Firm tiers carry a higher ARPU**. Plan to the base; pitch the
stretch with the marketplace as the lever. **This is exactly the conversation to have with a Go Succeed
mentor** — pressure-test the acquisition assumptions behind the £1m number.

**Cash-flow / match-funding:** the run-rate is low, so a modest grant (when the fund reopens) for
**launch marketing + the app-marketplace listings** is the sensible ask, and the 30% match is comfortably
within reach. No large capital expenditure.

---

## 6. Competitive landscape & positioning

| Competitor | Model / price | Their story | Tickmark's edge |
|---|---|---|---|
| **Senta** | £32/mo first user (per-user) | Full practice management (CRM, workflow, docs) | Tickmark is **focused on the document chase**, not a bloated PM suite — and it's **zero-knowledge** where they aren't |
| **AccountancyManager** | £39/user/mo | Practice management + onboarding + e-signing | Same — focused + true E2E; **doesn't punish hiring** (not per-user) |
| **zendoc** (US, pre-launch) | **$149/mo flat** | "Stop chasing clients for documents"; one link, no login; AI checks the uploads | **True client-side E2E** (they're "encrypted in transit & at rest" — the server *can* read files); **UK/NI-based** (GDPR + data residency); **accounting-first**, and it **reads the accounting setup to build the request** — depth a multi-vertical tool can't match |
| **Email + Dropbox / WeTransfer** | Free | What most small practices actually do | This is the **real competitor**. It costs hours — quantify the time saved |

**Positioning (one line):** *Tickmark is the accounting-specific, zero-knowledge way to collect client
documents — one link, no logins, and only the practice can read what's sent.*

- Against the **incumbents** (Senta/AM): we're the focused, cheaper-to-run tool for the one job they do
  badly as part of a suite, and the only one where the vendor can't read client files.
- Against **zendoc**: we're the **trust** story (true zero-knowledge), **local** (UK data + GDPR), and
  **deep in accounting** (Xero/QuickBooks/Practice Manager, the annual tax cycle) rather than spread across
  law/mortgages/advisory.
- Against **do-nothing**: lead with the hours saved and the filings you stop delaying.

---

## 7. Objection handling (the questions a practice will actually ask)

- **"We already use Senta / AccountancyManager."** → Tickmark does one job brilliantly — the document
  chase — where they do it as one item in a suite. It can sit *alongside* them (we import from Xero and
  QuickBooks) or replace that piece. And it's the only one where the vendor can't read client files.
- **"Why would I trust a small vendor with my clients' bank statements?"** → You don't have to. Files are
  encrypted **in the client's browser** — **zero-knowledge**, we literally cannot read them. A breach
  exposes ciphertext. This is the strongest answer in the whole deck.
- **"Encryption sounds risky — what if I lose the passphrase?"** → The **recovery sheet**: a secret you
  print once and keep offline. You control recovery; we never can. (It's the *same* promise, held one way more.)
- **"I don't want to migrate everything."** → Import your clients from **Xero, QuickBooks or a CSV in
  minutes**. No big migration project — you start with one matter type and grow.
- **"Is this GDPR / secure?"** → End-to-end encryption, **UK data residency**, and a **zero-dependency**
  codebase (no third-party supply chain to breach). Security is the product, not a bolt-on.

---

## 8. What to bring to the Go Succeed mentor

1. **Acquisition:** Is the **Xero/QuickBooks marketplace** the right lever to get from ~50 to ~500
   practices? What's realistic marketplace conversion? What's worked for other NI/UK SaaS here?
2. **Pricing:** Pressure-test **flat-by-client-band (£29/79/149)** vs a **pure per-client** meter — what
   does the UK accounting market actually tolerate, and where's the churn risk in each?
3. **The £1m number:** Is the Scale trajectory (marketplace + higher ARPU) credible, or should the plan
   aim for the solid £300–550k base and treat £1m as a stretch? How would *you* model it?
4. **Trust-building:** How does a small, security-first vendor build credibility fast against incumbents?
   Are **Cyber Essentials / ISO 27001 / SOC 2** worth it for selling to accounting practices — and in what order?
5. **Go-to-market hires:** At what point does founder-led sales need a first sales/marketing hire, and how
   to fund it?
6. **Funding:** What's the sensible use of a Go Succeed grant when the fund reopens (launch marketing +
   marketplace listings)? What match-funding evidence should we have ready?
7. **The intelligence angle:** Tickmark already reads a client's accounting setup and builds the request on
   it, and the next step is chasing driven by the books themselves. Is **"the tool that knows the client's
   books"** the right thing to lead with for the Scale trajectory — and how would you price that depth?

---

## 9. Pre-flight checklist before the meeting

- [ ] **Have Tickmark live and ready to demo** — the strongest sixty seconds you have is watching it read a
  client's accounting setup and build the request in front of them. Working software, not a slide.
- [ ] Register the business **legally in Northern Ireland** (the eligibility gate).
- [ ] Pick the tier to apply for (**Grow** now, with a **Scale** trajectory) — and be ready to explain the £1m path.
- [ ] Have the **60-second pitch** (§2) and the **pricing table** (§4) memorised.
- [ ] Prepare a simple **cash-flow sketch** (§5) — 3-year path + costs + the grant use.
- [ ] Line up **2–3 potential pilot practices** (letters of interest beat a spreadsheet).
- [ ] Know the **objection answers** (§7) cold — especially the encryption/zero-knowledge one.
- [ ] Register interest for **"The Ultimate Pitch"** — the 60-second pitch is built for it.
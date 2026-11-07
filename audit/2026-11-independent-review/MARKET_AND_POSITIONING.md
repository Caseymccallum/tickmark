# Market and Positioning

**Observation date for all pricing below: 7 November 2026.** Figures are quoted from vendors' own pages, fetched during
this audit. Where a page blocked automated access, the source is named explicitly. No price is invented, and anything
I could not verify is labelled as unverified.

## 1. The field, measured

| Product | Model | Published price (7 Nov 2026) | Limits on the cheapest paid tier | Zero-knowledge? | Self-host? |
|---|---|---|---|---|---|
| **Content Snare** | SaaS, horizontal (accounting, legal, mortgage, agencies) | **$35 USD/mo** billed annually (Basic) · $71 (Plus) · $119 (Pro) | Basic: **2 users, 20 active requests, 20 GB**, 40 SMS/mo | **No** — server-side AI builder, KYC/AML screening | No |
| **FileInvite** | SaaS, now positioned at **commercial lenders** | **from $9,900 USD/year** (Standard) · Enterprise on quote | ~100 commercial loans/year | No — AI matching, in-platform messaging | No |
| **TaxDome** | SaaS accounting practice management | **$1,500/yr for up to 150 active clients** (20 seats), $9,000 at 1,000, $16,500 at 3,000; AI add-on $200/mo | Priced by **client count**, not seats | No | No |
| **Zendoc** | SaaS, waitlist / "launching soon" | **$149/mo flat per firm** (≤10 people, 50 GB) — per the project's `docs/competitive.md`, dated 29 Sep 2026 | 10 people, 50 GB | **No** — reads every upload server-side | No |
| **ProjectSend** | **Self-hosted**, GPL v2, since 2011 | Free (a paid Cloud version exists) | Unlimited users | **No** — its own comparison table lists "Encryption at rest: Not yet" | **Yes** |
| **Tickmark** | Self-host free; hosted planned | Self-host **£0**; hosted documented at **£49/mo** | Self-host: per-link ceilings only (2 GB / 500 files) | **Yes — verified in this audit** | **Yes** |

**Sources.** `contentsnare.com/pricing/` and `fileinvite.com/pricing` fetched directly on 7 Nov 2026.
TaxDome's figures come from a third-party analysis updated 4 Nov 2026 (`financial-cents.com`) because `taxdome.com`
returned **HTTP 403** to automated fetch — treat as **likely, not confirmed**. ProjectSend from `projectsend.org`
(its comparison table is dated "Last verified: August 2026"). Zendoc and the £49 figure from the repository's own
`docs/competitive.md`, whose date is 29 Sep 2026 and which flags Zendoc as a waitlist product whose pricing will move.

## 2. What this tells us — four hard facts

1. **The price anchor is $35/month, not £49.** Content Snare sells 2 users and 20 active requests for $35 USD/mo.
   Tickmark's documented £49/mo hosted is roughly **60% above** the cheapest credible incumbent — for a product with
   fewer users, no AI and no KYC. *Affordable pricing is a differentiator Tickmark does not currently have, even
   though its licence allows it.*
2. **The top of the market has moved away from small practices.** FileInvite now sells to lenders at $9,900/yr; TaxDome
   prices by client count and charges $200/mo extra for AI. Both are vacating the 2–12 person practice.
3. **Nobody sells "the server cannot read your clients' documents" to accountants.** Not one. Content Snare reviews
   files server-side. Zendoc's whole proposition depends on reading them. FileInvite markets SOC 2, which promises
   process, not capability.
4. **The self-hosted niche is proven and empty at this exact point.** ProjectSend: 4,000+ active instances, 4.8M+ Docker
   pulls, GPL v2 — and its own table admits **no encryption at rest**. It is also generic file sharing: no checklist,
   no reminders, no per-item review, no due dates.

## 3. Why a practice would choose Tickmark

In the order a real buyer would care:

1. **"I can tell my client I cannot read their bank statements."** Literally true, and verifiable by the client's own IT
   person. For a practice answering an ICO/GDPR question, this is a differentiator no incumbent can copy without
   rebuilding.
2. **Self-hosting for data residency.** "It runs on our machine in Belfast." That sentence closes conversations a
   subprocessor list cannot.
3. **Built for the accounting season, not every profession.** Due dates, carry-forward, templates, bulk ask, chase
   cadence, and the distinction between *arrived* and *checked*.
4. **Xero and QuickBooks import.** Zendoc concedes it integrates with no tax-prep software; Tickmark imports the client
   book, so setup is not retyping 200 names.
5. **Free to self-host**, with no user cap and no request cap.

## 4. Which users benefit most

**The realistic initial customer — narrow and specific:**

> A **2–12 person accountancy or bookkeeping practice in the UK/Ireland** doing annual accounts and self-assessment
> work; who has **already lost or nearly lost client documents over email**; who has **someone able to run a container
> or pay £20/month for a small VPS**; and whose **clients ask about data protection**. Likely a sole practitioner or a
> two-partner firm with an outsourced IT contractor. Likely already paying for Xero.

Secondary: bookkeepers serving many small clients; payroll bureaux collecting starter documents; any practice that has
been asked *"where exactly is our data stored?"*

**Who will not buy it:** firms of 40+ (they want TaxDome/Karbon and SOC 2), anyone who wants AI to check the documents
(that is what this product refuses), and anyone unable to run or pay for a server.

## 5. Differentiation, assessed coldly

| Claim | Strength | Durability |
|---|---|---|
| Zero-knowledge document storage | **Strong, unique in this segment** | High — architectural, not a feature flag |
| Self-hosted | **Strong** | Medium — a competitor could ship a container |
| Per-member key wrappings (an assistant literally cannot decrypt) | **Strong, and easy to explain** | High — same reason |
| Accounting-software import | Moderate | Low–Medium — table stakes at the top of the market |
| Price | **Currently weak** (above Content Snare) | n/a — a decision, not a capability |
| Checklists, templates, chasing | At parity | n/a |

**Is affordable pricing sufficient differentiation?** No — and it is not even achieved yet. Price is a *tiebreaker*
once the security story has landed, not a reason to switch. The reason to switch is the sentence in §3.1.

## 6. What drives repeat use

The retention hooks are already the right ones, and they are **seasonal rather than daily**:

- **The season arrives again.** "Do this again" makes the second year one click — which is exactly when a practice
  decides whether to keep paying.
- **The client list accumulates.** A directory with history is expensive to abandon.
- **The record of what was asked and when** becomes evidence the practice would not want to lose.
- **Templates improve with use** — a firm's real document lists, saved.

**What would kill retention:** if the practice has to re-ask the same way for every client every year, or if clients
routinely fail to upload — which is the single number a pilot must measure.

## 7. Overengineered, and under-delivered

**Overengineered for the customer in §4:**

- **The multi-tenant hosted layer with Stripe billing.** ~15 tenancy modules, billing, offboarding, reconciliation and
  Stripe lifecycle handling that has **never been called against a real Stripe account**. For a three-practice pilot it
  is unnecessary weight, and it is the largest body of code untested against reality.
- **Xero *and* QuickBooks at once.** One proves the pattern; two doubles the surface for the same customer.
- **The "books behind" signal** — a clever idea that reads a summary of a client's accounting activity. No evidence
  anyone asked for it.

**Under-delivered against the core proposition:**

- **No signature capture.** Engagement letters are universal and every named competitor has a signature story.
- **SMS is built but needs a gateway account** most practices do not have.
- **The self-hosted path has no one-command experience for a non-technical accountant.** "`docker compose up`, then put
  Caddy in front" is three steps too many for the buyer described above.
- **No public interactive demo**, so a practice cannot see what their client will see. An isolated demo exists on an
  **unmerged branch** — the single best sales asset the product could have, sitting in `codex/tickmark-interactive-demo`.

## 8. Should it focus on accountants first?

**Yes, unambiguously.** The product's own vocabulary is accounting (year end, season, "do this again", chase cadence,
Xero/QuickBooks). Horizontal positioning against Content Snare is unwinnable; vertical positioning against "your
existing email workflow and your client's nervousness about data" is winnable. Every additional profession dilutes the
one thing that makes the templates and the workflow good.

## 9. Is self-hosting a meaningful commercial opportunity?

**Yes — as the wedge, not as the business.**

ProjectSend's 4,000+ instances prove people will self-host a client portal. But self-hosters do not pay, and support is
expensive. The realistic shape:

- **Free self-hosted** builds credibility, creates the community, and produces the case studies.
- **Paid hosted at or below $35/mo** is the revenue, and it must be *cheaper* than Content Snare to be considered, not
  premium.
- **A paid "we install and maintain it for you" tier** for the 2–12 person firm that wants residency and no ops — this
  is the highest-value offer and the one the current hosted architecture does not yet serve.

## 10. How a private beta would validate demand

Concrete and cheap, in this order:

1. **Recruit 3 practices** from the author's own network and from the accounting communities in
   `docs/demand-posts.md`. Not 30 — three that will actually finish a season.
2. **Measure four numbers**, and nothing else: (a) did the practice finish onboarding without a call; (b) what
   percentage of clients uploaded unaided; (c) how many chase cycles per completed request; (d) did the practice ask
   to use it again next year.
3. **Charge something**, even £10/month, from at least one of them. Free pilots produce politeness; a card produces an
   opinion.
4. **Do not build anything** until (b) and (d) are known. If clients do not upload, the product is wrong. If the
   practice does not want year two, the pricing or the framing is wrong.

**Do not assume customers will pay.** Nothing in this repository is evidence of willingness to pay: there is no pilot,
no signed intent and no invoice. The market analysis above is evidence of a *gap*, not of *demand*.

## 11. Commercial verdict

**A genuinely differentiated product in a real gap, with no proof anyone wants it yet, and a price above the anchor.**
The technology is ahead of the market position. The next decision is a pricing and packaging one — hosted at ≤$35,
self-hosted free, an install service on top — taken *after* three practices have used it, not before.

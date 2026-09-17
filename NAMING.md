# Why the project is called Tickmark

This file exists because the name is expensive to change and cheap to check. It
records the method, the rejections, and what is knowingly accepted, so the question
is not reopened from memory in six months.

## The chosen name

**Tickmark** — the project. `tickmark` — the command and the package.
`tickmark.app` — the intended domain for the links clients click.

A tickmark is the symbol an accountant or auditor makes beside an item to record that
it has been seen, checked, or received. It is the profession's own word for *this step
is done*, and it is the exact interaction this product is built around: a list of the
documents a client owes, and a tick as each one arrives. The name describes the
product's core loop without describing a feature, which is the property that lets a
name survive the product growing.

### Why a compound, and not a better word

Every good single English word is already in use. That is not cynicism, it is the
measured result of the checks below: `docket`, `trove`, `muster`, `collate`,
`strongroom`, `steward`, `quire`, `coffer`, `folio`, `compendium`, `roster`, `quorum`,
`retainer`, `ticklist`, `safekeeping`, `filing`, `corral`, `wrangle` — each is a
published npm package **and** a registered `.com`, and most are also a live commercial
product in an adjacent space. The naming landscape for plain English words is
exhausted, which is why the self-hosted field that this project belongs to names itself
in compounds and coinages: Immich, Gitea, Jellyfin, Vaultwarden, Karakeep, Documenso.

`tickmark` is two of the most common English words, so it is spelled correctly after
hearing it once, and it is *not* a common phrase in software, which is why nobody has
taken it.

## What was checked, and what was rejected

Availability checks were made by asking the registries directly, not by reading search
results: `.com` registration through Verisign's RDAP endpoint, `.dev` and `.app`
through Google Registry's, packages through `registry.npmjs.org`, and collisions
through the GitHub API. A name was rejected if it was somebody else's product, even
when it was available.

| Candidate | Why not |
| --- | --- |
| **Muster** | Four commercial products: a grassroots-advocacy CRM at `muster.com`, Fire & EMS scheduling at `musterhq.com`, a working-location product at `usemuster.com`, and an inspection tool. Plus two GitHub organisations and a taken npm name. Inviting confusion in four directions at once. |
| **Trove** | `trove.com` is Trove, a funded retail-resale company (B Corp, press coverage, acquisitions). A real brand with real money. |
| **Strongroom** | `StrongRoom Solutions` — document management for banks, acquired by AvidXchange. A direct collision in the *same* space, which is worse than a collision in a different one. Also a SourceForge document-management project of the same name. |
| **Ticklist** | `TickLists` is a live shopping-list app (`.app` and Play Store), and "ticklist" reads as a to-do app rather than a professional tool. Strong meaning, wrong category signal. |
| **Docket** | A US legal term with products already using it, and in Australia and New Zealand a *docket* is a till receipt. A name that means "receipt" to half the target market and "court list" to the other half is worse than a name that means nothing. |
| **Collate** | Every printer has a collate button. The dominant association is photocopying, which is precisely the manual process this product replaces. |
| **Muniments** | Semantically the most exact of all: the legal term for documents kept as evidence of rights. Clean on npm, `.dev` and `.app`. Rejected on the rule the project already holds — a name must survive being typed and spoken by a stranger — because nobody can spell it or say it confidently. |
| **Chancery** | A records office, and a dignified word, but it reads as *legal* software and says nothing about collecting documents from clients. |
| **Steward** | Several companies (finance, faith, lending); implies a fiduciary role this tool does not hold; npm taken. Overclaiming in the name. |
| **Provenance**, **Workpaper**, **Paperwork** | Too descriptive. "Paperwork" is what the product manages and the worst possible identifier for it: it cannot be trademarked, cannot be ranked, and says nothing a competitor could not also say. The same reasoning that rejected *Provenance* in Charter's naming. |
| **Receipts** | The accounting-receipts space is crowded (Dext/Receipt Bank, Hubdoc, Expensify). The name would read as expense capture, which this is not. |
| **Paperchase**, **Chasefile** | Names the *problem* — the bureaucratic runaround — rather than the product. Paperchase was also a UK retail chain. |
| **Vouch** | Audit-native and tempting (*vouching* is examining supporting documents) but an existing company sits in the adjacent trust space, and the word is a verb only, so it cannot name the artifact. |
| **Roundup** | Monsanto's herbicide. A cautionary entry: availability was fine, connotation was not. Connotation is checked, not assumed. |
| **Scribe**, **Keeper**, **Clerk**, **Binder**, **Quill**, **Vault**, **Harvest**, **Glean** | Owned in the public mind by other software. |
| **Custoda**, **Chartula**, **Papyra** (coined) | Pronounceable but empty, and `Chartula` shares its root with **Charter**, the author's other project, which would read as a sibling rather than a distinct thing. |
| **Filekeep** (runner-up) | Clean on npm, `.dev` and `.app`, with no product collision. It is the recorded runner-up: simpler and more universal than Tickmark, but it reads as a utility or a backup tool rather than a professional product, and it gives the client-facing link no warmth. |

## What is knowingly accepted

- **`tickmark.com` is registered** (since 1999-01-20) and is not for sale. Every
  candidate had this property, and the field's answer is the one this project takes:
  `tickmark.app` and `tickmark.dev` are free, and a **self-hosted** project does not
  need the `.com`. `.app` is the better domain for client links anyway, because the
  whole TLD is HTTPS-only by registry policy — a link real clients click should not be
  able to arrive over plain HTTP.
- **npm `tickmark` is free**, which `charter` was not, so a package name is available
  if one is ever wanted. It is not needed for a Docker image.
- **A dormant GitHub account holds the username `tickmark`** and owns no repositories.
  Irrelevant: the repository is namespaced under its owner.
- **"Tick" is British and Australian usage**; US practitioners say *check*. Recorded
  because it is the one real weakness of the name: to a US firm the word reads slightly
  foreign, and to a developer *tick marks* are chart axis marks. Mitigated by the first
  sentence of the README doing the work, and by the market order — the incumbent
  products this competes with are strongest in Australia and the UK.

## Status of these checks

Made on 2026-09-17 by asking the registries and the package index directly. This is
not legal advice and not a trademark clearance search. The claim being made is narrow
and worth stating precisely: **no candidate was rejected on a hunch, and every
rejection above has a reason written down.** If a clearance search later contradicts
something in this table, this file should be corrected rather than quietly dropped, and
the correction should say what changed.
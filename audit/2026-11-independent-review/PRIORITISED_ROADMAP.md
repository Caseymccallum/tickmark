# Prioritised Roadmap

Built only from findings in this audit. Every item has evidence, and nothing is included that the code does not
justify. Effort is relative (S = hours, M = a day or two, L = a week+, XL = a fortnight+), assuming one competent
developer with the existing test suite as the safety net.

## P0 — Safety and correctness

These are the items without which a *pilot with real documents* should not start.

### P0-1 — Make the coverage gate honest

| | |
|---|---|
| **Problem** | `npm run coverage` exits 1. The floor is 93/90/75; measured 91.57 lines / 88.86 functions / 74.65 branches. CI runs this job. |
| **Evidence** | `evidence/coverage.log`; `package.json` scripts; `docs/phase-5-launch-qualification.md` records the same failure earlier at 90.90/88.14/73.97 |
| **User impact** | None directly. Indirectly: the one mechanism that would catch a regression in the encryption path is currently distrusted, so it will be ignored — which is worse than not having it. |
| **Complexity** | **S–M.** Two acceptable outcomes: (a) add tests until it passes, or (b) lower the floor *with a written reason* and pin the runtime version CI uses. (a) is better. |
| **Dependencies** | None. Do it with P0-2, which supplies most of the needed tests. |
| **Risks** | Test-writing that asserts the implementation rather than the behaviour. Test the *property*: "no plaintext on disk", "wrong passphrase yields no bytes". |
| **Acceptance criteria** | `npm run coverage` exits 0 on the Node version pinned in CI; the floor is not lowered without a paragraph in `CHANGELOG.md` saying why. |
| **Agent** | Any coding agent with the existing suite as its oracle. |
| **Effort** | S–M |

### P0-2 — Raise coverage on the encryption paths and the destructive tools

| | |
|---|---|
| **Problem** | `web/upload.js` 78.3% lines / 41.9% branches; `web/download.js` 65.5% / 31.6%; `tools/finalize-deletions.mjs` 67.6% / **14.3%**; `src/quickbooks-views.js` 38.5%. |
| **Evidence** | Per-file table in `evidence/coverage.log` |
| **User impact** | A regression in upload or download would break the product's central promise, in the least-tested branch. Deletion errors are irreversible. |
| **Complexity** | **S.** Add behaviour tests: upload aborts mid-stream; quota refusal leaves no file; cancelled download; wrong passphrase; re-encrypted file opens; deletion finalisation with a missing blob. |
| **Dependencies** | None. |
| **Risks** | Flaky tests around timing. Use the existing `fake-dom.js` harness rather than adding a browser. |
| **Acceptance criteria** | `web/upload.js` and `web/download.js` both ≥60% branch coverage; `finalize-deletions.mjs` ≥75% branches; suite still 0 failures. |
| **Agent** | Coding agent, with the security tests as a template. |
| **Effort** | S |

### P0-3 — Add an `Origin` check on state-changing requests

| | |
|---|---|
| **Problem** | CSRF rests solely on `SameSite=Lax` (finding S-01). |
| **Evidence** | No `csrf`/`origin`/`referer` handling in `src/`; `docs/security.md:227-230` documents the gap |
| **User impact** | Prevents a same-site attacker or a non-conforming browser from causing a state change. Small, but it is the thinnest layer. |
| **Complexity** | **S.** ~15 lines in the dispatcher beside the role check at `src/app.js:500`. |
| **Dependencies** | None. Must not break `Origin`-less non-browser clients (curl, the test harness) — treat a missing `Origin` as allowed, a wrong one as `403`. |
| **Risks** | Rejecting legitimate `Origin` values behind a misconfigured proxy. Mitigate by deriving the allowed origin from the same `originOf()` already used for links. |
| **Acceptance criteria** | POST with a foreign `Origin` → `403`; POST with no `Origin` → unchanged; full suite green; `TICKMARK_PUBLIC_URL` honoured. |
| **Agent** | Coding agent. |
| **Effort** | S |

### P0-4 — Run one real practice through one real season

| | |
|---|---|
| **Problem** | The product has never handled a real document for a real client. No production deployment, no human tester, no real relay. |
| **Evidence** | No live domain anywhere; `docs/phase-5`: "qualification in progress; this document is not launch approval" |
| **User impact** | Every remaining serious unknown is empirical. |
| **Complexity** | **M** (setup) with **L** elapsed time (a season cannot be compressed). |
| **Dependencies** | A throwaway host, TLS at a proxy, an SMTP relay, and one willing practice. |
| **Risks** | Real client data on an unqualified install. **Mitigate:** start with the practice's own file-manager documents, have them keep the original emails, and get written consent. |
| **Acceptance criteria** | One practice completes ≥5 real requests; every document decrypts; the restore drill is performed once on real data; four numbers recorded (onboarding completed unaided, % clients uploading unaided, chase cycles per request, "would use next year"). |
| **Agent** | Human-driven; tools from the repo. |
| **Effort** | XL elapsed |

## P1 — Product readiness

Required for a credible beta, after the P0 set.

### P1-1 — Warn that an email attachment leaves the encryption model

| | |
|---|---|
| **Problem** | The "Attach a file" label says the file "is not kept anywhere" but not that it is **unencrypted** and will live in the recipient's mailbox (finding S-02). |
| **Evidence** | `src/request-actions.js:590` |
| **User impact** | A practice can defeat the product's central promise by accident, with a normal-looking action. |
| **Complexity** | **S** — one sentence, two places (request and reminder pages). |
| **Dependencies** | None. |
| **Risks** | Over-warning makes a legitimate feature feel forbidden. Word it as a boundary, not a prohibition. |
| **Acceptance criteria** | Both pages render the sentence; a test asserts its presence. |
| **Effort** | S |

### P1-2 — Reconcile or delete the unmerged work

| | |
|---|---|
| **Problem** | `codex/tickmark-interactive-demo` is 2 commits ahead of `main` ("Add isolated interactive synthetic demo", "Gate public interactive demo CTA"); `stash@{0}` preserves a `docs/go-succeed-prep.md` edit. `codex/tickmark-commercial-audit` is 34 commits behind. |
| **Evidence** | `git rev-list --left-right --count origin/main...origin/codex/tickmark-interactive-demo` → `0 2`; `git stash list` |
| **User impact** | None today. A demo that never ships is a sales asset lost; a stash never applied is work lost silently. |
| **Complexity** | **S** (decide) or **M** (merge the demo, which is valuable for sales — see Market §7). |
| **Dependencies** | Rebase and re-run the full gate before merging. |
| **Risks** | Merging an untested branch into a green `main`. |
| **Acceptance criteria** | The demo is merged with passing `npm test`, `check:pages`, `check:nav`, or archived with a line in `CHANGELOG.md`; `git stash list` is empty and the stashed edit is recorded durably. |
| **Effort** | S–M |

### P1-3 — Qualify one real mail relay and record the transcript

| | |
|---|---|
| **Problem** | SMTP is hand-written (`src/mailer.js`) against `node:net`/`node:tls` and has never met a real relay in this checkout. |
| **Evidence** | Thorough tests, but `test/smtp-relay.js` is a **local stub**; no real-provider evidence exists |
| **User impact** | "Send" is the button a practice presses most. Failing against their provider looks broken at the worst moment. |
| **Complexity** | **S** — run `npm run transcript` and `/admin/test-email` against one real relay; record it. |
| **Dependencies** | One relay account (free tier suffices). |
| **Risks** | Deliverability (SPF/DKIM/DMARC) is not solved by code and must stay an operator task — it already is. |
| **Acceptance criteria** | A recorded transcript in `docs/` showing a real 250 acceptance, a real rejection, and one STARTTLS negotiation. |
| **Effort** | S |

### P1-4 — One-command self-hosted install for a non-technical accountant

| | |
|---|---|
| **Problem** | "`docker compose up`, then put a reverse proxy in front" is three steps too many for the buyer in Market §4, and TLS is the step people get wrong. |
| **Evidence** | `docker-compose.yml` binds `127.0.0.1:3000` and deliberately does not terminate TLS |
| **User impact** | The difference between "self-hosting is a wedge" and "self-hosting is theoretical". |
| **Complexity** | **M** — a documented Caddy/Nginx compose profile, plus a startup check that warns when `TICKMARK_PUBLIC_URL` is unset on a non-localhost install. |
| **Dependencies** | P1-3 for the mail half. |
| **Risks** | Shipping a TLS story that rots. Keep it a documented recipe, not a bundled product. |
| **Acceptance criteria** | A clean Ubuntu box reaches a working HTTPS install following one page; `check:container` extended to assert HSTS at the proxy. |
| **Effort** | M |

### P1-5 — Real-device and screen-reader pass, then fix what it finds

| | |
|---|---|
| **Problem** | Accessibility is structurally good but unproven; horizontal overflow is suspected on the client checklist at ~390 px (A1). |
| **Evidence** | `docs/visual-review-screenshots/client-checklist-mobile.png`; `docs/phase-5` lists it as outstanding |
| **User impact** | A client on a phone with large text, or using VoiceOver/TalkBack, is the most likely person to fail to upload — which breaks the product. |
| **Complexity** | **M** — a manual pass (2–3 h) plus fixes. |
| **Dependencies** | None. |
| **Risks** | Claiming WCAG conformance afterwards. Record what was tested, on what, by whom. |
| **Acceptance criteria** | Written record: iOS VoiceOver upload completed; Android TalkBack upload completed; 200% zoom with no horizontal scroll; keyboard-only request creation. |
| **Effort** | M |

### P1-6 — Stop the document table clipping its review controls

| | |
|---|---|
| **Problem** | Below ~44 rem the request page's document table clips its action column mid-label (`Che…`, `Nee…`, `Stop…`) with no visible scroll affordance (B-02). |
| **Evidence** | `evidence/screens/03`, `04` versus `01b`; container at `src/board-views.js:982` |
| **User impact** | The controls that review a document are the ones hidden, on the screen a practice lives in, and they read as broken rather than scrollable. |
| **Complexity** | **S–M** — sticky first column, or an edge fade + styled scrollbar, or a two-line row below a breakpoint. |
| **Dependencies** | None. |
| **Risks** | A sticky column inside a scroll container interacts badly with `position: sticky` and `border-collapse`; test at 390/575/730/1282 px. |
| **Acceptance criteria** | At 1024, 768 and 390 CSS px every review control is either fully visible or reachable with a visible affordance; `check-style` exits 0; rendered screenshots re-taken. |
| **Effort** | S–M |

### P1-7 — Rename the "The file itself" section

| | |
|---|---|
| **Problem** | `<h2>The file itself</h2>` heads a section containing *Close this request* and *Do this again* (B-01). |
| **Evidence** | `src/board-views.js:1136`; `evidence/screens/04-request-detail-desktop-full.jpg` |
| **User impact** | A heading that describes nothing in its section, on the busiest screen; it misdirects anyone looking for "close". |
| **Complexity** | **S** — one line. |
| **Dependencies** | None. |
| **Risks** | `check-docs`/`check-nav` compare some copy; run both after the change. |
| **Acceptance criteria** | The section is headed something accurate ("Close or repeat this request"); the suite and `check-docs` pass. |
| **Effort** | S |

## P2 — Competitive differentiation

Only after P0 and P1. Each item is supported by evidence in `MARKET_AND_POSITIONING.md`.

| ID | Item | Evidence | Complexity | Acceptance criteria | Effort |
|---|---|---|---|---|---|
| P2-1 | **Styled upload control** on the client page | UI §1, T1 — the most important control looks like 2011 | S–M | Same `name`/`accept`/`aria-label`; visible focus ring; phone camera works; keyboard-operable; a visible replacement for "no file chosen" | S–M |
| P2-2 | **Signature capture** for engagement letters | `docs/competitive.md`; Zendoc, TaxDome, SafeSend all have it | L | Client signs in-browser; the signature is captured **client-side** and encrypted with the document; practice sees a signed state. **Do not claim eIDAS compliance** | L |
| P2-3 | **Public interactive demo** | Market §7 — an isolated demo already exists on an unmerged branch | S–M | Public route, fictional data only, mutations blocked or scoped to a throwaway tenant, visible "fictional" stamp, rate-limited | S–M |
| P2-4 | **Rebrand to ink/cobalt or plum/stone** | UI §2 — green reads agricultural | M | `check:style` exits 0 in both light and dark; screenshots re-captured; `DESIGN.md` updated; semantic state colours unchanged | M |
| P2-5 | **Pricing and packaging decision** | Market §2 fact 1 — £49 sits ~60% above the $35 anchor | S | Hosted price at or below $35/mo equivalent; free self-hosted tier; an install-and-maintain tier defined; "awaiting launch validation" replaced with a real offer | S |
| P2-6 | **Promote "Download everything"** | UI F3 — a genuine differentiator buried in a note | S | The ZIP-in-the-browser capability is a headline on the request page and on the marketing site | S |

**Dependencies and risks for P2:** P2-2 must not weaken the browser-only decryption property — the signature must be
produced in the client's tab and travel inside the envelope, never to the server. P2-4 must be done with
`check-style` as the gate, and must not touch state colours. P2-3 must not become a way to write to a real practice's
data — the existing `MULTI_TENANT` separation is the model to copy.

## P3 — Future expansion

Genuinely optional. Listed so they are not accidentally started early.

| Item | Why it is P3 |
|---|---|
| Multiple entities per client | The strongest signal in the author's own research, but it changes what a link may reveal — a design decision needing a real customer's requirements first |
| Item-level due dates (staged checklists) | No practitioner has asked; changes the request shape |
| A form builder / structured organiser | Edges toward practice management, which is the narrowness the product wins on |
| Analytics for the practice (time-to-complete, chase effectiveness) | Nice, but only meaningful after a season of real data exists |
| A second language | Only when a non-English practice asks |
| Recurring scheduled asks | **Deliberately refused** (`docs/audit.md:31`). Do not build it without an explicit decision by the owner to reverse a stated principle |

## Phased implementation structure

| Phase | Contents | Exit criterion |
|---|---|---|
| **R1 — Critical remediation** | P0-1, P0-2, P0-3 | `npm test` and `npm run coverage` both exit 0; a foreign `Origin` is refused. **One to two days of work.** |
| **R2 — Core workflow polish** | P1-1, P1-5, P1-6, P1-7, P2-1, P2-6 + the passphrase-panel collapse (UI F1) | A client on a real phone completes an upload with a screen reader; the encryption boundary is stated wherever a file leaves it; every review control is visible at 1024/768/390 px |
| **R3 — Private beta readiness** | P0-4, P1-2, P1-3, P1-4 | Three practices ran a season; a real relay transcript exists; a clean Ubuntu box installs over HTTPS from one page |
| **R4 — Differentiation and integrations** | P2-2, P2-3, P2-4, P2-5, then selected P3 | Driven by what the three beta practices actually asked for — nothing in R4 starts before R3 reports |

**The order is the recommendation.** R1 is cheap and removes the only red light. R2 makes the client's experience
defensible. R3 converts an engineering achievement into commercial evidence. R4 is where the product becomes
competitive — and it should be shaped by R3's findings rather than by this document.

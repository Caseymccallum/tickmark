# TICKMARK — R1 DELIVERY REPORT

**Milestone:** R1 — trust, security and private-beta readiness
**Branch:** `feat/r1-trust-and-beta-readiness` (not pushed, not merged — awaiting owner approval)
**Starting commit:** `433762c` (the audit) · product baseline `6ff16ff`
**Runtimes used:** Node **24.22.1** (the version `ci.yml` pins) and Node **26.5.0** (local default). Both were used for
every gate, because the coverage question turned out to depend on it — see §5.
**Scope discipline:** no Supabase, no PostgreSQL, no new framework, no new dependency (`dependencies` is still `{}`), no
new permission framework, no rebrand, no deployment, no outreach. The colour scheme is unchanged.

---

## 1. Verdicts

| Area | Verdict | Why, in one line |
| --- | --- | --- |
| **Security hardening** | **PASS** | All five R1 items done and tested; no Critical/High issue found or introduced. |
| **Test and coverage gates** | **PASS** | 606 tests, 0 failures, 0 skipped; the coverage gate exits 0 on both runtimes against unchanged thresholds. |
| **UI/UX refinement** | **PARTIAL** | All four items implemented and asserted against markup and behaviour; **no fresh screenshots** were captured, so "looks better" is untested by eye. |
| **Backup and restore qualification** | **PASS (self-hosted) / PARTIAL (off-site)** | A 12/12 drill restores *and decrypts* a document. A real remote restore is unverified — no repository was created. |
| **Private beta preparation** | **READY** | Ten-part pack written, with the four numbers named and no invented feedback. |
| **Real-document pilot** | **GO** | For a practice running it themselves, with backups proven and the passphrase sheet printed. |
| **Public hosted deployment** | **NO-GO** | Email has never been carried by a real relay; off-site restore unproven; no bounce handling. |

The short version: **the foundations are sound and now tested; the commercial edge and the operator path are unproven.**
R1 closed the engineering gaps the audit found. It did not manufacture evidence for the ones that need a customer, a
relay or a host.

---

## 2. What changed, commit by commit

Seven commits, oldest first. Each is independently reviewable and each leaves the suite green.

| Commit | Phase | What it does |
| --- | --- | --- |
| `c19a831` | 1.1 | An unrecognised member role is **denied**, not promoted to owner. |
| `1a42075` | 1.2 | Cross-origin protection for every state-changing request, in the server. |
| `a1d14c1` | 1.3 / 1.4 / 3.2 | States what leaves the encrypted boundary; `/healthz` stops disclosing in hosted mode; the close/repeat heading says what it does. |
| `77c0093` | 2 / 4.3 | A configuration state answers **409, not 500**; the integration pages are tested for the first time. |
| `75c26e1` | 2 | Covers the untested surfaces, and makes the coverage gate pass on the pinned runtime. |
| `d640748` | 3 | The passphrase field folds away; the table shows that it scrolls; the picker says what it takes. |
| `9c86fa6` | 4 / 5 | An end-to-end restore drill (which found a real trap), the operator qualification, and the beta pack. |

**30 files changed** as published, this report included — the exact `+/−` is on the compare link in §12, because a
document that states its own insertion count has to be amended every time somebody edits it. No file was deleted;
nothing outside `src/`, `web/`, `test/` and `docs/` was touched. `audit/`, `review/`, `ops/`, `site/`, `.github/`,
`package.json` and the Docker files are byte-identical to `433762c`. The pre-existing untracked `review/` directory, the
audit directory, every branch and the one stash are untouched.

---

## 3. Security findings addressed

### S-01 — CSRF rested on a browser behaviour (`Medium` → **fixed**)

`SameSite=Lax` was the whole defence. That is real, but it is a *browser* behaviour and the server checked nothing — so a
same-site sibling subdomain, a `null` origin, or any future browser change had nothing behind it.

The server now decides, once, in the dispatcher, before any route or tenant is resolved:

- `Sec-Fetch-Site: cross-site` **or `same-site`** → refused (a sibling subdomain is same-site and must not drive this).
- `Origin: null` → refused (sandboxed iframe, `file://`, stripped redirect).
- A present `Origin` must equal the trusted origin **exactly** — scheme and port included, no prefix matching.
- A request claiming `same-origin` while carrying a foreign `Origin` → refused (the stricter signal wins).
- **No `Origin` at all → allowed**, and this is the deliberate part: a browser sends `Origin` on every mutating request,
  so what does not is a non-browser client — `curl`, an operator tool, the Stripe webhook. None can be induced by a
  third-party page, and refusing them would break documented tooling while adding no protection.

The trusted origin comes from `TICKMARK_PUBLIC_URL` when it parses, else from the request's own headers, so a
proxy-terminated TLS connection and a local trial both work. **Writing the tests found a bug in my own first version:**
`originOf` returns a malformed public URL verbatim, so a typo would have been compared against every browser's real
origin and refused every form in the product. The header logic is now extracted and a value that does not parse falls
back to it.

### S-02 — an email attachment silently left the encrypted boundary (`Medium` → **fixed by disclosure**)

The opening and reminder forms both offer "Attach a file", which is an ordinary email attachment: not encrypted,
retained by the provider and the recipient, and not recallable. The label said it "is not kept anywhere" — true of
Tickmark and irrelevant to the two mailboxes that now hold a copy.

The feature is kept (it is the right way to send a letter) and the boundary is now stated **on the form, above the
submit button**, naming what to use instead. Rendering tests assert the warning on both forms.

### S-06 / role handling — a corrupt role read as the owner (`Medium` → **fixed**)

`rankOf` answered any unrecognised value with owner privileges, reasoning that failing closed would silently strip a
member of access. That was wrong in the one direction that matters: one corrupted character could hand somebody the keys
to every document. It also **disagreed with the database** — `ownersOf` has always counted only `role = 'owner' OR role
IS NULL` — so the SQL and the application held different opinions about the same row.

An unrecognised value is now denied (no gated route, no key), `roleName` says "Unrecognised" rather than "Owner", and
the members page warns the owner and names each affected row. The **documented legacy contract is preserved**: `null`
still reads as owner, so no real install loses access on upgrade. `createPractitioner`, `createInvite` and `setRole` now
refuse to *write* a value the code cannot interpret.

### S-11 / information disclosure — `/healthz` (`Low` → **fixed**)

It answered `{ok, version, practices}` to anyone, unauthenticated. On a self-hosted install the operator is the audience
and the version answers the first question they ask. In hosted mode the address is on the public internet: a version is
a fingerprint and a practice count is somebody's business. Hosted now answers `{ok:true}` — **and still touches the
database**, because a health check that skipped its only real check would be a green light with nothing behind it.

### Not a vulnerability, but not right either — `500` for a configuration state (`Low` → **fixed**)

`/integrations/{xero,quickbooks}/{connect,import,books-signal}` answered **500** when the operator had not configured the
OAuth app. That is a predictable state, reachable by any signed-in member, and it put a page into the error rate an
operator watches. Seven calls now answer **409**, matching the file's own convention for "you have not connected". No
test asserted the old behaviour, because nothing tested these pages at all.

### Stated, not silently changed

The audit's remaining mediums are **not** addressed here, because each needs a product decision rather than a patch:
integration tokens at rest (S-04), passphrase strength policy (S-06), and encryption-path coverage across every route
(S-11). They are carried into §8 with a recommendation rather than a claim.

---

## 4. Regression tests added

**+43 tests** (563 → 606). Every one asserts behaviour, not execution.

| File | New | What it pins down |
| --- | --- | --- |
| `role-hardening.test.js` | 5 | The model denies unrecognised values and keeps `null` as owner; the store refuses to write garbage; over HTTP, `/keys` and `/members` are 403 and a client document is 403, while the legacy row still gets in. |
| `cross-origin.test.js` | 15 | Every CSRF case — same-origin, foreign, sibling subdomain, `Origin: null`, absent, conflicting, scheme, port, configured origin, proxy, malformed config — as unit cases and as real requests, including the client's bearer-link upload route. |
| `r1-surfaces.test.js` | 5 | Hosted `/healthz` discloses nothing; the attachment warning is on both forms; the heading names its section. |
| `integration-views.test.js` | 6 | Both providers in all three states (unconfigured, configured, connected), including that the import brings a client book across, that a nameless row is skipped, that the books signal starts off, and that a forged callback stores nothing. |
| `templates-flow.test.js` | 2 | The template lifecycle, including that a duplicate line collapses and that deleting really deletes. |
| `keys-pages.test.js` | 1 | Every key page renders, and four malformed edits are refused **with the wrapped key byte-identical afterwards**. |
| `download-browser.test.js` | 2 | The download page through every state: wrong passphrase, one file, the archive, a server refusal, an envelope sealed to another key, an abandoned archive, and the folded panel opening when a save needs it. |
| `request-page-ux.test.js` | 3 | The disclosure is closed and the bulk download is outside it; the picker's semantics and its visible hint; the scroll edge and the no-mid-word-break rule. |
| `signin-branches.test.js` | 4 | Sign-up and sign-in refusals leave **no practice and no session** behind. |
| `browser.test.js` | 0 net | The four separate download scenarios became **one instance**, so the module is measured once and the tab's real life is modelled. |

---

## 5. Coverage and exact results

| Gate | Before | After | Threshold | Result |
| --- | --- | --- | --- | --- |
| tests | 563 | **606** | — | pass, 0 failed, 0 skipped, 0 todo |
| lines | 91.57 | **93.72** | 93 | pass |
| branches | 74.56 | **75.20** | 75 | pass |
| functions | 88.86 | **90.40** | 90 | pass |
| `check:style` / `pages` / `nav` / `docs` / `site` | pass | pass | — | pass |
| `find:unused` / `snapshot` | pass | pass | — | pass |
| restore drill | not run | **12/12** | — | pass |

Identical on Node 26.5.0 (93.72 / 75.21 / 90.40), so the check is reproducible across both runtimes.

**The audit's coverage caveat was wrong, and this matters for CI.** The audit recorded the failing gate as possibly a
Node 26 instrumentation artefact. Run on **Node 24.22.1 — the version `ci.yml` pins — the same numbers come out**
(91.57 / 74.56 / 88.86). It was a real gap in the real runtime, so `main`'s red `coverage` job was a true signal, not
noise. No threshold was lowered.

Two causes, both worth fixing on their own terms:

1. **Whole features had never been driven.** `templatePage` was 68 consecutive uncovered lines — the page a practice
   looks at when it reuses a list — plus renaming, growing, trimming and deleting a template. Six key-page handlers had
   never been called at all.
2. **Four scenarios were measured as one.** `test/fake-dom.js` loads a page through a cache-busting query, so each
   `load()` is a *separate instrumented script*; its own header says so. `test/browser.test.js` loaded `download.js`
   four times, one scenario each, so three counted for nothing. They are now one instance walked through its states.

Margin note, stated because it is thin: branches land at **75.20** against a 75 floor. The next milestone should add
headroom rather than sit this close — `client-portal.js` (83% branches) and `signin-views.js` (69%) are where the
uncovered ones are.

---

## 6. UI changes, and the honest gap

**Done and asserted:**

- **The passphrase panel folds away.** It occupied the middle of the request page — a full-width card with a password
  field — on the screen a practice opens several times a day just to see whether anything has arrived. It is now a
  `<details>` disclosure, closed on arrival, opened by the page's own script at the moment a save needs a key, with the
  field focused. A disclosure rather than a dialog: no focus trap to get wrong, Escape is the browser's own. The field,
  the unlock button, the failure messages and the tab-lifetime of the unlocked key are unchanged.
- **"Download everything" moved outside the fold**, because it is what most practices came for. Asserted to appear
  *above* the disclosure rather than inside it.
- **The document table shows that it scrolls.** Below ~44rem it was a scroll region with no visible edge: the last
  column simply stopped, with a review button waiting off-screen. Two gradients pinned to the content and two shadows
  pinned to the box mean an edge appears only while there is something to scroll to.
- **Review controls no longer break mid-word.** `white-space: nowrap` on buttons in cells and a wrapping row — the
  audit's finding fixed as a layout change rather than hidden behind a scroll.
- **The client's picker says what it takes.** `accept="image/*,application/pdf"` is invisible: the picker filters and
  nothing explains why a file is greyed out. One line of plain English now says a photo or a PDF is fine, and that more
  than one can be chosen. `multiple`, `accept`, the per-document `aria-label`, the note field and the live status region
  are untouched. No dependency was added.
- **The heading above the close controls describes them**: "Close this request, or do it again", not "The file itself".

**The gap: no new screenshots.** The audit's before-images live in
`audit/2026-11-independent-review/evidence/screens/`. Capturing after-images needs a browser session on this machine
(each 1282×741 capture cost ~60 s in the audit, and longer runs hung), and it was not done in this milestone. So the
claims above are verified by **markup and style-contract tests**, not by eye — which is why the verdict is PARTIAL
rather than PASS. A reviewer should capture four images before quoting any of this as a visual improvement: the request
page at 390, 730 and 1282 px, and the client page.

---

## 7. Backup, email, and production configuration

**Backup and restore: proven for a self-hosted install.** `docs/reviews/evidence/r1-restore-drill.mjs` runs the whole
chain on fictional data: seed a practice over HTTP with a real key and a real encrypted upload → `tools/backup.mjs` →
`--verify` → restore into a fresh directory → read the practice key **out of the restored database** → unwrap it with the
passphrase → decrypt the file **out of the restored blob directory**. **12 of 12 checks.**

It found a real trap, now documented rather than discovered by an operator at 2 a.m.:

> `upload.storage_path` holds an **absolute** path from the machine the backup was taken on. `--verify` knows this and
> compares only the last two path segments. The application reads the column directly. **A restore into a different
> directory therefore opens a perfectly healthy database in which every download fails** — a restore that looks complete
> and delivers nothing. `docs/operations.md` now has the one statement that rebases the paths, and the drill runs it.

**Email: unverified against a real relay.** The SMTP client is covered by a hand-written local relay
(`test/mail-tls.test.js`, `test/mail.test.js`), including STARTTLS and an `RCPT TO` refusal. No real relay has carried a
Tickmark message and no credentials were requested. STARTTLS against a real certificate chain, real AUTH, asynchronous
bounces, provider rate limits and Outlook rendering are all **unproven**. The full qualification procedure, with
SPF/DKIM/DMARC/PTR, is in `R1_OPERATOR_QUALIFICATION.md` §1.

**Production configuration:** reviewed and recorded in `R1_OPERATOR_QUALIFICATION.md` §2. Two items changed in R1 —
hosted `/healthz`, and `TICKMARK_PUBLIC_URL` becoming load-bearing for CSRF. One item is a **decision, not a defect**:
there is no startup check that refuses to boot without a public URL, because the app cannot tell a LAN trial from a
public host and refusing a first run is worse than a warning. Recommended instead: one log line at boot.

---

## 8. Remaining risks

Ordered by what would hurt most, with an honest owner for each.

| # | Risk | Severity | Why it is still open |
| --- | --- | --- | --- |
| R-01 | **Email has never been carried by a real relay.** | High for hosted | no credentials; procedure written, unexercised |
| R-02 | **No off-site restore.** | High for hosted | no Restic repository and no paid account, deliberately |
| R-03 | **No bounce or complaint handling.** A mistyped client address fails silently. | Medium | needs a relay's suppression API; product decision |
| R-04 | **Integration tokens are stored at rest in plaintext** (audit S-04). | Medium | needs a product decision about where the key lives |
| R-05 | **Passphrase strength is a floor, not a policy** (audit S-06). | Medium | a policy change affects existing practices |
| R-06 | **The rebase step after a restore** is manual and documented, not automated. | Medium | a tool that rewrote paths could also hide a mistake |
| R-07 | **Branch coverage margin is 0.20 pp.** | Low | sits near the floor; add headroom next |
| R-08 | **No fresh UI screenshots; no screen reader, no physical device.** | Low but unresolved | needs a browser session and real hardware |
| R-09 | **Docker was not run.** Container identity, volume layout and health check are reviewed, not executed. | Low | no Docker in this environment |

---

## 9. Rollback

The branch is local and unpushed; nothing in production has changed.

```
git switch main                     # the audit commit 433762c is HEAD there
git branch -D feat/r1-trust-and-beta-readiness
```

The only state R1 touched is the working tree and one local branch. No migration was added, so no database is
altered by the code in this branch — a checkout back to `main` needs no data step. If the branch has already been
deployed somewhere (it should not have been), the rollback is: restore the pre-upgrade backup, check out the previous
release, start. Nothing in this milestone changes the schema.

---

## 10. Recommended next milestone

R1 was foundational. The next one should be **evidence, not engineering**:

1. **Qualify a real relay** and close R-01/R-03 — the operator procedure exists, and it takes half a day with
   credentials.
2. **Prove one off-site restore** and close R-02 — one Restic repository, one drill, one decrypted document.
3. **Run three private-beta practices** using `R1_PRIVATE_BETA_PACK.md`, and record the four numbers: onboarding
   unaided, clients uploading unaided, reminders per request, willingness to pay at a stated price.
4. **Then** decide pricing. The audit found Tickmark's documented £49/mo sitting ~60% above Content Snare's $35 anchor —
   that is a pricing problem to be solved with the number from measure 6, not a feature problem.
5. **Small engineering, in the gaps:** a boot log line for `TICKMARK_PUBLIC_URL`, branch-coverage headroom, bounce
   handling, and a decision on integration tokens at rest.

Do not start the rebrand, and do not build electronic signatures or AI document processing. Nothing in the beta
evidence so far suggests either is what a small practice is waiting for.

---

## 11. What was deliberately not done

- **No push, merge or deploy.** Awaiting explicit owner approval, as instructed.
- **No new dependency, framework, database or permission system.**
- **No screenshots, no container run, no real relay, no real SMS, no Stripe, no real remote restore.** Each is listed
  above as unverified rather than implied by a green tick.
- **No invented feedback or commercial claim.** The beta pack names the measures; it does not report results.
- **The audit directory, `review/`, every branch and the one stash are untouched.**

---

## 12. Publication

- **Branch:** `feat/r1-trust-and-beta-readiness`, pushed to `origin` for review. **Not merged**; `main` is unchanged at
  `433762c`.
- **Compare against the audit:**
  `https://github.com/Caseymccallum/tickmark/compare/433762c...feat/r1-trust-and-beta-readiness`
- **Pre-publication audit of the branch itself:** eight commits, no credential-shaped literal, no `.env`/`.db`/`.sqlite`/
  `.bin`/`.log` file, no absolute path from the machine it was written on, and every test address on a reserved domain
  (`.example`, `.test`). `audit/`, `review/`, `ops/`, `site/`, `.github/`, `package.json` and the Docker files are
  byte-identical to `433762c`.
- **Head SHA is deliberately not written here.** It changes every time this file is amended, and a document that names
  its own commit is a document that is wrong by the second edit. The SHA is on the compare page and in the release
  message that accompanies the push.

**Next step, per the owner:** independent review of this branch — role handling, CSRF edge cases, the encryption
workflows, and the restore-path portability issue in §7 — followed by visual verification of the updated app before any
merge. The branch and its evidence are to be **preserved, not deleted**, while that happens.

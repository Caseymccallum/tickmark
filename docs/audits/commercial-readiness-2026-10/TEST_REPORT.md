# Test report

**Environment:** Windows PowerShell, audited commit 2d1cd52770dd794986fcfb8a31121a07d91b9630; no customer data.

| Command | Result |
|---|---|
| npm test | PASS: 506 tests, 0 failures, about 48.5 seconds |
| npm run check:pages | PASS: 42 pages structurally sound |
| npm run check:site | PASS: 9 sections, 7 questions; 61 KB |
| npm run find:unused | PASS: 386 exports, none unused |
| npm run check:style | PASS: 340 rules, measured pairs AA, tightest 4.68:1 |
| npm run check:docs | PASS: docs linked and counts agree |
| npm run check:nav | PASS: tested pages reachable |
| npm run check:container | NOT VERIFIED: assumed localhost:3000 returned HTTP 500; no valid app result |
| npm run coverage | FAIL: 90.90% lines and 75.66% functions are below configured 93% / 90% thresholds; branches 88.89% exceed the 75% threshold |

First sandboxed test attempt failed because Node subprocesses were denied (EPERM); rerun with process permission passed. Static checks are not security or WCAG proof.

Coverage includes HTTP integration, cross-practice fixtures, upload/crypto, invites, account recovery/TOTP, Stripe stubs, SMTP/TLS local test servers, and backup/restore decrypt. Browser scripts use fake DOM, not real-device testing.

Not established: actual Stripe test account/Stripe-sent event, live SMTP/SMS deliverability, TLS/proxy deployment, independent pentest or crypto review, malware scanning, load at customer scale, manual assistive-technology audit, or deployed off-host backup restore. No standalone typecheck/lint script exists. Empty dependency list means no npm dependency scan applies; base image still needs patch management.

# Launch decision: REMEDIATION REQUIRED

Do not accept sensitive client documents in public hosted service on this baseline. Combined gaps: unthrottled hosted login, unusable TOTP re-authentication, incomplete hosted staff invitation lifecycle, no tenant-wide storage cap, no customer export/deletion/retention flow, and no evidenced scheduled/monitored off-host backup or hosted data-processing package.

This does not mean crypto is broken or tenants currently cross-read. Per-tenant files and tests are strengths; safe custody also requires identity, capacity, recovery and customer lifecycle.

| Option | Decision |
|---|---|
| A: immediate pilot with real documents | No |
| B: remediation, then private pilot | Recommended for real data |
| C: further validation | Run in parallel with synthetic demo and ten interviews |

Synthetic demo is appropriate on disposable local/verified HTTPS environment. Use synthetic names/files, show create→link→upload→review→reminder→decrypt/export, and state billing/trial/backup/support are not production-verified.

Real-document gates: working hosted login/TOTP/invites/revocation; throttles/quotas/alerts; TLS/canonical host; Stripe/mail proof; customer export/delete/retention; DPA/privacy/subprocessor/incident terms; off-host restore drill; access control and support contact.

Abandon/reposition if fewer than 3/10 qualified buyers describe frequent meaningful pain, most are satisfied with an included suite, none will test/pay £19 after demonstration, privacy is irrelevant, all require broad integration/multi-entity functionality, or support makes unit economics untenable.

Next 7 days: ten discovery conversations and synthetic demo; do not repeat trial claim.
Next 14 days: choose remediation, get hosting/backup/legal/insurance quotes, test onboarding with five users.
Next 30 days: finish identity/storage/operations gates, Stripe test/restore drills, decide whether 1–3 practices enter bounded pilot.

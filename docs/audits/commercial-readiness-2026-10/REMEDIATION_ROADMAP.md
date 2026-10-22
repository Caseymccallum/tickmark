# Remediation roadmap (not implemented)

## 1. Hosted identity and tenant boundary

Likely components: tenancy gateway/registry/resolver, entry, member views and auth. Add login throttle, hosted invitation/account/membership claim, usable TOTP challenge and coherent recovery/removal. Test two tenants, invitation expiry/replay/keyless role, repeated login, TOTP and removed member. Add registry migrations with backup first. Exit only when no hosted member is stranded or admitted without live membership.

## 2. Storage and data lifecycle

Add tenant aggregate quota, alert thresholds, safe refusal before spooling, orphan cleanup, tenant export/deletion and retention/backup expiry. Test concurrent quota, full disk, interrupted upload, export completeness and deletion. Derive current usage before enabling caps; never delete on rollback. Exit when disk exhaustion is bounded and customer can export/delete.

## 3. Hosted operations

Verify Docker/TLS host, canonical URL, off-host scheduled backup, alert on failure, restore playbook, redacted logs, incident/support route. Test isolated container, backup failure, restore, proxy/cookie headers. Snapshot before migration; rollback by restore. Exit with measured recovery time and no production data in tests.

## 4. Billing and service terms

Choose trial/price/tax behaviour; add webhook idempotency/order handling; prepare privacy/DPA/subprocessor/location/retention/cancellation terms with legal review. Test Checkout, no-card trial, invoice, cancel, failed/recovered card, replay/order, portal/refund. Rollback by disabling signup while preserving tenants/data. Exit when observed lifecycle matches published offer.

## 5. Onboarding and UX

One supported path to first synthetic request; clear passphrase/recovery; accessible mobile uploads/retry; test with five first-time users and assistive technology. Keep crypto format unchanged unless migration is designed.

## 6. Pilot evidence/release

Complete all 506 tests/static gates, independent cross-tenant and crypto review, restore/recovery and incident tabletop. Pilot with 1–3 firms; only accept real documents after contracts and operating gates. Exit on repeat workflows, willingness to pay and support load evidence.

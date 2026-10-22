# Billing audit

Hosted gateway supports account signup/login, Stripe Checkout, customer portal, webhook signature verification and status/access changes. Price is entirely selected by STRIPE_PRICE_ID; no amount is hardcoded. The service does not prove any current paying customer.

**14-day no-card trial is not implemented:** **src/tenancy/stripe.js:createCheckoutSession** sends recurring subscription checkout fields but no subscription trial setting. Code should not be treated as trial-enabled because a price exists. The advertised £49 is only true if configured Stripe Price actually has intended amount/currency/interval and tax behaviour.

Failed-payment grace defaults to 14 days, cancellations lock access immediately. No automatic data deletion. Refund/tax invoice/VAT workflows are delegated to Stripe configuration/support; Tickmark has no own tax engine/refund runbook.

Webhook validates HMAC and 5-minute timestamp on raw body. No event ID deduplication/ordering ledger exists. Same-status repeat is usually idempotent, but stale event ordering can set wrong state; invoice.payment_succeeded directly activates tenant. Abandoned signups leave pending tenant rows. Real Stripe checkout/event drive is not established; docs/saas.md says use test-mode drill.

Required: decide offer; implement or remove trial claim; configure intended price/tax; record event IDs and handle ordering; test replay/out-of-order, failed/recovered/cancelled payment, grace, portal/refund/invoice; run Stripe test account and CLI-signed event. Keep live keys private.

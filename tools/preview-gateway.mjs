/**
 * Render the gateway's pages to `tmp-gateway/`, so the SaaS front door can be looked at without a Stripe account.
 *
 * The portal pages exist only when `MULTI_TENANT=1`, and reaching them by hand needs a signup, a tenant, a mapped
 * host and — for two of the four states — a webhook that has fired. This renders each state directly instead, which
 * is the only practical way to review the page a *locked-out* practice sees.
 *
 *   node tools/preview-gateway.mjs [output-dir]
 *
 * The nonce is stamped here with a stand-in value. The server does that in `sendPage`, which this tool bypasses — and
 * a page left holding an un-stamped placeholder is a page whose styling a browser silently discards, which is also
 * what `npm run check:pages` refuses. CI renders these states and runs that checker over them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { NONCE_PLACEHOLDER } from '../src/views.js';
import { billingWallPage, dashboardPage, loginPage, signupPage, simplePage } from '../src/tenancy/views.js';

const out = process.argv[2] ?? 'tmp-gateway';
mkdirSync(out, { recursive: true });

const tenant = { name: 'Acme Accounting', plan: 'standard', status: 'pending_payment' };
const account = { email: 'sam@acme.example' };
const at = 'http://acme.localhost:3000';

const pages = {
  'signup': signupPage({ billingReady: true }),
  'signup-no-billing': signupPage({ billingReady: false }),
  'signup-with-an-error': signupPage({ problem: 'That email address already has a practice. Sign in instead.', billingReady: true, values: { email: 'sam@acme.example', practice_name: 'Acme Accounting' } }),
  'login': loginPage({}),
  'login-refused': loginPage({ problem: 'That email and password do not match.', values: { email: 'sam@acme.example' } }),
  'dashboard-pending': dashboardPage({ account, tenant, tenantUrl: at }),
  'dashboard-active': dashboardPage({
    account,
    tenant: { ...tenant, status: 'active' },
    tenantUrl: at,
    customerConfigured: true,
    notice: 'Thank you — your workspace is open.',
  }),
  'dashboard-past-due': dashboardPage({
    account,
    tenant: { ...tenant, status: 'past_due' },
    tenantUrl: at,
    customerConfigured: true,
  }),
  'dashboard-no-workspace': dashboardPage({ account, tenant: null, tenantUrl: '/signup' }),
  'wall-pending': billingWallPage({
    tenant,
    status: {
      heading: 'Your subscription is not set up yet',
      detail: 'Finish setting up your subscription and your workspace opens straight away.',
    },
  }),
  // The same wall for somebody who *is* signed in — the header change is the whole point of passing the account, and
  // it is the state a locked-out practice actually sees in their own browser.
  'wall-signed-in': billingWallPage({
    tenant,
    status: {
      heading: 'Your subscription is not set up yet',
      detail: 'Finish setting up your subscription and your workspace opens straight away.',
    },
    account,
  }),
  'wall-past-due': billingWallPage({
    tenant: { ...tenant, status: 'past_due' },
    status: {
      heading:
        'Your subscription is currently inactive. Please update your payment details to access your documents.',
      detail: 'The last payment did not go through. Nothing has been deleted — your documents are waiting.',
    },
  }),
  'wall-cancelled': billingWallPage({
    tenant: { ...tenant, status: 'cancelled' },
    status: {
      heading:
        'Your subscription is currently inactive. Please update your payment details to access your documents.',
      detail: 'The subscription has ended. Start it again and your workspace comes straight back.',
    },
  }),
  'error': simplePage('Billing', 'Stripe refused that', 'No such price.'),
};

for (const [name, rendered] of Object.entries(pages)) {
  writeFileSync(`${out}/${name}.html`, rendered.value.replaceAll(NONCE_PLACEHOLDER, 'nonce="preview"'));
}

console.log(`wrote ${Object.keys(pages).length} pages to ${out}`);

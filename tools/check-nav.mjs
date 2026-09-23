/**
 * What can be reached from where, on the public pages.
 *
 *   node tools/check-nav.mjs
 *
 * Answers a question that is easy to get wrong by looking: **is every page a person needs actually reachable from
 * where they will be standing?** A page that exists but nothing links to is a page that does not exist, and the
 * gateway is where that goes unnoticed — there is no sidebar to notice it in, and half its states are only reachable
 * after a webhook has fired.
 *
 * Two things are reported and both are failures:
 *
 * - **A dead end.** A rendered page with no way onward at all: no link, no form, and no way back to the dashboard.
 *   A person who lands there is stuck with the browser's Back button.
 * - **An unreachable page.** A route that is rendered somewhere in this file but that no rendered page links to.
 *   `/webhooks/stripe` is excluded because Stripe calls it and nobody clicks it, and so are the redirect targets.
 *
 * It reads the real view functions rather than a fixture, so it cannot drift from what is served.
 */
import { billingWallPage, dashboardPage, loginPage, signupPage, simplePage } from '../src/tenancy/views.js';

const tenant = { name: 'Acme Accounting', plan: 'standard', status: 'pending_payment' };
const account = { email: 'sam@acme.example' };
const at = 'http://acme.localhost:3000';

/** Every rendered state, and the routes only reachable by a redirect or by Stripe. */
const pages = {
  '/signup': signupPage({ billingReady: true }),
  '/login': loginPage({}),
  '/dashboard': dashboardPage({ account, tenant, tenantUrl: at }),
  '/dashboard (active)': dashboardPage({ account, tenant: { ...tenant, status: 'active' }, tenantUrl: at }),
  '/dashboard (no workspace)': dashboardPage({ account, tenant: null, tenantUrl: '/signup' }),
  '/subscription (wall)': billingWallPage({
    tenant,
    status: { heading: 'Your subscription is not set up yet', detail: 'Finish setting up your subscription.' },
  }),
  '/subscription (wall, signed in)': billingWallPage({
    tenant,
    status: { heading: 'Your subscription is not set up yet', detail: 'Finish setting up your subscription.' },
    account,
  }),
  '/error': simplePage('Billing', 'Stripe refused that', 'No such price.'),
  '/error (signed in)': simplePage('Billing', 'Stripe refused that', 'No such price.', { account }),
};

/** Routes that exist but are not reached by clicking. */
const byMachine = new Set(['/billing/checkout/success', '/webhooks/stripe']);

const outbound = (markup) => {
  const found = new Set();
  for (const match of markup.matchAll(/href="([^"#]+)"/g)) {
    // The favicon is a data URI, not a way to go anywhere.
    if (!match[1].startsWith('data:')) found.add(match[1]);
  }
  for (const match of markup.matchAll(/action="([^"]+)"/g)) found.add(`(post) ${match[1]}`);
  return [...found];
};

const rendered = Object.entries(pages).map(([name, page]) => {
  const markup = page.value;
  const links = outbound(markup);
  // The header is where navigation lives; a page whose only link is in its prose has no navigation.
  const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
  return { name, markup, links, headerLinks: outbound(header), header };
});

let failed = false;

console.log('navigation, per page\n');
for (const page of rendered) {
  // Redirects out of the portal are ways onward too — a form that posts to /logout is a way out.
  const onward = page.links.filter((href) => href !== '/');
  const dead = onward.length === 0;
  if (dead) failed = true;
  console.log(`  ${page.name}`);
  console.log(`      header: ${page.headerLinks.length === 0 ? '(nothing)' : page.headerLinks.join('  ')}`);
  console.log(`      page:   ${page.links.join('  ')}`);
  if (dead) console.log('      ** DEAD END — nothing to click and nowhere to go');
}

// Does anything link to the pages that matter? Searched in the **raw markup**, because the extracted link list has
// already stripped the `href="` that this is looking for — the first version of this check searched the stripped
// list and reported every page as orphaned, which was the check being wrong rather than the pages.
const everything = rendered.map((page) => page.markup).join('\n');
console.log('\nis every page reachable from somewhere?\n');
for (const [route, name] of [
  ['/signup', 'sign up'],
  ['/login', 'sign in'],
  ['/dashboard', 'the account dashboard'],
  ['/billing/portal', 'the payment-details button'],
  ['/billing/checkout', 'the subscribe button'],
  ['/logout', 'sign out'],
]) {
  const linked = new RegExp(`(href|action)="${route}([?"]|$)`).test(everything);
  const excluded = byMachine.has(route);
  if (!linked && !excluded) failed = true;
  console.log(`  ${linked ? 'reached' : excluded ? 'by machine' : '** ORPHANED'}  ${route.padEnd(20)} ${name}`);
}

console.log(failed ? '\n  something is unreachable\n' : '\n  every page is reachable and none is a dead end\n');
process.exit(failed ? 1 : 0);

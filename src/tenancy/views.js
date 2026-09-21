/**
 * The public pages: sign up, sign in, the dashboard, and the billing wall.
 *
 * These are the only pages in the product that are about *accounts* rather than about documents,
 * and they exist only when `MULTI_TENANT=1` — the self-hosted server has no gateway and never
 * loads this file. They are rendered through the core's own `page()`/`html`, so escaping, styling
 * and the header are the same everywhere; what differs is that these pages are reached before a
 * practice is known, so the header has no practice in it.
 */
import { html, page } from '../views.js';

/** A page with no practice header — the shape every gateway page shares. */
const gatewayPage = (title, body, banner = null) => page({ title, body, banner });

export function signupPage({ values = {}, problem = null, billingReady = false }) {
  return gatewayPage(
    'Sign up',
    html`
      <div class="hero">
        <p class="eyebrow">A workspace of your own</p>
        <h1>Start your practice</h1>
        <p class="lead">Your own database file, your own passphrase. Nothing about your clients'
        documents is readable by whoever runs this server.</p>
      </div>
      ${problem ? html`<p class="error">${problem}</p>` : ''}
      ${billingReady
        ? ''
        : html`<p class="warning"><strong>Payments are not configured on this installation.</strong>
            You can still create a workspace, and you will be able to finish setting up billing
            once the operator has configured it.</p>`}
      <form method="post" action="/signup" class="card narrow">
        <label for="practice_name">Your practice</label>
        <input id="practice_name" name="practice_name" required value="${values.practice_name ?? ''}"
          placeholder="Acme Accounting" autofocus>
        <p class="note">This becomes your address here, and can be changed later.</p>
        <label for="email">Your email</label>
        <input id="email" name="email" type="email" required value="${values.email ?? ''}">
        <label for="password">A password <span class="note">at least 12 characters</span></label>
        <input id="password" name="password" type="password" required autocomplete="new-password">
        <button type="submit" class="primary">Create the workspace</button>
      </form>
      <p class="note">Already have one? <a href="/login">Sign in</a>.</p>`,
  );
}

export function loginPage({ values = {}, problem = null }) {
  return gatewayPage(
    'Sign in',
    html`
      <div class="center">
        <div class="card">
          <h1>Sign in</h1>
          ${problem ? html`<p class="error">${problem}</p>` : ''}
          <form method="post" action="/login">
            <label for="email">Your email</label>
            <input id="email" name="email" type="email" required value="${values.email ?? ''}"
              autocomplete="username" autofocus>
            <label for="password">Your password</label>
            <input id="password" name="password" type="password" required autocomplete="current-password">
            <button type="submit" class="primary">Sign in</button>
          </form>
          <p class="note">No workspace yet? <a href="/signup">Start one</a>.</p>
        </div>
      </div>`,
  );
}

/**
 * The dashboard: one practice, and the state of its subscription.
 *
 * Deliberately not a list of practices. A tenant is reached through its own address, and this page
 * is where a signed-in person is told which address that is — with a link, because making somebody
 * remember a hostname is how a working product feels broken.
 */
export function dashboardPage({ account, tenant, tenantUrl, customerConfigured = false, notice = null }) {
  return gatewayPage(
    'Your workspace',
    html`
      <h1>${tenant?.name ?? 'Your workspace'}</h1>
      ${notice ? html`<p class="success">${notice}</p>` : ''}
      ${!tenant
        ? html`<p class="warning">This account is not a member of any workspace yet.
              <a href="/signup">Start one</a>, or ask a colleague to invite you.</p>`
        : html`
            <p class="note">Signed in as <strong>${account.email}</strong>.</p>
            <table>
              <tbody>
                <tr><th align="left">Address</th><td><a href="${tenantUrl}">${tenantUrl}</a></td></tr>
                <tr><th align="left">Plan</th><td>${tenant.plan}</td></tr>
                <tr><th align="left">Subscription</th><td>${tenant.status.replace('_', ' ')}</td></tr>
              </tbody>
            </table>
            <p><a href="${tenantUrl}"><strong>Open your workspace</strong></a> — your requests, keys
            and documents are there.</p>`}
      ${tenant ? html`<h2>Subscription</h2>${subscriptionBlock({ tenant, customerConfigured })}` : ''}
      <form method="post" action="/logout" class="inline"><button type="submit">Sign out</button></form>`,
  );
}

function subscriptionBlock({ tenant, customerConfigured }) {
  if (tenant.status === 'active') {
    return html`<p class="success"><strong>Active.</strong> Your workspace is open and your
      documents are available.</p>
      ${customerConfigured
        ? html`<form method="post" action="/billing/portal" class="inline">
              <button type="submit">Change payment details</button>
            </form>`
        : ''}`;
  }
  return html`<p class="warning"><strong>This workspace is not open yet.</strong>
      Its subscription is <strong>${tenant.status.replace('_', ' ')}</strong>.</p>
    ${customerConfigured
      ? html`<form method="post" action="/billing/portal" class="inline">
            <button type="submit">Update payment details</button>
          </form>`
      : ''}
    <form method="post" action="/billing/checkout" class="inline">
      <button type="submit">Start the subscription</button>
    </form>`;
}

/**
 * The billing wall (docs/saas.md §2.6): the sentence a locked-out practice sees.
 *
 * It says what is wrong, that nothing has been lost, and gives them one button. It never mentions
 * Stripe, a webhook, or a status code — the person reading it is an accountant with a deadline.
 */
export function billingWallPage({ tenant, status }) {
  return gatewayPage(
    'Subscription',
    html`
      <h1>${tenant.name}</h1>
      <p class="warning"><strong>${status.heading}</strong></p>
      <p>${status.detail}</p>
      <form method="post" action="/billing/portal" class="inline">
        <button type="submit">Update payment details</button>
      </form>
      <form method="post" action="/billing/checkout" class="inline">
        <button type="submit">Start the subscription</button>
      </form>
      <p class="note">Signing in again is not needed: this page is about the subscription, not your
      account. If you think this is a mistake, contact whoever set up your workspace.</p>`,
  );
}

/** A one-off page for something that went wrong outside a form. */
export const simplePage = (title, heading, detail) =>
  gatewayPage(
    title,
    html`<h1>${heading}</h1><p>${detail}</p><p><a href="/dashboard">Back to your workspace</a></p>`,
  );
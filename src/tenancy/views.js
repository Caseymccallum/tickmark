/**
 * The public pages: sign up, sign in, the dashboard, and the billing wall.
 *
 * These are the only pages in the product that are about *accounts* rather than about documents,
 * and they exist only when `MULTI_TENANT=1` — the self-hosted server has no gateway and never
 * loads this file. They are rendered through the core's own `page()`/`html`, so escaping, styling
 * and the header are the same everywhere; what differs is that these pages are reached before a
 * practice is known, so the header has no practice in it.
 */
/**
 * ## What a premium pass changed here, and why it was needed
 *
 * These pages were written before the design system grew up. They used bare `<h1>`, a `<table>` and
 * `status.replace('_', ' ')` while the rest of the product had tiles, badges, states and facts
 * lists — so the front door looked like a plainer product than the room behind it. That matters more
 * here than anywhere else: **this is where somebody decides whether to trust the software at all**,
 * and a page that looks unfinished reads as a project that is.
 *
 * Three rules were kept rather than loosened:
 *
 * 1. **Colour is state, never decoration.** Every icon is `currentColor` and inherits the tone of the
 *    block it sits in. There is no icon here coloured for looks.
 * 2. **A heading keeps its words.** The billing wall's sentence comes from `TENANT_STATUS` and is
 *    asserted by a test; the presentation around it changed and the sentence did not.
 * 3. **Nothing is decorative.** Every icon names a meaning — `shield` a protection claim, `clock`
 *    something pending, `arrow` a way onward.
 */
import { badge, html, icon, page, tick } from '../views.js';

/**
 * A page with no practice header — the shape every gateway page shares.
 *
 * `options.account` is the person signed in to the platform, and it decides the header. Passing it is what stops the
 * dashboard offering "Sign in" to somebody already signed in, and what gives the billing wall a way back to the
 * account and a way out. `signIn: false` on the pages that *are* the sign-in, because a link to where you already are
 * is noise.
 */
const gatewayPage = (title, body, { banner = null, account = null, signIn = true } = {}) =>
  page({ title, body, banner, account, signIn });

/**
 * How a subscription state looks: a tone for the words, a mark for the eye, and the status as a phrase
 * rather than as a database value.
 *
 * One table, so `pending_payment` cannot be a warning on the dashboard and a neutral fact on the wall — which is
 * the class of bug this project has fixed three times by now, most recently a count that disagreed with the list
 * beside it.
 */
const STATUS_LOOK = {
  active: { tone: 'ok', mark: 'tick', word: 'Active' },
  pending_payment: { tone: 'wait', mark: 'clock', word: 'Waiting for payment' },
  past_due: { tone: 'bad', mark: 'alert', word: 'Payment failed' },
  cancelled: { tone: 'bad', mark: 'alert', word: 'Cancelled' },
};

const look = (status) =>
  STATUS_LOOK[status] ?? { tone: 'off', mark: 'clock', word: String(status).replace('_', ' ') };

export function signupPage({ values = {}, problem = null, billingReady = false }) {
  return gatewayPage(
    'Sign up',
    html`
      <div class="gateway">
        <div class="hero">
          <p class="eyebrow">A workspace of your own</p>
          <h1>Start your practice</h1>
          <p class="lead">Your own database file, your own passphrase, on a server you choose — so the documents
          your clients send are not readable by whoever runs it.</p>
        </div>

        <div class="promise">
          ${icon('shield')}
          <div>
            <strong>Nobody here can read your clients' documents.</strong>
            <p class="note">They are encrypted in the client's browser before they are sent. That is not a promise
            about anybody's intentions — the server is never given the key.</p>
          </div>
        </div>

        <ul class="ticks">
          ${tick(html`A checklist per client, and a link they open without an account`)}
          ${tick(html`What is still outstanding, at a glance, for everyone at once`)}
          ${tick(html`Your own address for the workspace, and your own people in it`)}
        </ul>

        ${problem ? html`<p class="error">${problem}</p>` : ''}
        ${billingReady
          ? ''
          : html`<p class="warning"><strong>Payments are not configured on this installation.</strong>
              You can still create a workspace, and you will be able to finish setting up billing
              once the operator has configured it.</p>`}

        <form method="post" action="/signup" class="card">
          <label for="practice_name">Your practice</label>
          <input id="practice_name" name="practice_name" required value="${values.practice_name ?? ''}"
            placeholder="Acme Accounting" autofocus>
          <p class="note">This becomes your address here, and can be changed later.</p>
          <label for="email">Your email</label>
          <input id="email" name="email" type="email" required value="${values.email ?? ''}" spellcheck="false"
            autocomplete="username">
          <label for="password">A password <span class="note">at least 12 characters</span></label>
          <input id="password" name="password" type="password" required autocomplete="new-password">
          <button type="submit" class="primary">Create the workspace</button>
        </form>

        <p class="aside">Already have one? <a href="/login">Sign in</a>.</p>
      </div>`,
  );
}


export function loginPage({ values = {}, problem = null }) {
  return gatewayPage(
    'Sign in',
    html`
      <div class="gateway">
        <div class="hero">
          <p class="eyebrow">Welcome back</p>
          <h1>Sign in</h1>
          <p class="lead">Your workspace, and the documents waiting in it.</p>
        </div>

        ${problem ? html`<p class="error">${problem}</p>` : ''}

        <form method="post" action="/login" class="card">
          <label for="email">Your email</label>
          <input id="email" name="email" type="email" required value="${values.email ?? ''}" spellcheck="false"
            autocomplete="username" autofocus>
          <label for="password">Your password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password">
          <button type="submit" class="primary">Sign in</button>
        </form>

        <p class="aside">No workspace yet? <a href="/signup">Start one</a>.</p>
        <p class="aside">${icon('key')} Your passphrase is not asked for here. It opens the documents, in your
        browser, and the server never sees it.</p>
      </div>`,
    // The header's "Sign in" is suppressed here, because this *is* the sign-in page: a link to where you already are
    // is noise. On `/signup` it stays, where it is a genuine shortcut for somebody who came to the wrong page.
    { signIn: false },
  );
}

/**
 * The dashboard: one practice, and the state of its subscription.
 *
 * Deliberately not a list of practices. A tenant is reached through its own address, and this page
 * is where a signed-in person is told which address that is — with a link, because making somebody
 * remember a hostname is how a working product feels broken.
 */
export function dashboardPage({
  account,
  tenant,
  tenantUrl,
  customerConfigured = false,
  notice = null,
  noticeTone = 'success',
}) {
  return gatewayPage(
    'Your workspace',
    html`
      <div class="gateway">
        <div class="page-head">
          <div class="titles">
            <p class="crumbs">Your account</p>
            <h1>${tenant?.name ?? 'Your workspace'}</h1>
            <p class="sub">Signed in as <strong>${account.email}</strong>.</p>
          </div>
        </div>

        ${notice ? html`<p class="${noticeTone}">${icon(noticeTone === 'success' ? 'tick' : 'key')} ${notice}</p>` : ''}
        ${!tenant
          ? html`<div class="state">
                ${icon('person', 22, 'off')}
                <div>
                  <h2>No workspace yet</h2>
                  <p class="note">This account is not a member of one. Start your own, or ask a colleague to invite
                  you to theirs.</p>
                </div>
                <div class="do"><a class="btn" href="/signup">Start a workspace</a></div>
              </div>`
          : html`
              ${subscriptionBlock({ tenant, customerConfigured })}

              <section class="card tight">
                <h2>The workspace</h2>
                ${/* Address and plan only. The subscription is *state*, and it is already said once at the top in a
                      badge — a second copy in a table labelled with the same word is the same fact twice, which is
                      how a page starts looking like a dashboard rather than a page. */ ''}
                <dl class="facts">
                  <dt>Address</dt>
                  <dd><a href="${tenantUrl}">${tenantUrl}</a></dd>
                  <dt>Plan</dt>
                  <dd>${tenant.plan === 'standard' ? 'Standard' : tenant.plan}</dd>
                </dl>
                <p class="onward">${icon('arrow')}
                  <a href="${tenantUrl}">Open your workspace</a>
                  <span class="note">— your requests, keys and documents are there.</span></p>
              </section>`}

        <form method="post" action="/logout" class="inline"><button type="submit" class="ghost">Sign out</button></form>
      </div>`,
    // The header, not the body, carries the account: "Your account" and a way out. Before this the dashboard's header
    // offered "Sign in" to somebody who was already signed in, and the only way out was a button at the bottom of the
    // page — which is the sort of thing a person notices as "this feels unfinished" without being able to say why.
    { account },
  );
}

/**
 * The subscription, as a state rather than a paragraph.
 *
 * `empty()` would be the obvious component here and it is the wrong one: this is not a list with nothing in it,
 * it is one thing with a status, and the difference shows in the words. A practice that is paid up reads "Active" and
 * gets a link to their workspace; one that is not reads what is wrong and gets the one button that fixes it.
 *
 * **"not open yet" is load-bearing.** A test asserts that phrase on this page, and it is also the honest one: the
 * workspace exists, the data is there, and what is missing is the subscription. "Suspended" or "locked" would
 * suggest something was taken away.
 */
function subscriptionBlock({ tenant, customerConfigured }) {
  const { tone, mark, word } = look(tenant.status);
  const active = tenant.status === 'active';

  return html`<section class="card">
    <div class="state">
      ${icon(mark, 22, tone)}
      <div>
        <h2>${active ? 'Active' : 'This workspace is not open yet'}</h2>
        <p class="note">${active
          ? 'Everything is working. Your documents are available.'
          : html`The subscription is <strong>${word.toLowerCase()}</strong>.`}</p>
      </div>
      <div class="do">
        ${badge(word, tone)}
      </div>
    </div>

    ${active
      ? customerConfigured
        ? html`<div class="actions">
              <form method="post" action="/billing/portal" class="inline">
                <button type="submit">${icon('card')} Change payment details</button>
              </form>
            </div>`
        : ''
      : html`<div class="actions">
            <form method="post" action="/billing/checkout" class="inline">
              <button type="submit" class="primary">${icon('card')} Start the subscription</button>
            </form>
            ${customerConfigured
              ? html`<form method="post" action="/billing/portal" class="inline">
                    <button type="submit">Update payment details</button>
                  </form>`
              : ''}
          </div>`}
  </section>`;
}

/**
 * The billing wall (docs/saas.md §2.6): the sentence a locked-out practice sees.
 *
 * It says what is wrong, that nothing has been lost, and gives them one button. It never mentions Stripe, a
 * webhook, or a status code — the person reading it is an accountant with a deadline.
 *
 * The heading and detail come from `TENANT_STATUS` in `gateway.js` rather than being written here, so the words a
 * practice is locked out with and the words this page shows cannot drift apart. **The tone is derived from the same
 * lookup the dashboard uses**, which is why a failure looks the same wherever it is met.
 */
export function billingWallPage({ tenant, status, account = null }) {
  const { tone, mark, word } = look(String(tenant.status));
  return gatewayPage(
    'Subscription',
    html`
      <div class="gateway">
        <div class="state">
          ${icon(mark, 26, tone)}
          <div>
            <h1>${tenant.name}</h1>
            <p class="sub">${badge(word, tone)}</p>
          </div>
        </div>

        <div class="card">
          <h2>${status.heading}</h2>
          <p>${status.detail}</p>

          <div class="actions">
            <form method="post" action="/billing/portal" class="inline">
              <button type="submit" class="primary">${icon('card')} Update payment details</button>
            </form>
            <form method="post" action="/billing/checkout" class="inline">
              <button type="submit">Start the subscription</button>
            </form>
          </div>
        </div>

        <div class="promise quiet">
          ${icon('shield')}
          <div>
            <strong>Nothing has been lost, and nothing is at risk.</strong>
            <p class="note">Your documents are where they were, encrypted, and every client link still works.
            Signing in again is not needed: this is about the subscription, not your account. If you think it is a
            mistake, contact whoever set up your workspace.</p>
          </div>
        </div>

        ${/* A way onward that is not billing. The wall is reachable from a practice's own address, where the person
              may be an accountant with no platform session at all — so this is a link rather than an assumption, and
              the header still offers a sign-in for whoever has not got one. */ ''}
        <p class="onward">${icon('arrow')} <a href="/dashboard">Your account</a>
          <span class="note">— invoices, payment details and the address of your workspace.</span></p>
      </div>`,
    { account },
  );
}

/** A one-off page for something that went wrong outside a form. */
export const simplePage = (title, heading, detail, { account = null } = {}) =>
  gatewayPage(
    title,
    html`
      <div class="gateway">
        <div class="state">
          ${icon('alert', 26, 'bad')}
          <div><h1>${heading}</h1></div>
        </div>
        <div class="card"><p>${detail}</p></div>
        <p class="onward">${icon('arrow')} <a href="/dashboard">Back to your account</a></p>
      </div>`,
    { account },
  );
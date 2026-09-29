/**
 * Connecting a practice to QuickBooks, and bringing their client book across.
 *
 * The UI and route half of the QuickBooks integration; the OAuth plumbing and the transform live in
 * `tenancy/quickbooks.js`, and the import is the *same* ingestion pipeline a CSV and a Xero import use.
 * Structurally it is `xero-views.js` with two QuickBooks wrinkles:
 *
 * - **`realmId`** — QuickBooks scopes everything to a company and hands the id back on the callback as a
 *   query parameter, so it is captured and kept beside the tokens (`connection.external_id`), and the
 *   client list is queried against it.
 * - **The source is richer** — a QuickBooks Customer carries `DisplayName` *and* `PrimaryEmailAddr`, so
 *   these rows arrive with an address, unlike Xero's names-only `connections`.
 *
 * The `state` cookie is the same CSRF guard as the Xero flow: `/connect` parks a random `state` in a
 * short-lived cookie, `/callback` refuses anything that cannot present it.
 */
import { randomBytes } from 'node:crypto';

import { parseCookies, secureCookies } from './auth.js';
import { now } from './db.js';
import { formFields, field, readBody } from './http.js';
import {
  booksSignalOn,
  connectionFor,
  deleteConnection,
  importClients,
  previewClientImport,
  saveConnection,
  setBooksSignal,
} from './store.js';
import {
  authorizationUrl,
  clientsToRows,
  exchangeCode,
  fetchQuickBooksClients,
  quickBooksFromEnvironment,
  refreshTokens,
  QuickBooksError,
} from './tenancy/quickbooks.js';
import { badge, empty, fail, html, page, redirect, requireSignIn, sendPage, TONES } from './views.js';

const STATE_COOKIE = 'tickmark_quickbooks_state';
const PROVIDER = 'quickbooks';

/** The OAuth `state`, in a cookie only this browser can read back — short-lived on purpose. */
function stateCookie(value, secure = secureCookies()) {
  const attributes = [`${STATE_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearStateCookie(secure = secureCookies()) {
  const attributes = [`${STATE_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * A usable access token for this practice, refreshing it if it has nearly expired.
 *
 * Intuit's access tokens last an hour and the refresh token rotates every use, so the refreshed pair is
 * stored immediately. A minute of margin avoids handing out a token that expires mid-call.
 */
async function freshAccessToken(db, config, connection) {
  const expiresAt = new Date(connection.expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) return connection.access_token;
  const tokens = await refreshTokens({ config, refreshToken: connection.refresh_token });
  saveConnection(db, {
    provider: PROVIDER,
    practiceId: connection.practice_id,
    externalId: connection.external_id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    scope: tokens.scope,
    at: now(),
  });
  return tokens.accessToken;
}

/**
 * The integration page: whether QuickBooks is connected, and the two things to do about it. Honest
 * about its three states — not configured, not connected, connected — for the same reason the Xero
 * page is: "the button does nothing" and "you have not set it up yet" look identical and are not.
 */
export function quickBooksPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = quickBooksFromEnvironment();
  const connection = config ? connectionFor(db, practiceId, PROVIDER) : null;
  const connected = url.searchParams.get('connected') === '1';
  const booksOn = connection ? booksSignalOn(connection) : false;

  const body = !config
    ? html`<section class="card">
        <h2>QuickBooks is not set up on this install</h2>
        <p class="note">Importing from QuickBooks needs an OAuth app registered at
        <strong>developer.intuit.com</strong>, and its client id and secret in this server's environment
        (<code>TICKMARK_QB_CLIENT_ID</code> and <code>TICKMARK_QB_CLIENT_SECRET</code>).
        <code>.env.example</code> says how. The <a href="/clients/import">CSV import</a> works regardless.</p>
      </section>`
    : connection
      ? html`<section class="card">
          <h2>Connected to QuickBooks</h2>
          <p class="note">Tickmark can read this practice's QuickBooks client list — and nothing more. The
          connection is read-only, so nothing here can change anything in your QuickBooks.</p>
          <div class="actions">
            <form method="post" action="/integrations/quickbooks/import" class="inline">
              <button type="submit" class="btn primary">Import from QuickBooks</button>
            </form>
            <a class="btn" href="/clients/import">Import a CSV instead</a>
            <form method="post" action="/integrations/quickbooks/disconnect" class="inline">
              <button type="submit" class="btn ghost">Disconnect</button>
            </form>
          </div>
        </section>
        <section class="card">
          <h2>Know whose books are behind</h2>
          <p class="note"><strong>Optional — off until you choose it.</strong></p>
          ${booksOn
            ? html`<p class="note"><strong>On.</strong> Tickmark will read a small summary of your clients'
                accounting activity to flag the books that need attention, and keep only that summary.</p>
                <div class="actions">
                  <form method="post" action="/integrations/quickbooks/books-signal" class="inline">
                    <input type="hidden" name="on" value="0">
                    <button type="submit" class="btn ghost">Turn it off</button>
                  </form>
                </div>`
            : html`<p class="note"><strong>Please read this before turning it on.</strong> Tickmark's promise is
                that it cannot read your clients' <em>documents</em> — those are encrypted in their browser and
                only you can open them. This feature does not change that, and never touches a document.</p>
                <p class="note">What it does: Tickmark reads a small <strong>summary</strong> of your clients'
                accounting activity from QuickBooks — how many bank lines are unreconciled, and when the last one
                was — to tell you whose books are behind. It is <strong>read-only</strong>, and Tickmark keeps
                only that summary, <strong>never the transactions themselves</strong>.</p>
                <p class="note">Leave it off and Tickmark reads nothing beyond your client list. Nothing at all
                is read until you choose.</p>
                <div class="actions">
                  <form method="post" action="/integrations/quickbooks/books-signal" class="inline">
                    <input type="hidden" name="on" value="1">
                    <button type="submit" class="btn">Turn it on</button>
                  </form>
                </div>`}
        </section>`
      : html`<section class="card">
          <h2>Connect to QuickBooks</h2>
          <p class="note">Bring your client book across without retyping it. Tickmark asks QuickBooks for a
          <strong>read-only</strong> view of your Customers — with their email addresses — and writes nothing
          back. You will be sent to QuickBooks to approve it and come straight back.</p>
          <div class="actions">
            <a class="btn primary" href="/integrations/quickbooks/connect">Connect to QuickBooks</a>
            <a class="btn" href="/clients/import">Import a CSV instead</a>
          </div>
        </section>`;

  return sendPage(response, 200, page({
    title: 'QuickBooks',
    practitioner,
    here: '/clients',
    body: html`
      <div class="page-head"><div class="titles">
        <h1>QuickBooks</h1>
        <p class="sub">Import your client book from QuickBooks.</p>
      </div></div>
      ${connected ? html`<p class="note"><strong>Connected.</strong> QuickBooks is linked to this practice.</p>` : ''}
      ${body}`,
  }));
}

/**
 * Turn the "books behind" signal on or off for this connection. Opt-in and reversible, and turning it on
 * reads nothing by itself — this only records the choice the practice made after reading the warning on
 * the integration page. Off is the default and the safe answer: a practice that never turns it on keeps
 * the plain promise, and Tickmark reads nothing but the client list. See docs/security.md.
 */
export async function quickBooksBooksSignal({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const connection = connectionFor(db, practiceId, PROVIDER);
  if (!connection) return fail(response, 409, 'This practice has not connected to QuickBooks yet.', practitioner);
  const fields = formFields(await readBody(request));
  setBooksSignal(db, practiceId, PROVIDER, field(fields, 'on') === '1');
  return redirect(response, '/integrations/quickbooks');
}

/**
 * Start the OAuth dance: mint a `state`, park it in a cookie, and send the practice to Intuit.
 */
export function quickBooksConnect({ response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = quickBooksFromEnvironment();
  if (!config) return fail(response, 500, 'QuickBooks is not set up on this install.', practitioner);

  const state = randomBytes(24).toString('hex');
  return redirect(response, authorizationUrl({ config, state }), [stateCookie(state)]);
}

/**
 * The other half of the OAuth dance. The `state` match is checked first (the CSRF guard); only then is
 * the code traded for tokens. QuickBooks also hands the company id (`realmId`) back here — not in the
 * token response — so it is captured and kept beside the tokens for the client-list query.
 */
export async function quickBooksCallback({ db, request, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = quickBooksFromEnvironment();
  if (!config) return fail(response, 500, 'QuickBooks is not set up on this install.', practitioner);

  const returned = url.searchParams.get('state') ?? '';
  const expected = parseCookies(request.headers.cookie)[STATE_COOKIE] ?? '';
  if (!expected || returned !== expected) {
    return fail(response, 403, 'That QuickBooks sign-in could not be verified. Start again from the QuickBooks page.', practitioner);
  }

  const code = url.searchParams.get('code') ?? '';
  if (!code) return fail(response, 400, 'QuickBooks sent no code to exchange.', practitioner);
  const realmId = url.searchParams.get('realmId') ?? '';

  try {
    const tokens = await exchangeCode({ config, code });
    saveConnection(db, {
      provider: PROVIDER,
      practiceId,
      externalId: realmId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      scope: tokens.scope,
      at: now(),
    });
    return redirect(response, '/integrations/quickbooks?connected=1', [clearStateCookie()]);
  } catch (error) {
    if (error instanceof QuickBooksError) {
      return fail(response, 502, `QuickBooks did not accept the sign-in: ${error.message}`, practitioner);
    }
    throw error;
  }
}

/**
 * Bring the client book across: fetch the QuickBooks Customers, then pour them through the same
 * preview and the same import every other source uses. The confirm re-reads the rows from the form, so
 * the run does exactly what the preview showed.
 */
export async function quickBooksImport({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = quickBooksFromEnvironment();
  if (!config) return fail(response, 500, 'QuickBooks is not set up on this install.', practitioner);
  const connection = connectionFor(db, practiceId, PROVIDER);
  if (!connection) return fail(response, 409, 'This practice has not connected to QuickBooks yet.', practitioner);

  const fields = formFields(await readBody(request));
  const run = field(fields, 'run') === '1';

  let rows;
  if (run) {
    try {
      rows = JSON.parse(field(fields, 'rows') ?? '[]');
    } catch {
      rows = [];
    }
  } else {
    try {
      const accessToken = await freshAccessToken(db, config, connection);
      rows = clientsToRows(await fetchQuickBooksClients({ accessToken, realmId: connection.external_id }));
    } catch (error) {
      if (error instanceof QuickBooksError) {
        return fail(response, 502, `QuickBooks would not give up the client list: ${error.message}`, practitioner);
      }
      throw error;
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return sendPage(response, 200, page({
      title: 'Import from QuickBooks',
      practitioner,
      here: '/clients',
      body: empty(
        'Nothing to import',
        'QuickBooks has no Customers on that company — there are no clients to bring across.',
        html`<a class="btn" href="/integrations/quickbooks">Back to QuickBooks</a>`,
      ),
    }));
  }

  const word = {
    create: ['new', TONES.done],
    update: ['email added', TONES.todo],
    unchanged: ['already there', TONES.done_for],
    invalid: ['no name', TONES.wrong],
  };

  if (run) {
    const summary = importClients(db, practiceId, practitioner.id, rows);
    return sendPage(response, 200, page({
      title: 'Clients imported',
      practitioner,
      here: '/clients',
      body: html`
        <div class="page-head"><div class="titles">
          <h1>Clients imported</h1>
          <p class="sub">Your QuickBooks client book is across. Every row is accounted for.</p>
        </div></div>
        <section class="card">
          <p><strong>${summary.created}</strong> created, <strong>${summary.updated}</strong> given an
          email address, <strong>${summary.unchanged}</strong> already there and left alone${summary.invalid
            ? html`, and <strong>${summary.invalid}</strong> with no name, skipped`
            : ''}.</p>
          <div class="actions">
            <a class="btn primary" href="/clients">See the clients</a>
            <a class="btn" href="/integrations/quickbooks">Back to QuickBooks</a>
          </div>
        </section>`,
    }));
  }

  const preview = previewClientImport(db, practiceId, rows);
  const shown = preview.rows.slice(0, 200);
  return sendPage(response, 200, page({
    title: 'Import from QuickBooks',
    practitioner,
    here: '/clients',
    body: html`
      <div class="page-head"><div class="titles">
        <h1>Import from QuickBooks</h1>
        <p class="sub">Here is exactly what this will do. Nothing has been changed yet.</p>
      </div></div>
      <section class="card">
        <p><strong>${preview.create}</strong> new, <strong>${preview.update}</strong> given an email address,
        <strong>${preview.unchanged}</strong> already there and left alone${preview.invalid
          ? html`, and <strong>${preview.invalid}</strong> with no name, skipped`
          : ''}.</p>
        <div class="scroll"><table class="wide">
          <thead><tr>
            <th align="left">Client</th><th align="left">Email address</th><th align="left">What happens</th>
          </tr></thead>
          <tbody>${shown.map((row) => html`<tr>
            <td class="cell-t">${row.name || '—'}</td>
            <td>${row.email || ''}</td>
            <td>${badge(word[row.action][0], word[row.action][1])}</td>
          </tr>`)}</tbody>
        </table></div>
        ${preview.rows.length > shown.length
          ? html`<p class="note">…and ${preview.rows.length - shown.length} more.</p>`
          : ''}
      </section>
      <form method="post" action="/integrations/quickbooks/import" class="card">
        <input type="hidden" name="run" value="1">
        <textarea name="rows" hidden>${JSON.stringify(rows)}</textarea>
        <button type="submit">Do the import</button>
        <a class="btn ghost" href="/integrations/quickbooks">Cancel</a>
      </form>`,
  }));
}

/** Unlink. Whatever those tokens could reach, this install stops being able to. */
export function quickBooksDisconnect({ db, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  deleteConnection(db, practiceId, PROVIDER);
  return redirect(response, '/integrations/quickbooks');
}
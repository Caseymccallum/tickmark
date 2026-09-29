/**
 * Connecting a practice to Xero, and bringing their client book across.
 *
 * This is the UI and route half of the Xero integration; the OAuth plumbing and the transform live in
 * `tenancy/xero.js`, and the import itself is the *same* ingestion pipeline a CSV goes through — so a
 * Xero import gets the identical dry run, the identical "importing twice creates nothing twice", and
 * the identical report. There is one definition of "same client" in this product and this does not get
 * to invent a second.
 *
 * ## The `state` cookie
 *
 * `/connect` mints a random `state` and parks it in a short-lived cookie; `/callback` requires the
 * `state` Xero hands back to match it. That is the whole CSRF guard: an attacker can aim a forged
 * `/callback?code=…&state=…` at a practice, but without the cookie that this browser set on its way
 * *out* to Xero, it does not match and nothing is stored.
 */
import { randomBytes } from 'node:crypto';

import { parseCookies, secureCookies } from './auth.js';
import { now } from './db.js';
import { formFields, field, readBody } from './http.js';
import {
  booksSignalOn,
  clientByName,
  connectionFor,
  deleteConnection,
  importClients,
  previewClientImport,
  saveConnection,
  setBooksSignal,
  setBooksState,
} from './store.js';
import {
  authorizationUrl,
  booksSignalsForConnections,
  connectionsToRowsWithProfiles,
  exchangeCode,
  fetchConnections,
  fetchPracticeManagerClients,
  practiceManagerClientsToRows,
  refreshTokens,
  xeroFromEnvironment,
  XeroError,
} from './tenancy/xero.js';
import { badge, empty, fail, html, page, redirect, requireSignIn, sendPage, TONES } from './views.js';

const STATE_COOKIE = 'tickmark_xero_state';

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
 * Xero access tokens last thirty minutes and the refresh token rotates every time it is used, so the
 * refreshed pair is stored immediately — keeping the old refresh token is a lockout waiting to happen.
 * A minute of margin avoids handing out a token that expires mid-call.
 */
async function freshAccessToken(db, config, connection) {
  const expiresAt = new Date(connection.expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) return connection.access_token;
  const tokens = await refreshTokens({ config, refreshToken: connection.refresh_token });
  saveConnection(db, {
    provider: 'xero',
    practiceId: connection.practice_id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    scope: tokens.scope,
    at: now(),
  });
  return tokens.accessToken;
}

/**
 * The integration page: whether Xero is connected, and the two things to do about it.
 *
 * Honest about which of three states it is in — not configured (no client id/secret in the
 * environment), configured but not connected, or connected — because "the button does nothing" and
 * "you have not set it up yet" look identical and are not.
 */
export function xeroPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = xeroFromEnvironment();
  const connection = config ? connectionFor(db, practiceId, 'xero') : null;
  const connected = url.searchParams.get('connected') === '1';
  const booksOn = connection ? booksSignalOn(connection) : false;
  const checked = url.searchParams.get('checked');

  const body = !config
    ? html`<section class="card">
        <h2>Xero is not set up on this install</h2>
        <p class="note">Importing from Xero needs an OAuth app registered at
        <strong>developer.xero.com</strong>, and its client id and secret in this server's environment
        (<code>TICKMARK_XERO_CLIENT_ID</code> and <code>TICKMARK_XERO_CLIENT_SECRET</code>).
        <code>.env.example</code> says how. Nothing else here is affected — the
        <a href="/clients/import">CSV import</a> works regardless.</p>
      </section>`
    : connection
      ? html`<section class="card">
          <h2>Connected to Xero</h2>
          <p class="note">Tickmark can read this practice's Xero client list — and nothing more. The
          connection is read-only, so nothing here can change anything in your Xero.</p>
          <div class="actions">
            <form method="post" action="/integrations/xero/import" class="inline">
              <button type="submit" class="btn primary">Import from Xero</button>
            </form>
            <a class="btn" href="/clients/import">Import a CSV instead</a>
            <form method="post" action="/integrations/xero/disconnect" class="inline">
              <button type="submit" class="btn ghost">Disconnect</button>
            </form>
          </div>
        </section>
        <section class="card">
          <h2>Know whose books are behind</h2>
          <p class="note"><strong>Optional — off until you choose it.</strong></p>
          ${booksOn
            ? html`<p class="note"><strong>On.</strong> Tickmark reads a small summary of your clients'
                accounting activity to flag the books that need attention, and keeps only that summary.</p>
                <div class="actions">
                  <form method="post" action="/integrations/xero/books-check" class="inline">
                    <button type="submit" class="btn primary">Check now</button>
                  </form>
                  <form method="post" action="/integrations/xero/books-signal" class="inline">
                    <input type="hidden" name="on" value="0">
                    <button type="submit" class="btn ghost">Turn it off</button>
                  </form>
                </div>`
            : html`<p class="note"><strong>Please read this before turning it on.</strong> Tickmark's promise is
                that it cannot read your clients' <em>documents</em> — those are encrypted in their browser and
                only you can open them. This feature does not change that, and never touches a document.</p>
                <p class="note">What it does: Tickmark reads a small <strong>summary</strong> of your clients'
                accounting activity from Xero — how many bank lines are unreconciled, and when the last one was —
                to tell you whose books are behind. It is <strong>read-only</strong>, and Tickmark keeps only
                that summary, <strong>never the transactions themselves</strong>.</p>
                <p class="note">Leave it off and Tickmark reads nothing beyond your client list. Nothing at all
                is read until you choose.</p>
                <div class="actions">
                  <form method="post" action="/integrations/xero/books-signal" class="inline">
                    <input type="hidden" name="on" value="1">
                    <button type="submit" class="btn">Turn it on</button>
                  </form>
                </div>`}
        </section>`
      : html`<section class="card">
          <h2>Connect to Xero</h2>
          <p class="note">Bring your client book across without retyping it. Tickmark asks Xero for a
          <strong>read-only</strong> view of the organisations you manage — the client list — and writes
          nothing back. You will be sent to Xero to approve it and come straight back.</p>
          <div class="actions">
            <a class="btn primary" href="/integrations/xero/connect">Connect to Xero</a>
            <a class="btn" href="/clients/import">Import a CSV instead</a>
          </div>
        </section>`;

  return sendPage(response, 200, page({
    title: 'Xero',
    practitioner,
    here: '/clients',
    body: html`
      <div class="page-head"><div class="titles">
        <h1>Xero</h1>
        <p class="sub">Import your client book from Xero.</p>
      </div></div>
      ${connected ? html`<p class="note"><strong>Connected.</strong> Xero is linked to this practice.</p>` : ''}
      ${checked ? html`<p class="success"><strong>Checked ${checked} ${checked === '1' ? 'client' : 'clients'}.</strong>
        Only the summary was kept — a count and a date, never a client's bank lines.</p>` : ''}
      ${body}`,
  }));
}

/**
 * Turn the "books behind" signal on or off for this connection.
 *
 * Opt-in and reversible, and turning it on reads nothing by itself — this only records the choice the
 * practice made after reading the warning on the integration page. Off is the default and the safe
 * answer: a practice that never turns it on keeps the plain promise, and Tickmark reads nothing but the
 * client list. See docs/security.md for the posture in full.
 */
export async function xeroBooksSignal({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const connection = connectionFor(db, practiceId, 'xero');
  if (!connection) return fail(response, 409, 'This practice has not connected to Xero yet.', practitioner);
  const fields = formFields(await readBody(request));
  setBooksSignal(db, practiceId, 'xero', field(fields, 'on') === '1');
  return redirect(response, '/integrations/xero');
}

/**
 * Run a books check: read each client's signal and cache the summary — but only when the practice has
 * turned the signal on. Off is refused by name, so nothing is read for a practice that never chose it.
 *
 * This is the only place the signal is fetched. It is opt-in, read-only, and reduces every client to a
 * count and a date before storing — see docs/security.md for why that line is the product.
 */
export async function xeroBooksCheck({ db, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = xeroFromEnvironment();
  if (!config) return fail(response, 500, 'Xero is not set up on this install.', practitioner);
  const connection = connectionFor(db, practiceId, 'xero');
  if (!connection) return fail(response, 409, 'This practice has not connected to Xero yet.', practitioner);
  if (!booksSignalOn(connection)) {
    return fail(response, 409, 'The books signal is off, so nothing is read. Turn it on first.', practitioner);
  }
  try {
    const accessToken = await freshAccessToken(db, config, connection);
    const connections = await fetchConnections({ accessToken });
    const signals = await booksSignalsForConnections({ accessToken, connections });
    let checked = 0;
    for (const { name, signal } of signals) {
      const client = clientByName(db, practiceId, name);
      if (client && signal) {
        setBooksState(db, practiceId, client.id, signal);
        checked += 1;
      }
    }
    return redirect(response, `/integrations/xero?checked=${checked}`);
  } catch (error) {
    if (error instanceof XeroError) {
      return fail(response, 502, `Xero would not give up the books signal: ${error.message}`, practitioner);
    }
    throw error;
  }
}

/**
 * Start the OAuth dance: mint a `state`, park it in a cookie, and send the practice to Xero.
 *
 * The cookie is set on the redirect, so the browser carries it to Xero and back. `/callback` refuses
 * anything that cannot present it.
 */
export function xeroConnect({ response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = xeroFromEnvironment();
  if (!config) return fail(response, 500, 'Xero is not set up on this install.', practitioner);

  const state = randomBytes(24).toString('hex');
  return redirect(response, authorizationUrl({ config, state }), [stateCookie(state)]);
}

/**
 * The other half of the OAuth dance: Xero hands back a code and the `state` we sent out.
 *
 * The `state` match is the whole CSRF guard, and it is checked *before* anything is exchanged or
 * stored. Only then is the one-time code traded for tokens, and the pair stored against the practice
 * that started the dance.
 */
export async function xeroCallback({ db, request, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = xeroFromEnvironment();
  if (!config) return fail(response, 500, 'Xero is not set up on this install.', practitioner);

  const returned = url.searchParams.get('state') ?? '';
  const expected = parseCookies(request.headers.cookie)[STATE_COOKIE] ?? '';
  if (!expected || returned !== expected) {
    return fail(response, 403, 'That Xero sign-in could not be verified. Start again from the Xero page.', practitioner);
  }

  const code = url.searchParams.get('code') ?? '';
  if (!code) return fail(response, 400, 'Xero sent no code to exchange.', practitioner);

  try {
    const tokens = await exchangeCode({ config, code });
    saveConnection(db, {
      provider: 'xero',
      practiceId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      scope: tokens.scope,
      at: now(),
    });
    return redirect(response, '/integrations/xero?connected=1', [clearStateCookie()]);
  } catch (error) {
    if (error instanceof XeroError) {
      return fail(response, 502, `Xero did not accept the sign-in: ${error.message}`, practitioner);
    }
    throw error;
  }
}

/** Unlink. Whatever those tokens could reach, this install stops being able to. */
export function xeroDisconnect({ db, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  deleteConnection(db, practiceId, 'xero');
  return redirect(response, '/integrations/xero');
}

/**
 * Bring the client book across: fetch the Xero client list, then pour it through the same preview and
 * the same import a CSV uses.
 *
 * The confirm re-reads the rows from the form rather than re-fetching, so the run does exactly what
 * the preview showed — the promise that matters just before somebody changes their whole client
 * directory. The import is idempotent anyway, so even a stale preview could not duplicate a client.
 */
export async function xeroImport({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const config = xeroFromEnvironment();
  if (!config) return fail(response, 500, 'Xero is not set up on this install.', practitioner);
  const connection = connectionFor(db, practiceId, 'xero');
  if (!connection) return fail(response, 409, 'This practice has not connected to Xero yet.', practitioner);

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
      // Prefer Practice Manager when the practice has a PM tenant: its Clients carry an email as well as
      // a name, so those rows arrive ready to email. `connections` (the organisations) is the fallback —
      // names only — for a practice on plain Xero. Both pour into one pipeline.
      const connections = await fetchConnections({ accessToken });
      const pmTenant = connections.find((row) => row.tenantType === 'PRACTICEMANAGER');
      rows = pmTenant
        ? practiceManagerClientsToRows(await fetchPracticeManagerClients({ accessToken, tenantId: pmTenant.tenantId }))
        : await connectionsToRowsWithProfiles({ accessToken, connections });
    } catch (error) {
      if (error instanceof XeroError) {
        return fail(response, 502, `Xero would not give up the client list: ${error.message}`, practitioner);
      }
      throw error;
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return sendPage(response, 200, page({
      title: 'Import from Xero',
      practitioner,
      here: '/clients',
      body: empty(
        'Nothing to import',
        'Xero has no organisations on that connection — there are no clients to bring across.',
        html`<a class="btn" href="/integrations/xero">Back to Xero</a>`,
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
          <p class="sub">Your Xero client book is across. Every row is accounted for.</p>
        </div></div>
        <section class="card">
          <p><strong>${summary.created}</strong> created, <strong>${summary.updated}</strong> given an
          address, <strong>${summary.unchanged}</strong> already there and left alone${summary.invalid
            ? html`, and <strong>${summary.invalid}</strong> with no name, skipped`
            : ''}.</p>
          <div class="actions">
            <a class="btn primary" href="/clients">See the clients</a>
            <a class="btn" href="/integrations/xero">Back to Xero</a>
          </div>
        </section>`,
    }));
  }

  const preview = previewClientImport(db, practiceId, rows);
  const shown = preview.rows.slice(0, 200);
  return sendPage(response, 200, page({
    title: 'Import from Xero',
    practitioner,
    here: '/clients',
    body: html`
      <div class="page-head"><div class="titles">
        <h1>Import from Xero</h1>
        <p class="sub">Here is exactly what this will do. Nothing has been changed yet.</p>
      </div></div>
      <section class="card">
        <p><strong>${preview.create}</strong> new, <strong>${preview.update}</strong> given an email address,
        <strong>${preview.unchanged}</strong> already there and left alone${preview.invalid
          ? html`, and <strong>${preview.invalid}</strong> with no name, skipped`
          : ''}.</p>
        <div class="scroll"><table class="wide">
          <thead><tr><th align="left">Client</th><th align="left">What happens</th></tr></thead>
          <tbody>${shown.map((row) => html`<tr>
            <td class="cell-t">${row.name || '—'}</td>
            <td>${badge(word[row.action][0], word[row.action][1])}</td>
          </tr>`)}</tbody>
        </table></div>
        ${preview.rows.length > shown.length
          ? html`<p class="note">…and ${preview.rows.length - shown.length} more.</p>`
          : ''}
      </section>
      <form method="post" action="/integrations/xero/import" class="card">
        <input type="hidden" name="run" value="1">
        <textarea name="rows" hidden>${JSON.stringify(rows)}</textarea>
        <button type="submit">Do the import</button>
        <a class="btn ghost" href="/integrations/xero">Cancel</a>
      </form>`,
  }));
}
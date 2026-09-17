/**
 * The HTTP surface.
 *
 * There is no framework here on purpose: every page in version one is a form, a list or
 * a file upload, which is the case where the platform's own tools are enough and where a
 * framework would add a dependency tree the *operator* has to trust and keep patched.
 *
 * The shape is a small table of routes rather than a chain of `if`s, because the table
 * is the thing a reader can check against the list of pages the product claims to have.
 *
 * Two habits are established here deliberately:
 *
 * 1. **Authorization is a scoping of the query, not a check beside it.** Every query
 *    that reads a practice's data is given the practice's id, so a request belonging to
 *    somebody else is simply not found. A check that sits beside a query is a check that
 *    someone eventually forgets to write.
 * 2. **Errors are pages, not stack traces.** An unexpected failure is logged for the
 *    operator and answered with a sentence, because a stack trace in a browser is
 *    information for an attacker and nothing for a user.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.js';
import { clearSessionCookie, createSession, endSession, practitionerFor, sessionCookie } from './auth.js';
import { RequestError, field, formFields, readBody } from './http.js';
import { html, page, raw, redirect, sendPage } from './views.js';

/**
 * Data for the browser to read, inside a script element.
 *
 * The one sequence that can end a script element early is escaped, which is the whole of the
 * rule for putting JSON in HTML. Everything else is left alone so that the JSON is still valid
 * JSON — and a JSON parser does not care whether `<` arrived as an escape.
 */
const jsonTag = (id, value) =>
  html`<script type="application/json" id="${id}">${raw(JSON.stringify(value).replace(/</g, '\\u003c'))}</script>`;
import { newId, now } from './db.js';
// The server imports the envelope format so that it can tell an encrypted upload from a
// plaintext one. It cannot use the rest of that module: the key needed to open an envelope
// is wrapped under a passphrase this process has never seen.
import { ENVELOPE_VERSION, KDF_MAX_ITERATIONS, readEnvelope } from '../web/tickmark-crypto.js';
import {
  addPracticeKey,
  closeRequest,
  closedCount,
  createPractitioner,
  createRequest,
  findOrCreateClient,
  history,
  issueToken,
  itemInRequest,
  itemsOf,
  practiceKeys,
  practitionerByEmail,
  recordEvent,
  recordUpload,
  reopenRequest,
  replaceWrappedKey,
  requestFor,
  requestsFor,
  revokeToken,
  tokenLookup,
  tokensFor,
  uploadsOf,
} from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const MIN_PASSWORD = 12;
const MAX_ITEMS = 50;
const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024;

/** The browser-side scripts, served by name. An allowlist, so no request can name a path. */
const ASSETS = new Map([
  ['tickmark-crypto.js', 'application/javascript; charset=utf-8'],
  ['upload.js', 'application/javascript; charset=utf-8'],
  ['setup.js', 'application/javascript; charset=utf-8'],
  ['download.js', 'application/javascript; charset=utf-8'],
  ['keys.js', 'application/javascript; charset=utf-8'],
]);

export const ROUTES = [
  ['GET', '/', home],
  ['GET', '/signup', signUpForm],
  ['POST', '/signup', signUp],
  ['GET', '/signin', signInForm],
  ['POST', '/signin', signIn],
  ['POST', '/signout', signOut],
  ['GET', '/setup', setupForm],
  ['POST', '/setup', saveKeys],
  ['GET', '/keys', keysPage],
  ['POST', /^\/keys\/([^/]+)\/passphrase$/, changePassphrase],
  ['GET', /^\/assets\/([A-Za-z0-9._-]+)$/, asset],
  ['GET', '/requests', listRequests],
  ['GET', '/requests/new', newRequestForm],
  ['POST', '/requests', createRequestPage],
  ['GET', /^\/requests\/([^/]+)$/, viewRequest],
  ['GET', /^\/requests\/([^/]+)\/files\/([^/]+)$/, serveEnvelope],
  ['POST', /^\/requests\/([^/]+)\/link$/, issueLink],
  ['POST', /^\/requests\/([^/]+)\/remind$/, draftReminder],
  ['POST', /^\/requests\/([^/]+)\/close$/, closeRequestPage],
  ['POST', /^\/requests\/([^/]+)\/reopen$/, reopenRequestPage],
  ['POST', /^\/requests\/([^/]+)\/revoke$/, revokeLink],
  // Public: no session, gated by the token in the path.
  ['GET', /^\/r\/([^/]+)$/, clientPage],
  ['POST', /^\/r\/([^/]+)\/items\/([^/]+)$/, receiveUpload],
];

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/** Everything a handler is given, so that every handler has one signature. */
async function contextFor(db, request, response, url, params) {
  return { db, request, response, url, params, practitioner: practitionerFor(db, request) };
}

function fail(response, status, message, practitioner = null, extra = null) {
  sendPage(
    response,
    status,
    page({
      title: status === 404 ? 'Not found' : 'That did not work',
      practitioner,
      body: html`<h1>${status === 404 ? 'Not found' : 'That did not work'}</h1>
        <p>${message}</p>
        ${extra}
        <p><a href="/">Back to the start</a></p>`,
    }),
  );
}

/** Send a signed-out visitor to the sign-in page. Returns true if the handler may continue. */
function requireSignIn({ practitioner, response }) {
  if (practitioner) return true;
  redirect(response, '/signin');
  return false;
}

/**
 * The browser-side scripts.
 *
 * `params[0]` is constrained twice over — once by the route's pattern and once by the
 * allowlist — so a request cannot name a path that does not exist as a key in this map. There
 * is no path joining of anything the caller sent, which is why there is no traversal to test
 * for.
 */
async function asset({ response, params, webDir }) {
  const type = ASSETS.get(params[0]);
  if (!type) return fail(response, 404, 'There is no such file here.');
  let body;
  try {
    body = await readFile(join(webDir, params[0]));
  } catch {
    return fail(response, 404, 'There is no such file here.');
  }
  response.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    // Not cached: a stale copy of the encryption script is a class of bug this product cannot
    // afford, and the file is a few kilobytes.
    'cache-control': 'no-store',
  });
  return response.end(body);
}

export function createApp(db, {
  blobDir = 'data/blobs',
  maxUploadBytes = DEFAULT_MAX_UPLOAD,
  webDir = join(HERE, '..', 'web'),
} = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    // A health check that touches the database, because a process that is up and cannot
    // read its own schema is not healthy.
    if (url.pathname === '/healthz') {
      try {
        const practices = db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n;
        return sendJson(response, 200, { ok: true, practices });
      } catch (error) {
        return sendJson(response, 503, { ok: false, error: error.message });
      }
    }

    try {
      for (const [method, pattern, handler] of ROUTES) {
        if (request.method !== method) continue;
        let params = null;
        if (typeof pattern === 'string') {
          if (url.pathname === pattern) params = [];
        } else {
          params = url.pathname.match(pattern);
        }
        if (!params) continue;

        const context = await contextFor(db, request, response, url, params.slice(1));
        await handler({ ...context, blobDir, maxUploadBytes, webDir });
        return;
      }
      return fail(response, 404, 'There is no page at that address.');
    } catch (error) {
      if (error instanceof RequestError) {
        return fail(response, error.status, error.message, practitionerFor(db, request));
      }
      // The operator gets the detail; the browser gets a sentence.
      console.error(`tickmark: ${request.method} ${url.pathname} failed:`, error);
      return fail(response, 500, 'Something went wrong on the server. The operator can find the detail in its log.');
    }
  });
}

// ---------------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------------

function home({ response, practitioner }) {
  if (practitioner) return redirect(response, '/requests');
  return sendPage(
    response,
    200,
    page({
      title: 'Tickmark',
      body: html`
        <h1>The list of documents a client owes you, and a tick as each one arrives.</h1>
        <p>Tickmark is a self-hosted tool for a practice that needs documents from
        clients. Build the list, send a link, and watch it get ticked off. The client
        needs no account and installs nothing.</p>
        <p><a href="/signup">Create a practice</a> &middot; <a href="/signin">Sign in</a></p>
        <p class="note">Early days. Anything not described in <code>docs/mvp.md</code>
        does not exist yet, including the links and the uploads.</p>
      `,
    }),
  );
}

/** The one place a credential is validated, so sign-up and sign-in cannot drift apart. */
function validateCredentials(email, password) {
  if (!email) return 'An email address is required.';
  if (email.length > 254) return 'That email address is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like an email address.';
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `A password of at least ${MIN_PASSWORD} characters is required.`;
  }
  if (password.length > 1024) return 'That password is too long.';
  return null;
}

function credentialsForm({ action, title, submit, error = null, email = '', hint = false }) {
  return html`
    <h1>${title}</h1>
    ${error ? html`<p class="error">${error}</p>` : ''}
    <form method="post" action="${action}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required value="${email}" autocomplete="username">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required minlength="${MIN_PASSWORD}"
             autocomplete="${action === '/signup' ? 'new-password' : 'current-password'}">
      ${hint
        ? html`<p class="note">At least ${MIN_PASSWORD} characters. It is the only thing
            between a stranger and other people's financial records, so it is stored with
            a deliberately expensive hash rather than a fast one.</p>`
        : ''}
      <button type="submit">${submit}</button>
    </form>`;
}

function signUpForm({ response }) {
  sendPage(response, 200, page({
    title: 'Create a practice',
    body: credentialsForm({ action: '/signup', title: 'Create a practice', submit: 'Create it', hint: true }),
  }));
}

/**
 * A hash to check against when the email is unknown, so that "no such account" and
 * "wrong password" take about the same time. Without it, the response time answers the
 * question the error message deliberately refuses to answer.
 */
let dummyHash = null;
async function spendTheSameTimeAsARealCheck(password) {
  dummyHash ??= await hashPassword('this password belongs to nobody and is never accepted');
  await verifyPassword(password, dummyHash);
}

async function signUp({ db, request, response }) {
  const fields = formFields(await readBody(request));
  const email = field(fields, 'email')?.toLowerCase() ?? null;
  const password = typeof fields.password === 'string' ? fields.password : '';

  const problem = validateCredentials(email, password);
  if (problem) {
    return sendPage(response, 400, page({
      title: 'Create a practice',
      body: credentialsForm({ action: '/signup', title: 'Create a practice', submit: 'Create it', error: problem, email: email ?? '', hint: true }),
    }));
  }

  if (practitionerByEmail(db, email)) {
    return sendPage(response, 400, page({
      title: 'Create a practice',
      body: credentialsForm({
        action: '/signup',
        title: 'Create a practice',
        submit: 'Create it',
        error: 'A practice already exists for that email address. Sign in instead.',
        email,
        hint: true,
      }),
    }));
  }

  const passwordHash = await hashPassword(password);
  const practitionerId = createPractitioner(db, { email, passwordHash });
  const { token } = createSession(db, practitionerId);
  return redirect(response, '/requests', [sessionCookie(token)]);
}

function signInForm({ response }) {
  sendPage(response, 200, page({
    title: 'Sign in',
    body: credentialsForm({ action: '/signin', title: 'Sign in', submit: 'Sign in' }),
  }));
}

async function signIn({ db, request, response }) {
  const fields = formFields(await readBody(request));
  const email = field(fields, 'email')?.toLowerCase() ?? null;
  const password = typeof fields.password === 'string' ? fields.password : '';

  const record = email ? practitionerByEmail(db, email) : null;
  let accepted = false;
  if (record) {
    accepted = await verifyPassword(password, record.password_hash);
  } else {
    await spendTheSameTimeAsARealCheck(password);
  }

  // One message for both failures on purpose: the browser is not told which half was
  // wrong, because that is a fact about who holds an account here.
  if (!accepted) {
    return sendPage(response, 401, page({
      title: 'Sign in',
      body: credentialsForm({
        action: '/signin',
        title: 'Sign in',
        submit: 'Sign in',
        error: 'That email address and password do not match an account.',
        email: email ?? '',
      }),
    }));
  }

  const { token } = createSession(db, record.id);
  return redirect(response, '/requests', [sessionCookie(token)]);
}

function signOut({ db, request, response }) {
  const match = /tickmark_session=([^;]+)/.exec(request.headers.cookie ?? '');
  if (match) endSession(db, decodeURIComponent(match[1]));
  return redirect(response, '/', [clearSessionCookie()]);
}

// ---------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------

/** One item per line, trimmed, blanks dropped, duplicates collapsed, capped. */
export function parseItems(text) {
  const seen = new Set();
  const items = [];
  for (const line of String(text).split(/\r?\n/)) {
    const label = line.trim();
    if (label.length === 0) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(label.slice(0, 200));
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * Where this server is, as a client would reach it.
 *
 * The link a practice pastes into an email has to be absolute, and the only place that knows the
 * address is the request that produced the page. `x-forwarded-proto` is honoured because the
 * documented deployment puts a reverse proxy in front of this, which terminates TLS and would
 * otherwise yield `http://` links in emails.
 */
const originOf = (request) =>
  `${String(request.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim()}://${request.headers.host ?? 'localhost'}`;

/**
 * The message a practice sends when something has not arrived.
 *
 * A pure function of the facts, exported so the wording has one home and can be tested directly.
 * It is a *draft*: the page puts it in a textarea the practice edits before sending, because the
 * tool does not know this client and the practice does.
 *
 * The escape hatch near the end is not politeness. A reminder that lists a document the client
 * cannot supply — because it does not apply to them, or they have already explained why — is a
 * reminder that gets ignored, and the cheapest way to prevent that is to invite the reply.
 */
export function reminderDraft({ clientName, title, dueAt, outstanding, link }) {
  const documents = outstanding.length === 1 ? 'one document' : `${outstanding.length} documents`;
  const lines = [
    `Hello ${clientName},`,
    '',
    `We are still waiting on ${documents} for ${title}:`,
    '',
    ...outstanding.map((label) => `  - ${label}`),
    '',
    'You can send them at this link — no account or password needed:',
    link,
  ];
  if (dueAt) lines.push('', `We had these marked as needed by ${dueAt}.`);
  lines.push(
    '',
    'If something on the list does not apply to you, reply and tell us — it is easier than sending the wrong thing.',
    '',
    'Thanks,',
  );
  return { subject: `Still needed for ${title}`, body: lines.join('\n') };
}

function listRequests({ db, response, practitioner, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const showingClosed = url.searchParams.get('closed') === '1';
  const rows = requestsFor(db, practitioner.id, { includeClosed: showingClosed });
  const closed = closedCount(db, practitioner.id);

  const table = rows.length === 0
    ? html`<p>${showingClosed ? 'Nothing has been closed yet.' : html`No requests yet. <a href="/requests/new">Start one</a>.`}</p>`
    : html`<table>
        <thead><tr><th align="left">Client</th><th align="left">Request</th><th align="left">Items</th><th align="left">Outstanding</th></tr></thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td>${row.client_name}</td>
            <td><a href="/requests/${row.id}">${row.title}</a></td>
            <td>${row.item_count}</td>
            <td>${row.outstanding_count === 0 ? html`<strong>none — complete</strong>` : row.outstanding_count}</td>
          </tr>`)}
        </tbody>
      </table>`;

  return sendPage(response, 200, page({
    title: showingClosed ? 'Closed requests' : 'Requests',
    practitioner,
    body: html`
      <h1>${showingClosed ? 'Closed requests' : 'Requests'}</h1>
      <p>
        ${showingClosed
          ? html`<a href="/requests">Open requests</a>`
          : html`Open &middot; <a href="/requests?closed=1">closed (${closed})</a>`}
      </p>
      ${table}
      <p><a href="/requests/new">New request</a></p>`,
  }));
}

function requestForm({ error = null, values = {} } = {}) {
  return html`
    <h1>New request</h1>
    ${error ? html`<p class="error">${error}</p>` : ''}
    <form method="post" action="/requests">
      <label for="client">Client</label>
      <input id="client" name="client" required value="${values.client ?? ''}">
      <label for="client_email">Client email <span class="note">(optional, for the reminder text)</span></label>
      <input id="client_email" name="client_email" type="email" value="${values.client_email ?? ''}">
      <label for="title">What is this for?</label>
      <input id="title" name="title" required value="${values.title ?? ''}" placeholder="2025 return">
      <label for="due">Due <span class="note">(optional)</span></label>
      <input id="due" name="due" type="date" value="${values.due ?? ''}">
      <label for="items">What do you need? <span class="note">one document per line</span></label>
      <textarea id="items" name="items" rows="8" required placeholder="Bank statements for all accounts, 2025&#10;Signed engagement letter&#10;Photo ID">${values.items ?? ''}</textarea>
      <button type="submit">Create the request</button>
    </form>`;
}

function newRequestForm({ response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  return sendPage(response, 200, page({ title: 'New request', practitioner, body: requestForm() }));
}

async function createRequestPage({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const clientName = field(fields, 'client');
  const clientEmail = field(fields, 'client_email');
  const title = field(fields, 'title');
  const due = field(fields, 'due');
  const rawItems = typeof fields.items === 'string' ? fields.items : '';
  const items = parseItems(rawItems);
  const values = { client: clientName ?? '', client_email: clientEmail ?? '', title: title ?? '', due: due ?? '', items: rawItems };

  const problem = !clientName
    ? 'A client is required.'
    : !title
      ? 'A title is required.'
      : items.length === 0
        ? 'At least one document is required, one per line.'
        : null;

  if (problem) {
    return sendPage(response, 400, page({
      title: 'New request',
      practitioner,
      body: requestForm({ error: problem, values }),
    }));
  }

  const clientId = findOrCreateClient(db, { practitionerId: practitioner.id, name: clientName, email: clientEmail });
  const requestId = createRequest(db, {
    practitionerId: practitioner.id,
    clientId,
    title,
    dueAt: due,
    items,
  });
  return redirect(response, `/requests/${requestId}`);
}

function viewRequest({ db, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practitioner.id, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const items = itemsOf(db, found.id);
  const links = tokensFor(db, found.id);
  const filesFor = new Map();
  for (const upload of uploadsOf(db, found.id)) {
    const list = filesFor.get(upload.request_item_id) ?? [];
    list.push(upload);
    filesFor.set(upload.request_item_id, list);
  }
  const received = items.filter((item) => (filesFor.get(item.id) ?? []).length > 0).length;
  const outstanding = items.filter((item) => (filesFor.get(item.id) ?? []).length === 0);
  const events = history(db, found.id);

  const rows = items.map((item) => {
    const files = filesFor.get(item.id) ?? [];
    return html`<tr>
      <td>${item.label}</td>
      <td>${files.length > 0 ? html`<strong>received</strong>` : 'outstanding'}</td>
      <td>${files.length === 0
        ? html`<span class="note">—</span>`
        : files.map((file) => html`<div class="file">
            <span class="name">${file.filename}</span>
            <span class="note">${file.uploaded_at}</span>
            <button type="button" class="save" disabled
                    data-url="/requests/${found.id}/files/${file.id}"
                    data-name="${file.filename}">Save</button>
            <span class="status note"></span>
          </div>`)}</td>
    </tr>`;
  });

  // The wrapped keys travel in the page because the decryption happens here. They leak nothing — the
  // server already stores them, and they are useless without the passphrase — and they have to be
  // here, or the plaintext would have to be produced by the server, which is the one thing that must
  // not happen. All of them, because a file sent before the last rotation is encrypted to an older
  // key.
  const keys = practiceKeys(db, practitioner.id);

  return sendPage(response, 200, page({
    title: found.title,
    practitioner,
    body: html`
      <h1>${found.title} <span class="note">for ${found.client_name}</span></h1>
      ${found.closed_at ? html`<p class="note"><strong>Closed.</strong></p>` : ''}
      <p>${received} of ${items.length} received${found.due_at ? html`, due ${found.due_at}` : ''}.</p>
      ${keys.length > 0 && received > 0
        ? html`<div class="unlock">
            <label for="passphrase">Your passphrase, to open what has arrived</label>
            <input id="passphrase" type="password" autocomplete="current-password">
            <button type="button" id="unlock">Unlock</button>
            <p id="unlock-status" class="note">It is used in this browser and sent nowhere. Unlocking
            keeps the keys in this tab so that saving several files does not mean typing it again.</p>
          </div>`
        : ''}
      <table>
        <thead><tr><th align="left">Document</th><th align="left">State</th><th align="left">Files</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h2>What has happened</h2>
      <ul>
        ${events.map((event) => html`<li><code>${event.kind}</code> <span class="note">${event.at}${event.detail ? ` — ${event.detail}` : ''}</span></li>`)}
      </ul>
      <h2>The link for this client</h2>
      ${links.length === 0
        ? html`<p class="note">No link has been created yet.</p>`
        : html`<ul>
            ${links.map((link) => html`<li>
              created ${link.created_at}, expires ${link.expires_at}
              ${link.revoked_at
                ? html`<strong> — revoked</strong>`
                : html` <form method="post" action="/requests/${found.id}/revoke" style="display:inline">
                    <input type="hidden" name="token_id" value="${link.id}">
                    <button type="submit">Revoke</button>
                  </form>`}
            </li>`)}
          </ul>`}
      <form method="post" action="/requests/${found.id}/link">
        <label for="days">A new link, valid for</label>
        <select id="days" name="days">
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
        </select>
        <button type="submit">Create a link</button>
      </form>
      <h2>Chase this client</h2>
      ${outstanding.length > 0
        ? html`<p>${outstanding.length} still outstanding:
              ${outstanding.map((item) => item.label).join(', ')}.</p>
            <form method="post" action="/requests/${found.id}/remind">
              <label for="remind-days">The reminder's link, valid for</label>
              <select id="remind-days" name="days">
                <option value="7">7 days</option>
                <option value="30" selected>30 days</option>
                <option value="90">90 days</option>
              </select>
              <button type="submit">Draft a reminder</button>
            </form>`
        : html`<p><strong>Everything asked for has arrived.</strong></p>`}
      <h2>The file itself</h2>
      ${found.closed_at
        ? html`<p>Closed ${found.closed_at}. It stays on the list of closed requests, and
              nothing has been deleted.</p>
            <form method="post" action="/requests/${found.id}/reopen">
              <button type="submit">Reopen it</button>
            </form>`
        : html`<p class="note">Closing is a status, not a deletion: the record, the files and the
              client's link all stay exactly as they are.</p>
            <form method="post" action="/requests/${found.id}/close">
              <button type="submit">Close this request</button>
            </form>`}
      ${keys.length > 0 ? jsonTag('key-records', { keys: keys.map((key) => ({ id: key.id, wrapped: key.wrappedPrivateKey })) }) : ''}
      ${received > 0 ? raw('<script type="module" src="/assets/download.js"></script>') : ''}`,
  }));
}

/**
 * Create a link, and show it once.
 *
 * It cannot be shown again, and that is not an oversight: only a digest of the token is
 * stored, so the plain token exists in this process for the length of one response. A
 * practice that loses it creates another, which is the correct answer and also the honest
 * one.
 */
/**
 * Serve one stored envelope to the practice that owns it.
 *
 * What goes over the wire is ciphertext, so this is not a document being handed out — it is a
 * blob the practice's browser is about to decrypt. That distinction is why this route can be
 * simple: there is nothing here to redact, and no content type to guess.
 *
 * Authorization is the scoping of the query, as everywhere else: an upload belonging to another
 * practice is not found, and a request belonging to another practice cannot be reached to begin
 * with.
 */
async function serveEnvelope({ db, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practitioner.id, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const row = db
    .prepare(
      `SELECT u.* FROM upload u JOIN request_item i ON i.id = u.request_item_id
        WHERE u.id = ? AND i.request_id = ?`,
    )
    .get(params[1], found.id);
  if (!row) return fail(response, 404, 'There is no file with that id in this request.', practitioner);

  let bytes;
  try {
    bytes = await readFile(row.storage_path);
  } catch {
    // The row exists and the file does not: the disk has been changed underneath the record, which
    // is worth saying plainly rather than reporting as a missing upload.
    return fail(response, 500, 'The record of that file is here but the file itself is not. Check the blob directory.', practitioner);
  }

  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': bytes.length,
    // The original filename, so the browser can offer it once the bytes are decrypted. It travels
    // in a header rather than in the path because it is a label the client chose.
    'x-file-name': encodeURIComponent(row.filename),
    'cache-control': 'no-store',
  });
  return response.end(bytes);
}

async function issueLink({ db, request, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;

  // Ownership first, key second. A request belonging to somebody else must be *not found*
  // whatever state this practice is in — a refusal that depends on my own setup would leak
  // whether the request exists.
  const found = requestFor(db, practitioner.id, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  // No key, no link. This is where the encryption requirement bites, and it bites before a
  // client is involved rather than after: a link that cannot receive an encrypted file is a
  // promise the product cannot keep.
  if (!practitioner.hasKey) return redirect(response, '/setup');

  const fields = formFields(await readBody(request));
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);

  const token = newToken();
  issueToken(db, {
    requestId: found.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  });

  return sendPage(response, 200, page({
    title: found.title,
    practitioner,
    banner: html`<p class="warning"><strong>This is the link — copy it now. It will not be shown
      again.</strong> Only a digest of it is stored, so nobody can recover it later, including
      whoever runs this server.<br>
      <code>${originOf(request)}/r/${token}</code></p>`,
    body: html`<h1>${found.title}</h1>
      <p>Send that link to ${found.client_name}. It stops working after ${days} days, and
      you can revoke it from the <a href="/requests/${found.id}">request page</a>.</p>`,
  }));
}

async function revokeLink({ db, request, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practitioner.id, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const tokenId = field(fields, 'token_id');
  const revoked = tokenId ? revokeToken(db, practitioner.id, tokenId) : false;
  if (!revoked) {
    return fail(response, 400, 'That link is not one of yours, or it was already revoked.', practitioner);
  }
  return redirect(response, `/requests/${found.id}`);
}

const outstandingOf = (db, requestId) => {
  const arrived = new Set(uploadsOf(db, requestId).map((upload) => upload.request_item_id));
  return itemsOf(db, requestId).filter((item) => !arrived.has(item.id));
};

/**
 * A block of text the practice is meant to copy.
 *
 * `onclick` selecting the contents is the whole interaction: a practice with a mouse clicks once
 * and types Ctrl-C, which is one more step than a copy button and one fewer than a broken
 * clipboard API in a page served over plain HTTP.
 */
const copyableField = (name, text, rows) => html`
  <label for="${name}">${name}</label>
  <textarea id="${name}" rows="${rows}" readonly onclick="this.focus(); this.select();">${text}</textarea>`;

/**
 * Draft the reminder, and make the link it needs.
 *
 * A reminder without a link is much weaker — the client has to find the original email — and the
 * link cannot be recovered from the server, by design: only its digest is stored. So asking for a
 * reminder makes a fresh one, and says so. That is the visible cost of that design decision, and
 * it belongs on the screen rather than in a footnote.
 */
async function draftReminder({ db, request, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practitioner.id, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (!practitioner.hasKey) return redirect(response, '/setup');

  const outstanding = outstandingOf(db, found.id);
  if (outstanding.length === 0) return redirect(response, `/requests/${found.id}`);

  const fields = formFields(await readBody(request));
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);

  const token = newToken();
  issueToken(db, {
    requestId: found.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  });
  recordEvent(db, {
    requestId: found.id,
    kind: 'reminder.drafted',
    detail: `${outstanding.length} still outstanding`,
  });

  const draft = reminderDraft({
    clientName: found.client_name,
    title: found.title,
    dueAt: found.due_at,
    outstanding: outstanding.map((item) => item.label),
    link: `${originOf(request)}/r/${token}`,
  });

  return sendPage(response, 200, page({
    title: `A reminder for ${found.client_name}`,
    practitioner,
    banner: html`<p class="warning">Tickmark does not send this. Copy it into whatever you send
      mail with, to <strong>${found.client_email ?? 'the client'}</strong>.</p>`,
    body: html`
      <h1>A reminder for ${found.client_name}</h1>
      <p>${outstanding.length} of ${itemsOf(db, found.id).length} still outstanding. The link in the
      message is new, it works for ${days} days, and <strong>it is not recoverable</strong> — if you
      lose it, draft the reminder again.</p>
      ${copyableField('subject', draft.subject, 2)}
      ${copyableField('message', draft.body, 16)}
      <p><a href="/requests/${found.id}">Back to the request</a></p>`,
  }));
}

async function closeRequestPage({ db, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const closed = closeRequest(db, practitioner.id, params[0]);
  if (!closed) return fail(response, 404, 'There is no open request at that address.', practitioner);
  return redirect(response, `/requests/${params[0]}`);
}

async function reopenRequestPage({ db, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const reopened = reopenRequest(db, practitioner.id, params[0]);
  if (!reopened) return fail(response, 404, 'There is no closed request at that address.', practitioner);
  return redirect(response, `/requests/${params[0]}`);
}

/**
 * The client's page. No account, no session — the token in the path is the whole of the
 * authorization, which is why it is 256 random bits and why only its digest is stored.
 */
function clientPage({ db, response, params }) {
  const found = tokenLookup(db, params[0]);

  if (found.state === 'expired') {
    return sendPage(response, 410, page({
      title: 'This link has expired',
      body: html`<h1>This link has expired</h1>
        <p>Ask the practice to send a new one — they can make one in a moment.</p>`,
    }));
  }
  if (found.state === 'revoked') {
    return sendPage(response, 410, page({
      title: 'This link has been cancelled',
      body: html`<h1>This link has been cancelled</h1>
        <p>Ask whoever sent it to you for a new one.</p>`,
    }));
  }
  if (found.state === 'unknown') {
    return sendPage(response, 404, page({
      title: 'No such link',
      body: html`<h1>No such link</h1>
        <p>Check the address you were sent: it may have wrapped across two lines in an
        email, or lost a character on the way.</p>`,
    }));
  }

  const open = found.request;
  const items = itemsOf(db, open.id);
  const arrived = new Set(uploadsOf(db, open.id).map((upload) => upload.request_item_id));

  if (!open.practice_public_key) {
    return sendPage(response, 503, page({
      title: 'This link is not ready',
      body: html`<h1>This link is not ready</h1>
        <p>The practice has not finished setting up its encryption key, so there is nothing to
        encrypt your documents to yet. Ask them to send the link again once it is done.</p>`,
    }));
  }

  const rows = items.map((item) => html`<tr>
    <td>${item.label}${item.note ? html`<br><span class="note">${item.note}</span>` : ''}</td>
    <td>${arrived.has(item.id) ? html`<strong>received</strong>` : 'still needed'}</td>
    <td>
      <form class="upload" method="post" action="/r/${params[0]}/items/${item.id}">
        <input type="file" name="file" required>
        <button type="submit">Send</button>
        <div class="status note"></div>
      </form>
    </td>
  </tr>`);

  return sendPage(response, 200, page({
    title: open.title,
    banner: html`<p class="note"><strong>What you send is encrypted in this browser before it
      leaves it.</strong> Only the practice can open it. What the server can still see is the
      name of the file, which document it answers, and when it arrived — so name files the way
      you would name an envelope, not the way you would name a letter.</p>`,
    body: html`
      <h1>${open.title}</h1>
      <p>${open.client_name}${open.due_at ? html` · needed by ${open.due_at}` : ''}</p>
      <table>
        <thead><tr><th align="left">Document</th><th align="left">State</th><th align="left">Send it</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">Nothing here needs an account. Come back to this page with the same
      link to send the rest — the list shows what has already arrived.</p>
      ${jsonTag('practice-key', JSON.parse(open.practice_public_key))}
      ${raw('<script type="module" src="/assets/upload.js"></script>')}`,
  }));
}

/**
 * The client's upload, sent by the page's own script as a raw body.
 *
 * The filename arrives in a header and is recorded as a *label* only. It is never used to
 * build a path, so a filename like `../../etc/passwd` cannot become one — the bytes are
 * stored under an id this process generated. That property is what makes the storage layer
 * safe to write without a sanitiser, and it needs no test to stay true as long as nobody
 * starts joining the filename into a path.
 */
async function receiveUpload({ db, request, response, params, blobDir, maxUploadBytes }) {
  const [token, itemId] = params;
  const found = tokenLookup(db, token);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const item = itemInRequest(db, found.request.id, itemId);
  if (!item) return fail(response, 404, 'That document is not part of this request.');

  const type = String(request.headers['content-type'] ?? '');
  if (!type.startsWith('application/octet-stream')) {
    return fail(response, 415, 'This page sends files as raw bytes, which needs JavaScript to be enabled.');
  }

  const body = await readBody(request, maxUploadBytes);
  if (body.length === 0) return fail(response, 400, 'That file was empty.');

  // The server refuses a file it could read. Storing one and calling it encrypted would make
  // the product's central claim false in a way nobody would notice until it mattered.
  const envelope = readEnvelope(body);
  if (!envelope.ok) {
    return fail(
      response,
      400,
      `Only encrypted uploads are accepted, and that one is not one (${envelope.reason}). Nothing was stored.`,
    );
  }

  const uploadId = newId();
  const directory = join(blobDir, found.request.id);
  await mkdir(directory, { recursive: true });
  const storagePath = join(directory, `${uploadId}.bin`);
  await writeFile(storagePath, body);

  const header = (name, fallback, limit) =>
    request.headers[name] ? decodeURIComponent(String(request.headers[name])).slice(0, limit) : fallback;

  recordUpload(db, {
    id: uploadId,
    requestId: found.request.id,
    requestItemId: item.id,
    filename: header('x-file-name', 'upload.bin', 255),
    mime: header('x-file-type', 'application/octet-stream', 120),
    sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    storagePath,
    clientNote: header('x-note', null, 500),
    at: now(),
  });

  return sendJson(response, 201, { ok: true, received: item.label, bytes: body.length, envelope: ENVELOPE_VERSION });
}

// ---------------------------------------------------------------------------------
// The practice's key
// ---------------------------------------------------------------------------------

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const MIN_ITERATIONS = 100000;

/**
 * Everything about a submitted key that the server can check without being able to use it.
 *
 * The server cannot verify that a key is *good* — it cannot open it, and that is the point.
 * What it can do is refuse something that is not a key at all, and refuse a record that would
 * protect the practice's own private half so weakly that the promise is nominal. A hostile
 * client could still store nonsense for its own account, which harms nobody but itself.
 */
function publicKeyProblem(publicKeyJson) {
  let publicKey;
  try {
    publicKey = JSON.parse(publicKeyJson);
  } catch {
    return 'That public key could not be read.';
  }
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256') {
    return 'That is not a P-256 public key.';
  }
  if (!BASE64URL_32.test(String(publicKey.x ?? '')) || !BASE64URL_32.test(String(publicKey.y ?? ''))) {
    return 'That public key is not the shape a P-256 point has.';
  }
  return null;
}

function wrappedKeyProblem(wrapped) {
  const parts = String(wrapped).split('$');
  if (parts.length !== 6 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha-256') {
    return 'That key record is not in the form Tickmark writes.';
  }
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > KDF_MAX_ITERATIONS) {
    return `That key record asks for an amount of work outside what this version accepts (${MIN_ITERATIONS} to ${KDF_MAX_ITERATIONS} rounds).`;
  }
  return null;
}

function keyProblem(publicKeyJson, wrapped) {
  return publicKeyProblem(publicKeyJson) ?? wrappedKeyProblem(wrapped);
}

function setupForm({ db, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const existing = practiceKeys(db, practitioner.id);
  const first = existing.length === 0;
  return sendPage(response, 200, page({
    title: first ? 'Set up encryption' : 'Add a new key',
    practitioner,
    body: html`
      <h1>${first ? 'One passphrase, and then clients can send you files' : 'A new key, for files that arrive from now on'}</h1>
      <p>Tickmark makes a key pair in this browser. The public half is kept here; the private half
      never leaves your browser except wrapped under a passphrase, which is never sent either. That
      is what makes the promise real rather than polite: whoever runs this server — including you —
      can hold a client's documents without being able to read them.</p>
      ${first
        ? ''
        : html`<p class="warning"><strong>A new key does not re-encrypt anything.</strong> Files your
            clients have already sent stay encrypted to the key they arrived under, and you go on
            being able to open them. A new key changes what happens to the <em>next</em> file — so it
            is the right response to a key being exposed, and it is not an undo for a copy somebody
            has already taken.</p>`}
      <form id="setup" method="post" action="/setup">
        <label for="passphrase">Passphrase</label>
        <input id="passphrase" name="passphrase" type="password" required autocomplete="new-password">
        <label for="again">The same passphrase again</label>
        <input id="again" name="again" type="password" required autocomplete="new-password">
        <button type="submit">Make the key</button>
        <div class="status note"></div>
      </form>
      <p class="warning"><strong>Nothing can recover this passphrase and nothing can reset it.</strong>
      If you lose it, the files clients send you become unreadable — by you, by anyone. Write it
      down somewhere that is not this server.</p>
      ${raw('<script type="module" src="/assets/setup.js"></script>')}`,
  }));
}

async function saveKeys({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;

  const fields = formFields(await readBody(request));
  const publicKeyJson = field(fields, 'public_key');
  const wrapped = field(fields, 'wrapped_private_key');
  const problem = keyProblem(publicKeyJson, wrapped);
  if (problem) return fail(response, 400, problem, practitioner);

  addPracticeKey(db, practitioner.id, {
    publicKey: JSON.parse(publicKeyJson),
    wrappedPrivateKey: wrapped,
  });
  return redirect(response, '/keys');
}

/**
 * The practice's keys: what exists, which one is current, and how to change a passphrase.
 *
 * Rotation is presented as what it is, and there is no button to delete an old key. Deleting one
 * would orphan every file encrypted to it, and a button that destroys a practice's access to its own
 * clients' documents should not exist until there is a way to re-encrypt those files first.
 */
function keysPage({ db, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const keys = practiceKeys(db, practitioner.id);

  const rows = keys.map((key, index) => html`<tr>
    <td>${key.createdAt.slice(0, 19).replace('T', ' ')}</td>
    <td>${index === 0
      ? html`<strong>current</strong> — new files are encrypted to this one`
      : 'older — opens the files sent while it was current'}</td>
    <td>
      <form class="passphrase" data-key-id="${key.id}" method="post" action="/keys/${key.id}/passphrase">
        <input type="password" name="old" placeholder="current passphrase" required autocomplete="current-password">
        <input type="password" name="fresh" placeholder="new passphrase" required autocomplete="new-password">
        <input type="password" name="again" placeholder="the new one again" required autocomplete="new-password">
        <button type="submit">Change the passphrase</button>
        <span class="status note"></span>
      </form>
    </td>
  </tr>`);

  return sendPage(response, 200, page({
    title: 'Keys',
    practitioner,
    banner: keys.length === 0
      ? html`<p class="warning">This practice has no key yet, so it cannot be sent files.
          <a href="/setup">Make one</a>.</p>`
      : null,
    body: html`
      <h1>Keys</h1>
      ${keys.length === 0
        ? ''
        : html`<table>
            <thead><tr><th align="left">Made</th><th align="left">What it is for</th><th align="left">Passphrase</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
      <p><a href="/setup">Make a new key</a> — for files that arrive from now on. The ones you have
      keep working.</p>
      <p class="note">Changing a passphrase does not change the key, so nothing has to be
      re-encrypted and no file becomes unopenable. Store the new one somewhere that is not this
      server: a copy of a key without its passphrase is a file nobody can open.</p>
      ${keys.length > 0 ? jsonTag('key-records', { keys: keys.map((key) => ({ id: key.id, wrapped: key.wrappedPrivateKey })) }) : ''}
      ${keys.length > 0 ? raw('<script type="module" src="/assets/keys.js"></script>') : ''}`,
  }));
}

/**
 * Accept a key re-wrapped under a new passphrase.
 *
 * The server cannot check the old passphrase, because checking it would mean being able to open the
 * record — which is the thing it must not be able to do. What it does check is that the new record
 * is one it would have written: the right shape, and a KDF cost inside what this version accepts.
 */
async function changePassphrase({ db, request, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const wrapped = field(fields, 'wrapped_private_key');

  const problem = wrappedKeyProblem(wrapped);
  if (problem) return fail(response, 400, problem, practitioner);

  const changed = replaceWrappedKey(db, practitioner.id, params[0], wrapped);
  if (!changed) return fail(response, 404, 'There is no key of yours with that id.', practitioner);
  return redirect(response, '/keys');
}
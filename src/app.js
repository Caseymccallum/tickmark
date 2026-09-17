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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.js';
import { clearSessionCookie, createSession, endSession, practitionerFor, sessionCookie } from './auth.js';
import { RequestError, field, formFields, readBody } from './http.js';
import { html, page, raw, redirect, sendPage } from './views.js';
import { newId, now } from './db.js';
import {
  createPractitioner,
  createRequest,
  findOrCreateClient,
  history,
  issueToken,
  itemInRequest,
  itemsOf,
  practitionerByEmail,
  recordUpload,
  requestFor,
  requestsFor,
  revokeToken,
  tokenLookup,
  tokensFor,
  uploadsOf,
} from './store.js';

const MIN_PASSWORD = 12;
const MAX_ITEMS = 50;
const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024;

export const ROUTES = [
  ['GET', '/', home],
  ['GET', '/signup', signUpForm],
  ['POST', '/signup', signUp],
  ['GET', '/signin', signInForm],
  ['POST', '/signin', signIn],
  ['POST', '/signout', signOut],
  ['GET', '/requests', listRequests],
  ['GET', '/requests/new', newRequestForm],
  ['POST', '/requests', createRequestPage],
  ['GET', /^\/requests\/([^/]+)$/, viewRequest],
  ['POST', /^\/requests\/([^/]+)\/link$/, issueLink],
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

export function createApp(db, { blobDir = 'data/blobs', maxUploadBytes = DEFAULT_MAX_UPLOAD } = {}) {
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
        await handler({ ...context, blobDir, maxUploadBytes });
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

function listRequests({ db, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const rows = requestsFor(db, practitioner.id);

  const table = rows.length === 0
    ? html`<p>No requests yet. <a href="/requests/new">Start one</a>.</p>`
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
    title: 'Requests',
    practitioner,
    body: html`
      <h1>Requests</h1>
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
  const events = history(db, found.id);

  const rows = items.map((item) => {
    const files = filesFor.get(item.id) ?? [];
    return html`<tr>
      <td>${item.label}</td>
      <td>${files.length > 0 ? html`<strong>received</strong>` : 'outstanding'}</td>
      <td>${files.length === 0
        ? html`<span class="note">—</span>`
        : files.map((file) => html`<div>${file.filename} <span class="note">${file.uploaded_at}</span></div>`)}</td>
    </tr>`;
  });

  return sendPage(response, 200, page({
    title: found.title,
    practitioner,
    body: html`
      <h1>${found.title} <span class="note">for ${found.client_name}</span></h1>
      <p>${received} of ${items.length} received${found.due_at ? html`, due ${found.due_at}` : ''}.</p>
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
      <p class="warning">Files uploaded through a link are stored <strong>as they
      are</strong>: the browser-side encryption that is meant to make the server unable to
      read them is not built yet. Until it is, do not send a link to a real client.</p>`,
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
async function issueLink({ db, request, response, practitioner, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practitioner.id, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

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
    banner: html`<p class="warning"><strong>This is the link — copy it now. It will not be
      shown again.</strong> Only a digest of it is stored, so nobody can recover it later,
      including whoever runs this server.<br>
      <code>/r/${token}</code></p>`,
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
    banner: html`<p class="warning"><strong>This is not private yet.</strong> Anything you
      send goes to the practice's server and is stored there as it is. The encryption that
      will make it unreadable to whoever runs the server is not built yet.</p>`,
    body: html`
      <h1>${open.title}</h1>
      <p>${open.client_name}${open.due_at ? html` · needed by ${open.due_at}` : ''}</p>
      <table>
        <thead><tr><th align="left">Document</th><th align="left">State</th><th align="left">Send it</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">Nothing here needs an account. Come back to this page with the same
      link to send the rest — the list shows what has already arrived.</p>
      ${raw(UPLOAD_SCRIPT)}`,
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

  return sendJson(response, 201, { ok: true, received: item.label, bytes: body.length });
}

/**
 * The only JavaScript the product ships, and it is inline rather than a file because it is
 * a dozen lines and a build step would be a heavier thing than the feature.
 *
 * It exists because the encryption that comes next happens in the browser with Web Crypto,
 * so the upload has to be a fetch rather than a form post. When that lands, this script
 * encrypts the file before sending it and nothing on the server changes — which is the
 * whole point of the server treating an upload as bytes it does not interpret.
 */
const UPLOAD_SCRIPT = `<script>
for (const form of document.querySelectorAll('form.upload')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = form.querySelector('input[type=file]').files[0];
    const status = form.querySelector('.status');
    if (!file) return;
    status.textContent = 'Sending ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
          'x-file-type': file.type || 'application/octet-stream'
        },
        body: file
      });
      if (response.ok) { location.reload(); return; }
      status.textContent = (await response.text()).replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
    } catch (error) {
      status.textContent = 'That did not work: ' + error.message;
    }
  });
}
</script>`;
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

import { hashPassword, verifyPassword } from './crypto.js';
import { clearSessionCookie, createSession, endSession, practitionerFor, sessionCookie } from './auth.js';
import { RequestError, field, formFields, readBody } from './http.js';
import { html, page, redirect, sendPage } from './views.js';
import {
  createPractitioner,
  createRequest,
  findOrCreateClient,
  history,
  itemsOf,
  practitionerByEmail,
  requestFor,
  requestsFor,
  uploadsOf,
} from './store.js';

const MIN_PASSWORD = 12;
const MAX_ITEMS = 50;

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

export function createApp(db) {
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

        await handler(await contextFor(db, request, response, url, params.slice(1)));
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
      <p class="warning">There is no client link yet. Sending the list to a client is the
      next piece of work, and until it exists this page is only a checklist you keep
      for yourself.</p>`,
  }));
}
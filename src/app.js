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
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
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
import { sendMail } from './mailer.js';
import {
  addItems,
  addPracticeKey,
  clearItemAttention,
  closeRequest,
  closedCount,
  createPractitioner,
  createPractice,
  allPracticeKeys,
  createInvite,
  createRequest,
  findOrCreateClient,
  history,
  inTransaction,
  inviteByToken,
  invitesOf,
  issueToken,
  claimInvite,
  membersOf,
  practiceFor,
  renamePractice,
  wrappingHoldersOf,
  itemInRequest,
  itemsOf,
  practiceKeys,
  filesPerKey,
  practitionerByEmail,
  recordEvent,
  recordUpload,
  reopenRequest,
  replaceWrappedKey,
  requestFor,
  requestProgress,
  requestsFor,
  revokeToken,
  setClientSays,
  setItemAttention,
  setItemReviewed,
  setItemWithdrawn,
  tokenLookup,
  tokensFor,
  uploadsOf,
  uploadsSealedTo,
  replaceUpload,
  retirePracticeKey,
  memberIn,
  removeMember,
  removedMembersOf,
  setCadence,
} from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const MIN_PASSWORD = 12;

/**
 * How long an invitation stays usable.
 *
 * Seven days: long enough to survive a weekend and a person being away, short enough that a link found
 * in a mailbox in a year is not a key. It is one number, in one place, and the page says it out loud.
 */
const INVITE_DAYS = 7;

/**
 * What each request state is called on a screen.
 *
 * "Ready to work on" is the word the research uses and the word a practice would use. The other two
 * describe **whose turn it is**, because that is the question the list exists to answer — and "waiting
 * on the client" is a different job from "the client has sent something and nobody has opened it".
 */
const REQUEST_STATE_WORDS = {
  ready: 'ready to work on',
  'to-check': 'files to check',
  waiting: 'waiting on the client',
};

/**
 * What a client can say instead of nothing.
 *
 * A client who cannot produce a document is otherwise stuck: they can upload a file or they can go
 * quiet, and going quiet is indistinguishable from not having read the request. These two sentences give
 * them a third option, and they are stored in the client's own words alongside the label.
 */
const CLIENT_SAYS = {
  'send-later': 'I will send this later',
  'do-not-have': 'I do not have this',
};

/**
 * How long a link in a bulk reminder works for.
 *
 * The single-request page offers a choice and defaults to thirty days. A run writing to a whole client
 * list has no form to ask on, so it uses that same default rather than inventing a second one.
 */
const REMINDER_DAYS = 30;

/**
 * The most days a practice may set as its chase cadence.
 *
 * A year, because a cadence longer than a season is a cadence that silences the button for a whole season
 * — which is not what the setting is for. Zero is allowed and means "no limit", which is the default.
 */
const MAX_CADENCE_DAYS = 365;

/**
 * How long a practice name may be.
 *
 * Not a database limit — `name` is TEXT and would take anything — but a display one: it appears in the
 * page header, in the table on the members page, and on the page a new member lands on. A hundred and
 * twenty characters is more than any firm needs and short enough to still be a heading.
 */
const MAX_PRACTICE_NAME = 120;
const MAX_ITEMS = 50;
const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024;

/** The browser-side scripts, served by name. An allowlist, so no request can name a path. */
const ASSETS = new Map([
  ['tickmark-crypto.js', 'application/javascript; charset=utf-8'],
  ['upload.js', 'application/javascript; charset=utf-8'],
  ['setup.js', 'application/javascript; charset=utf-8'],
  ['download.js', 'application/javascript; charset=utf-8'],
  ['keys.js', 'application/javascript; charset=utf-8'],
  ['members.js', 'application/javascript; charset=utf-8'],
  ['invite.js', 'application/javascript; charset=utf-8'],
  ['reencrypt.js', 'application/javascript; charset=utf-8'],
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
  ['GET', '/members', membersPage],
  ['POST', '/members/invite', createInvitePage],
  ['POST', '/members/name', renamePracticePage],
  // Removal is two steps on purpose: a page that says what will happen (and what will not), then the act.
  ['GET', /^\/members\/([^/]+)\/remove$/, removeMemberPage],
  ['POST', /^\/members\/([^/]+)\/remove$/, removeMemberAction],
  ['GET', /^\/assets\/([A-Za-z0-9._-]+)$/, asset],
  ['GET', '/requests', listRequests],
  ['GET', '/requests/new', newRequestForm],
  ['POST', '/requests', createRequestPage],
  ['GET', /^\/requests\/([^/]+)$/, viewRequest],
  ['GET', /^\/requests\/([^/]+)\/files\/([^/]+)$/, serveEnvelope],
  ['POST', /^\/requests\/([^/]+)\/link$/, issueLink],
  ['POST', /^\/requests\/([^/]+)\/remind$/, draftReminder],
  ['POST', /^\/requests\/([^/]+)\/send-reminder$/, sendReminder],
  ['POST', /^\/requests\/([^/]+)\/close$/, closeRequestPage],
  ['POST', /^\/requests\/([^/]+)\/reopen$/, reopenRequestPage],
  ['POST', /^\/requests\/([^/]+)\/items$/, addItemsPage],
  ['POST', /^\/requests\/([^/]+)\/items\/([^/]+)\/([a-z-]+)$/, changeItemPage],
  ['POST', /^\/requests\/([^/]+)\/revoke$/, revokeLink],
  // The run that writes to everyone at once. A GET to look before pressing, a POST to press.
  ['GET', '/chase', chasePage],
  ['POST', '/chase', sendAllReminders],
  ['POST', '/chase/cadence', setCadencePage],
  // Re-sealing a stored document to a newer key, and retiring a key that no longer opens anything.
  ['GET', /^\/keys\/([^/]+)\/pending$/, pendingFor],
  ['POST', /^\/keys\/([^/]+)\/move$/, moveWithoutScript],
  ['POST', /^\/files\/([^/]+)\/reencrypt$/, reencryptFile],
  ['POST', /^\/keys\/([^/]+)\/retire$/, retireKey],
  // Public: no session, gated by the token in the path.
  ['GET', /^\/r\/([^/]+)$/, clientPage],
  ['POST', /^\/r\/([^/]+)\/items\/([^/]+)\/says$/, clientSays],
  ['POST', /^\/r\/([^/]+)\/items\/([^/]+)$/, receiveUpload],
  // Public: no session, gated by the token in the path — and by the secret in the fragment, which the
  // server never sees. Whoever holds the link can accept it; the page says so rather than implying the
  // link is addressed to anyone in particular.
  ['GET', /^\/invite\/([^/]+)$/, invitePage],
  ['POST', /^\/invite\/([^/]+)$/, acceptInvite],
];

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/** Everything a handler is given, so that every handler has one signature. */
async function contextFor(db, request, response, url, params) {
  const practitioner = practitionerFor(db, request);
  // Resolved here, once, so that no handler has to remember to ask. A handler that needs the person
  // — for a name in the header, or for provenance — uses `practitioner`. One that needs the firm's
  // data uses `practiceId`.
  return { db, request, response, url, params, practitioner, practiceId: practitioner?.practiceId ?? null };
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
  mailer = null,
  // How long a run of reminders may take. Injected so that a test can watch the run stop halfway, which
  // is otherwise a two-minute test — and a safety property that cannot be tested is a safety property
  // nobody has checked.
  chaseBudgetMs = CHASE_BUDGET_MS,
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
        await handler({ ...context, blobDir, maxUploadBytes, webDir, mailer, chaseBudgetMs });
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
  // A practice and its first member, created together. A practitioner belonging to no firm would be a
  // row nothing else can reach, so the two happen in one transaction or not at all.
  //
  // The name is a placeholder. Nothing in a sign-up form says what the firm is called — it asks for an
  // email and a password — and inventing a name from the address would be worse than a neutral label
  // the owner can change. Stage C of `docs/members.md` is where a practice gets named.
  const practitionerId = inTransaction(db, () => {
    const practiceId = createPractice(db, { name: 'My practice' });
    return createPractitioner(db, { practiceId, email, passwordHash });
  });
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

  // A removed member who gives the right password is told the truth, and one who gives the wrong one is
  // told nothing. The order is the point: answering "that account was removed" before checking the
  // password would let anyone test whether somebody ever worked at a given firm, which is a fact about
  // that firm's staff rather than about the asker.
  if (record && accepted && record.removed_at !== null) {
    return sendPage(response, 403, page({
      title: 'Sign in',
      body: credentialsForm({
        action: '/signin',
        title: 'Sign in',
        submit: 'Sign in',
        error: `That account was removed from its practice on ${record.removed_at.slice(0, 10)}, so it cannot sign in. Your password is correct; the account is no longer a member. Somebody still in the practice can invite you back.`,
        email: email ?? '',
      }),
    }));
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
 * A pure function of the facts, exported so the wording has one home and can be tested directly. It is
 * a *draft*: the page puts it in a textarea the practice edits before sending, because the tool does
 * not know this client and the practice does.
 *
 * Two lists rather than one, because "we have not seen this" and "what you sent does not work" are
 * different sentences to receive, and the second one needs to say what was wrong.
 *
 * The escape hatch near the end is not politeness. A reminder listing a document the client cannot
 * supply — because it does not apply to them, or they have already explained why — is a reminder that
 * gets ignored, and the cheapest way to prevent that is to invite the reply.
 */
export function reminderDraft({ clientName, title, dueAt, outstanding, again = [], theySaid = [], link }) {
  const lines = [`Hello ${clientName},`, ''];

  if (outstanding.length > 0) {
    lines.push(
      `We are still waiting on ${outstanding.length === 1 ? 'one document' : `${outstanding.length} documents`} for ${title}:`,
      '',
      ...outstanding.map((label) => `  - ${label}`),
      '',
    );
  }

  if (again.length > 0) {
    lines.push(
      outstanding.length > 0 ? 'These need sending again:' : `These need sending again for ${title}:`,
      '',
      ...again.map((item) => `  - ${item.label}${item.note ? ` (${item.note})` : ''}`),
      '',
    );
  }

  // What the client already told us, repeated back so they can see it was read — and so the practice
  // has to look at it before sending. Chasing somebody about a document they have already explained
  // they cannot produce is the fastest way to make a client stop answering.
  if (theySaid.length > 0) {
    lines.push(
      'You told us about these already, so this is just a note rather than a request:',
      '',
      ...theySaid.map((item) => `  - ${item.label} (you said: ${item.says})`),
      '',
    );
  }

  lines.push('You can send them at this link — no account or password needed:', link);
  if (dueAt) lines.push('', `We had these marked as needed by ${dueAt}.`);
  lines.push(
    '',
    'If something on the list does not apply to you, reply and tell us — it is easier than sending the wrong thing.',
    '',
    'Thanks,',
  );

  return { subject: `Still needed for ${title}`, body: lines.join('\n') };
}

function listRequests({ db, response, practitioner, url, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const showingClosed = url.searchParams.get('closed') === '1';
  const wanted = url.searchParams.get('state');
  const all = requestsFor(db, practiceId, { includeClosed: showingClosed });
  const closed = closedCount(db, practiceId);
  const today = now().slice(0, 10);

  const counts = {};
  for (const row of all) counts[row.progress.state] = (counts[row.progress.state] ?? 0) + 1;

  // Ordered by whose turn it is, then by the nearest deadline. The list exists to answer "what do I do
  // now?", and a list ordered by when a request was created answers "what did I touch most recently?" —
  // which is not the question.
  const order = { 'to-check': 0, waiting: 1, ready: 2 };
  const rows = all
    .filter((row) => !wanted || row.progress.state === wanted)
    .sort((a, b) => {
      const rank = (order[a.progress.state] ?? 9) - (order[b.progress.state] ?? 9);
      if (rank !== 0) return rank;
      if (a.due_at !== b.due_at) return (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');
      return a.client_name.localeCompare(b.client_name);
    });

  const dueCell = (row) => {
    if (!row.due_at) return html`<span class="note">no date</span>`;
    if (row.due_at < today && !showingClosed) {
      return html`<strong class="error">overdue</strong> <span class="note">${row.due_at}</span>`;
    }
    return row.due_at;
  };

  const table = rows.length === 0
    ? html`<p>${showingClosed
        ? 'Nothing has been closed yet.'
        : wanted
          ? html`Nothing is in that state. <a href="/requests">Show everything open</a>.`
          : html`No requests yet. <a href="/requests/new">Start one</a>.`}</p>`
    : html`<table>
        <thead><tr><th align="left">Client</th><th align="left">Request</th><th align="left">State</th><th align="left">Due</th><th align="left">Outstanding</th><th align="left">To check</th></tr></thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td>${row.client_name}</td>
            <td><a href="/requests/${row.id}">${row.title}</a></td>
            <td><a href="/requests?state=${row.progress.state}">${REQUEST_STATE_WORDS[row.progress.state]}</a></td>
            <td>${dueCell(row)}</td>
            <td>${row.progress.outstanding === 0 ? html`<strong>none</strong>` : row.progress.outstanding}</td>
            <td>${row.progress.toCheck === 0 ? html`<span class="note">—</span>` : row.progress.toCheck}</td>
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
      ${showingClosed || all.length === 0
        ? ''
        : html`<p class="note">
            ${(counts['to-check'] ?? 0) > 0
              ? html`<a href="/requests?state=to-check"><strong>${counts['to-check']}</strong> with files to check</a> &middot; `
              : ''}
            <a href="/requests?state=waiting">${counts.waiting ?? 0} waiting on clients</a> &middot;
            <a href="/requests?state=ready">${counts.ready ?? 0} ready to work on</a> &middot;
            <a href="/requests">all ${all.length}</a>
          </p>`}
      ${table}
      <p><a href="/requests/new">New request</a>${showingClosed || all.length === 0
        ? ''
        : html` &middot; <a href="/chase">chase everyone outstanding</a>`}</p>`,
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

function newRequestForm({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;

  // `?from=<request id>` fills the form in from a request that already exists.
  //
  // This is the smallest honest version of a template, and it is aimed at the biggest repeat cost in
  // the research: the same list, rebuilt from scratch every January. It *fills the form in* rather than
  // creating the request outright, so the practice sees and adjusts the list before it goes anywhere —
  // which is also why it needs no stored template, no schedule and no name for itself.
  const from = url?.searchParams?.get('from');
  const source = from ? requestFor(db, practiceId, from) : null;

  const values = source
    ? {
        client: source.client_name,
        client_email: source.client_email ?? '',
        title: '',
        due: '',
        items: itemsOf(db, source.id)
          .filter((item) => !item.withdrawn)
          .map((item) => (item.note ? `${item.label} — ${item.note}` : item.label))
          .join('\n'),
      }
    : {};

  return sendPage(response, 200, page({
    title: 'New request',
    practitioner,
    banner: source
      ? html`<p class="note">Filled in from <a href="/requests/${source.id}">${source.title}</a> for
          ${source.client_name}. Change anything you like — nothing is created until you press the
          button, and the earlier request is not touched.</p>`
      : null,
    body: requestForm({ values }),
  }));
}

async function createRequestPage({ db, request, response, practitioner, practiceId }) {
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

  const clientId = findOrCreateClient(db, { practiceId, createdBy: practitioner.id, name: clientName, email: clientEmail });
  const requestId = createRequest(db, {
    practiceId,
    createdBy: practitioner.id,
    clientId,
    title,
    dueAt: due,
    items,
  });
  return redirect(response, `/requests/${requestId}`);
}

function viewRequest({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  // A reminder that was just sent says so here. The confirmation has to be on the page the practice
  // lands on, because "did it go?" is the whole question a send raises, and the answer is otherwise
  // only in the history below.
  const sent = new URL(request.url, 'http://localhost').searchParams.get('sent');
  const sentWithoutLink = new URL(request.url, 'http://localhost').searchParams.get('nolink') === '1';

  const allItems = itemsOf(db, found.id);
  const live = allItems.filter((item) => !item.withdrawn);
  const withdrawn = allItems.filter((item) => item.withdrawn);
  const links = tokensFor(db, found.id);
  const filesFor = new Map();
  for (const upload of uploadsOf(db, found.id)) {
    const list = filesFor.get(upload.request_item_id) ?? [];
    list.push(upload);
    filesFor.set(upload.request_item_id, list);
  }
  const filesOf = (item) => filesFor.get(item.id) ?? [];
  const received = live.filter((item) => filesOf(item).length > 0).length;
  const outstanding = live.filter((item) => filesOf(item).length === 0);
  const attention = live.filter((item) => item.needsAttention);
  // Computed from the same function the list uses, so the page and the board cannot disagree.
  const progress = requestProgress(db, found.id);
  const events = history(db, found.id);

  // The confirmation line, when the practice has just arrived from a send.
  const sentNotice = sent
    ? html`<p class="${sentWithoutLink ? 'warning' : 'success'}"><strong>Reminder sent.</strong> Its
        identifier is <code>${sent}</code> — if a client says it never arrived, this is what to quote to
        your mail provider.${sentWithoutLink
          ? html` <strong>There was no link in the message</strong>, so the client cannot send anything
              from it — draft another reminder if that was not what you meant.`
          : ''}</p>`
    : null;

  /** What the practice can say about one item — which is what makes the list a living thing. */
  const controlsFor = (item) => html`
    ${item.received
      ? item.checked
        ? html`<form method="post" action="/requests/${found.id}/items/${item.id}/uncheck" class="inline">
            <button type="submit">Not checked after all</button>
          </form>`
        : html`<form method="post" action="/requests/${found.id}/items/${item.id}/check" class="inline">
            <button type="submit">Checked it</button>
          </form>`
      : ''}
    ${item.needsAttention
      ? html`<form method="post" action="/requests/${found.id}/items/${item.id}/clear-attention" class="inline">
          <button type="submit">Dealt with</button>
        </form>`
      : html`<form method="post" action="/requests/${found.id}/items/${item.id}/attention" class="inline">
          <input type="text" name="attention_note" placeholder="why? the client sees this" maxlength="500">
          <button type="submit">Needs attention</button>
        </form>`}
    <form method="post" action="/requests/${found.id}/items/${item.id}/withdraw" class="inline">
      <button type="submit">Stop asking</button>
    </form>`;

  const rows = live.map((item) => html`<tr>
    <td>${item.label}${item.note ? html`<br><span class="note">${item.note}</span>` : ''}</td>
    <td>${item.needsAttention
      ? html`<strong>needs attention</strong>${item.attentionNote ? html`<br><span class="note">${item.attentionNote}</span>` : ''}`
      : !item.received && item.clientSays
        ? html`<strong>client says:</strong> <span class="note">${item.clientSays}</span>`
        : item.received
          ? item.checked
            ? html`<strong>checked</strong>`
            : html`<strong>to check</strong> <span class="note">nobody has looked at this yet</span>`
          : 'outstanding'}</td>
    <td>${filesOf(item).length === 0
      ? html`<span class="note">—</span>`
      : filesOf(item).map((file) => html`<div class="file">
          <span class="name">${file.filename}</span>
          <span class="note">${file.uploaded_at}</span>
          <button type="button" class="save" disabled
                  data-url="/requests/${found.id}/files/${file.id}"
                  data-name="${file.filename}">Save</button>
          <span class="status note"></span>
          ${file.client_note ? html`<div class="note">they said: ${file.client_note}</div>` : ''}
        </div>`)}</td>
    <td>${found.closed_at ? html`<span class="note">closed</span>` : controlsFor(item)}</td>
  </tr>`);

  // The wrapped keys travel in the page because the decryption happens here. They leak nothing — the
  // server already stores them, and they are useless without the passphrase — and they have to be
  // here, or the plaintext would have to be produced by the server, which is the one thing that must
  // not happen. All of them, because a file sent before the last rotation is encrypted to an older
  // key.
  const keys = practiceKeys(db, practiceId, practitioner.id);

  return sendPage(response, 200, page({
    title: found.title,
    practitioner,
    body: html`
      <h1>${found.title} <span class="note">for ${found.client_name}</span></h1>
      ${sentNotice}
      ${found.closed_at ? html`<p class="note"><strong>Closed.</strong></p>` : ''}
      <p>${received} of ${live.length} received${found.due_at ? html`, due ${found.due_at}` : ''}${withdrawn.length > 0 ? html` · ${withdrawn.length} no longer asked for` : ''}.</p>
      ${found.closed_at || progress.items === 0
        ? ''
        : progress.state === 'ready'
          ? html`<p class="success"><strong>Ready to work on.</strong>
              Everything asked for has arrived and been checked.${progress.checked > 0
                ? html` Last checked against ${progress.checked} document${progress.checked === 1 ? '' : 's'}.`
                : ''}</p>`
          : progress.state === 'to-check'
            ? html`<p class="warning"><strong>Files to check.</strong> ${progress.toCheck}
                ${progress.toCheck === 1 ? 'document has' : 'documents have'} arrived and nothing has looked
                at ${progress.toCheck === 1 ? 'it' : 'them'} yet. "Received" is not "ready" — do this before
                chasing anything else, because what is already here is the thing a client is least likely
                to send twice.</p>`
            : html`<p class="note">Waiting on the client for ${progress.outstanding} of
                ${progress.items} ${progress.items === 1 ? 'document' : 'documents'}.
                ${progress.clientSaid > 0
                  ? html`${progress.clientSaid} ${progress.clientSaid === 1 ? 'has' : 'have'} an answer
                      from the client — see the list below.`
                  : ''}</p>`}
      ${attention.length > 0
        ? html`<p class="warning"><strong>${attention.length === 1 ? 'One document needs attention' : `${attention.length} documents need attention`}:</strong>
            ${attention.map((item) => item.label).join(', ')}. The client's page says what is wrong with
            each one, and the next reminder asks for them again.</p>`
        : ''}
      <p class="note"><a href="/requests/new?from=${found.id}">Start another request like this one</a> —
      for next year, or for another client with the same paperwork.</p>
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
        <thead><tr><th align="left">Document</th><th align="left">State</th><th align="left">Files</th><th align="left">What you can say</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${!found.closed_at
        ? html`<form method="post" action="/requests/${found.id}/items">
            <label for="new-items">Remembered something else? <span class="note">one document per line</span></label>
            <textarea id="new-items" name="items" rows="3" placeholder="The 2024 statements as well"></textarea>
            <button type="submit">Add to this request</button>
          </form>`
        : ''}
      ${withdrawn.length > 0
        ? html`<h2>No longer being asked for</h2>
            <ul>${withdrawn.map((item) => html`<li>${item.label}
              <form method="post" action="/requests/${found.id}/items/${item.id}/restore" class="inline">
                <button type="submit">Ask for it again</button>
              </form></li>`)}</ul>
            <p class="note">Withdrawn rather than deleted: the client's page stops asking, and the
            record keeps saying it was once asked for.</p>`
        : ''}
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
async function serveEnvelope({ db, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
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

async function issueLink({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;

  // Ownership first, key second. A request belonging to somebody else must be *not found*
  // whatever state this practice is in — a refusal that depends on my own setup would leak
  // whether the request exists.
  const found = requestFor(db, practiceId, params[0]);
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

async function revokeLink({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const tokenId = field(fields, 'token_id');
  const revoked = tokenId ? revokeToken(db, practiceId, tokenId) : false;
  if (!revoked) {
    return fail(response, 400, 'That link is not one of yours, or it was already revoked.', practitioner);
  }
  return redirect(response, `/requests/${found.id}`);
}

const outstandingOf = (db, requestId) => {
  // An item the practice has flagged stays on the list even though a file came in: what arrived is not
  // usable, so the next reminder has to ask again. A withdrawn item leaves the list entirely. Now read
  // from the item's own `received` flag rather than from a separate set of uploads — one query, one
  // answer about what counts as arrived.
  return itemsOf(db, requestId).filter(
    (item) => !item.withdrawn && (!item.received || item.needsAttention),
  );
};

/**
 * The reminder for one request: the words, and the list they were built from.
 *
 * One function, used by the single-request page and by the run that writes to everybody. Two
 * implementations of "what does a reminder say" would be two things free to disagree — and the place
 * the disagreement would show up is a client's inbox.
 */
function messageFor({ db, found, origin, token }) {
  const items = itemsOf(db, found.id);
  const outstanding = outstandingOf(db, found.id);

  return {
    outstanding,
    total: items.length,
    ...reminderDraft({
      clientName: found.client_name,
      title: found.title,
      dueAt: found.due_at,
      outstanding: outstanding.filter((item) => !item.needsAttention).map((item) => item.label),
      again: outstanding
        .filter((item) => item.needsAttention)
        .map((item) => ({ label: item.label, note: item.attentionNote })),
      // Everything the client has said, not only the items still outstanding: what they said about an
      // item that has since arrived is part of the record, and the practice should see it in the draft
      // rather than discover it later.
      theySaid: items
        .filter((item) => !item.withdrawn && item.clientSays)
        .map((item) => ({ label: item.label, says: item.clientSays })),
      link: `${origin}/r/${token}`,
    }),
  };
}

/**
 * How long a run of reminders may take before it stops and reports where it got to.
 *
 * Node's own `requestTimeout` is five minutes by default, and a run that reached it would be cut off
 * mid-sentence — with some clients written to and no record of how far it got, which is the one failure
 * this feature must not have. So the run bounds itself, well inside that limit, leaving room for the
 * response to be written.
 *
 * A count would be the wrong bound. A fast relay and a slow one deserve different answers, and elapsed
 * time is what the limit is actually about: the same run should write to forty clients in seconds and
 * to four if the relay is crawling.
 */
const CHASE_BUDGET_MS = 120000;

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
async function draftReminder({ db, request, response, practitioner, params, mailer, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
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

  const message = messageFor({ db, found, origin: originOf(request), token });

  return sendPage(response, 200, reminderPage({
    mailer,
    practitioner,
    found,
    draft: { subject: message.subject, body: message.body },
    days,
    outstanding: message.outstanding.length,
    total: message.total,
  }));
}

/**
 * The reminder, as a page the practice can edit before it goes anywhere.
 *
 * The fields are **editable**, which is the honest reading of "a draft": what is in them is what gets
 * sent, so an edit is a decision rather than a decoration. The first version made them read-only, which
 * is one keystroke away from the same thing but tells the practice their words do not matter.
 *
 * Sending is offered only when it can work — a mail server configured, and an address to send to — and
 * when it cannot, the page says what is missing rather than showing a button that fails. Same rule as
 * everywhere else here: no control that cannot do what it says.
 */
function reminderPage({ mailer, practitioner, found, draft, days, outstanding, total, error = null }) {
  const canSend = Boolean(mailer) && Boolean(found.client_email);

  const whyNot = !mailer
    ? html`<p class="note">Tickmark cannot send this by itself, because this installation has no mail
        server configured. Set <code>TICKMARK_SMTP_URL</code> and <code>TICKMARK_MAIL_FROM</code> and
        restart it — <code>docs/roadmap.md</code> says what to point them at, and why deliverability is
        a different problem from sending.</p>`
    : !found.client_email
      ? html`<p class="note">There is no email address for ${found.client_name} on this request, so there
          is nowhere to send it. Add one, or copy the message and send it yourself.</p>`
      : '';

  return page({
    title: `A reminder for ${found.client_name}`,
    practitioner,
    banner: error
      ? html`<p class="error"><strong>Not sent.</strong> ${error}<br>Nothing you typed is lost — it is
          below, and you can try again or copy it.</p>`
      : canSend
        ? html`<p class="warning">Sending from <strong>${mailer.describe()}</strong> to
            <strong>${found.client_email}</strong>.</p>`
        : html`<p class="warning">Tickmark does not send this. Copy it into whatever you send mail with,
            to <strong>${found.client_email ?? 'the client'}</strong>.</p>`,
    body: html`
      <h1>A reminder for ${found.client_name}</h1>
      <p>${outstanding} of ${total} still outstanding. The link in the message is new, it works for
      ${days} days, and <strong>it is not recoverable</strong> — if you lose it, draft the reminder
      again.</p>
      ${whyNot}
      <form method="post" action="/requests/${found.id}/send-reminder">
        <label for="subject">Subject</label>
        <textarea id="subject" name="subject" rows="2">${draft.subject}</textarea>
        <label for="message">Message <span class="note">what you see is what gets sent</span></label>
        <textarea id="message" name="message" rows="18" onclick="this.focus(); this.select();">${draft.body}</textarea>
        ${canSend
          ? html`<button type="submit">Send it to ${found.client_email}</button>`
          : html`<button type="submit" disabled>Send it</button>`}
      </form>
      <p><a href="/requests/${found.id}">Back to the request</a></p>`,
  });
}

/**
 * Send the reminder that is on the screen.
 *
 * Two rules, and both are why this is not a one-line handler:
 *
 * 1. **The text comes from the form.** The practice may have edited it, and their words are what their
 *    client should receive.
 * 2. **A failure keeps the text.** The page is re-rendered with everything still in it and a sentence
 *    saying what went wrong, because a send that loses what someone typed is worse than a send that
 *    fails — and both are recorded, so "did we actually send it?" can be answered by reading.
 */
async function sendReminder({ db, request, response, practitioner, params, mailer, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (!mailer) {
    return fail(response, 400, 'This installation has no mail server configured, so nothing can be sent.', practitioner);
  }
  if (!found.client_email) {
    return fail(response, 400, `There is no email address for ${found.client_name}, so there is nowhere to send it.`, practitioner);
  }

  const fields = formFields(await readBody(request));
  const subject = field(fields, 'subject');
  const body = typeof fields.message === 'string' ? fields.message : '';
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);
  const outstanding = outstandingOf(db, found.id);

  const refuse = (error) => sendPage(
    response,
    400,
    reminderPage({
      mailer,
      practitioner,
      found,
      draft: { subject: subject ?? '', body },
      days,
      outstanding: outstanding.length,
      total: itemsOf(db, found.id).length,
      error,
    }),
  );

  if (!subject) return refuse('A subject is needed — a message with no subject is one a client is likely to delete.');
  if (body.trim().length === 0) return refuse('The message was empty.');

  try {
    const { messageId } = await sendMail(mailer, { to: found.client_email, subject, body });

    // A reminder with no link in it is a message the client cannot act on — they have nowhere to send
    // anything. It is sent anyway, because the words are the practice's decision, but the page says so
    // afterwards rather than letting a send look like a success when it was not: silence about this is
    // exactly the "fails quietly" problem this feature exists to avoid.
    const hasLink = /\/r\/[A-Za-z0-9_-]{20,}/.test(body);
    recordEvent(db, {
      requestId: found.id,
      kind: 'reminder.sent',
      detail: `to ${found.client_email} (${messageId})${hasLink ? '' : ' — with no link in it'}`,
    });
    return redirect(response, `/requests/${found.id}?sent=${encodeURIComponent(messageId)}${hasLink ? '' : '&nolink=1'}`);
  } catch (error) {
    recordEvent(db, {
      requestId: found.id,
      kind: 'reminder.failed',
      detail: `to ${found.client_email} — ${error.message}`,
    });
    return refuse(error.message);
  }
}

/**
 * Everyone who owes something, in one place, in the order that matters.
 *
 * The research on this is blunt: manual tracking breaks down past fifty clients, and chasing is where a
 * practice's week goes. A board that says who to chase but makes you chase them one at a time has
 * diagnosed the problem without solving it — so this is the list the button acts on, and it is built
 * from the same `outstandingOf` the request page uses rather than from a second definition of
 * "outstanding".
 *
 * The order is urgency first: overdue and soonest-due clients, then whoever owes the most, then
 * alphabetical so the answer is stable. If a run is cut short by the time budget, the clients it
 * reached are the ones nearest their deadline.
 */
function chaseList(db, practiceId) {
  return requestsFor(db, practiceId)
    .map((row) => ({
      ...row,
      outstanding: outstandingOf(db, row.id),
      // When this request was last reminded, so that the page can say it. The run does not refuse to
      // remind somebody twice — chasing is what a practice does, and a second nudge a week later is
      // normal — but it should never be a surprise, and a client written to twice in an hour by accident
      // is exactly the kind of thing a practice would stop trusting the button over.
      lastRemindedAt: db
        .prepare("SELECT MAX(at) AS at FROM event WHERE request_id = ? AND kind = 'reminder.sent'")
        .get(row.id).at,
    }))
    .filter((row) => row.outstanding.length > 0)
    .sort((a, b) => {
      if (a.due_at !== b.due_at) return (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');
      if (a.outstanding.length !== b.outstanding.length) return b.outstanding.length - a.outstanding.length;
      return a.client_name.localeCompare(b.client_name);
    });
}

/**
 * Whether the practice's own cadence holds a reminder back.
 *
 * The rule is one line and it lives in one place, because the page and the run must agree about it: a page
 * that says "this sends 4" over a run that sends 2 would be the same class of lie as a banner that
 * overstates itself anywhere else.
 */
function heldBackBy(line, cadenceDays, nowIso = now()) {
  if (cadenceDays <= 0 || !line.lastRemindedAt) return false;
  const days = (Date.parse(nowIso) - Date.parse(line.lastRemindedAt)) / 86400000;
  return days < cadenceDays;
}

/**
 * The chase list, split by what the button would do to each row.
 *
 * One function read by the pre-flight page and by the run, so the two cannot disagree — and the split is
 * ordered by which reason is more fundamental: **no address beats the cadence**, because a client with no
 * address could not be written to whatever the cadence says, and reporting them as "held by your cadence"
 * would name the wrong problem.
 */
function chaseSplits(db, practiceId) {
  const practice = practiceFor(db, practiceId);
  const cadenceDays = practice?.cadenceDays ?? 0;
  const rows = chaseList(db, practiceId);

  const withoutAddress = rows.filter((row) => !row.client_email);
  const addressed = rows.filter((row) => row.client_email);
  const held = addressed.filter((row) => heldBackBy(row, cadenceDays));
  const sendable = addressed.filter((row) => !heldBackBy(row, cadenceDays));

  return { rows, sendable, held, withoutAddress, cadenceDays };
}

/** How long ago something happened, in words, for a page a person reads. */
function agoWords(iso, nowIso) {
  const minutes = Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The list before the button: exactly who will be written to, and who will not.
 *
 * This page exists because the action has no undo. A practice is about to send real email to real
 * clients under their own name, so they get to see the list, the addresses, and how many documents each
 * one is being chased for — before anything leaves the server. "Are you sure?" on its own would be a
 * worse page: it asks for confidence without giving information.
 */
function chasePage({ db, response, practitioner, practiceId, mailer, url }) {
  if (!requireSignIn({ practitioner, response })) return;

  const { rows, sendable, held, withoutAddress, cadenceDays } = chaseSplits(db, practiceId);
  const saved = url.searchParams.get('saved');
  const justSaved = saved && /^\d+$/.test(saved) ? saved : null;

  const table = rows.length === 0
    ? html`<p>Nothing is outstanding for anyone. <a href="/requests">The board</a> has the full picture.</p>`
    : html`<table>
        <thead><tr><th align="left">Client</th><th align="left">Request</th><th align="left">Outstanding</th><th align="left">To send to</th><th align="left">Last</th></tr></thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td>${row.client_name}</td>
            <td><a href="/requests/${row.id}">${row.title}</a></td>
            <td>${row.outstanding.map((item) => item.label).join(', ')}
              ${row.outstanding.some((item) => item.clientSays)
                ? html`<div class="note">the client has already answered about some of these — the message
                    repeats that back rather than asking again</div>`
                : ''}</td>
            <td>${row.client_email ?? html`<span class="error">no email address on this client</span>`}</td>
            <td>${row.lastRemindedAt
              ? html`<span class="note">reminded ${agoWords(row.lastRemindedAt, now())}</span>`
              : html`<span class="note">never reminded</span>`}
              ${held.includes(row) ? html`<br><span class="warning">held back — inside your cadence</span>` : ''}</td>
          </tr>`)}
        </tbody>
      </table>`;

  return sendPage(response, 200, page({
    title: 'Chase everyone',
    practitioner,
    banner: !mailer
      ? html`<p class="warning">Tickmark has no mail server configured, so nothing can be sent. Set
          <code>TICKMARK_SMTP_URL</code> and <code>TICKMARK_MAIL_FROM</code> and restart it — or open a
          request and copy its reminder by hand.</p>`
      : sendable.length === 0
        ? html`<p class="note">Nothing would be sent at the moment${held.length > 0
            ? html`, because every client who owes something was written to inside your
                ${cadenceDays}-day cadence`
            : ''}. <a href="/requests">The board</a> shows what is outstanding.</p>`
        : html`<p class="warning">This sends <strong>${sendable.length}</strong>
            ${sendable.length === 1 ? 'message' : 'messages'} from
            <strong>${mailer.describe()}</strong>. It cannot be undone or recalled, and each client gets
            their own link.${held.length > 0
              ? html` ${held.length} ${held.length === 1 ? 'client is' : 'clients are'} held back by your
                  cadence.`
              : ''}${withoutAddress.length > 0
              ? html` ${withoutAddress.length} ${withoutAddress.length === 1 ? 'client is' : 'clients are'}
                  left out for want of an email address.`
              : ''}</p>`,
    body: html`
      <h1>Chase everyone who owes you something</h1>
      <p class="note">${rows.length} ${rows.length === 1 ? 'request has' : 'requests have'} something
      outstanding. Each one is sent the ordinary reminder for its own list, with its own link. To change
      the words for one client, open that request and draft it there.</p>
      ${table}
      ${rows.length === 0
        ? ''
        : html`<form method="post" action="/chase">
            ${mailer && sendable.length > 0
              ? html`<button type="submit">Send ${sendable.length}
                  ${sendable.length === 1 ? 'reminder' : 'reminders'}</button>`
              : html`<button type="submit" disabled>Send${mailer ? '' : ' (no mail server)'}</button>`}
          </form>`}

      <h2>How often to chase</h2>
      <form method="post" action="/chase/cadence" class="inline">
        <label>Do not write to the same client more often than every
          <input name="days" type="number" min="0" max="${MAX_CADENCE_DAYS}" value="${cadenceDays}"
            aria-label="Cadence in days" required> days</label>
        <button type="submit">Save</button>
      </form>
      ${justSaved
        ? html`<p class="success">Your cadence is now ${justSaved}
            ${justSaved === '0' ? 'days — no limit' : `day${justSaved === '1' ? '' : 's'}`}.</p>`
        : ''}
      <p class="note"><strong>0 means no limit, and that is where this starts.</strong> How often it is
      acceptable to chase a client is your judgement about your clients, not a number this should pick for
      you — which is why there is no default. Any number of days holds a repeat back: even 1 day stops the
      same client being written to twice in one afternoon, which is the accident worth preventing.
      <strong>It applies to this page only.</strong> Opening one request and sending that reminder by hand
      is never held back, because there you are looking at that client.</p>

      <p class="note">The run stops after ${Math.round(CHASE_BUDGET_MS / 60000)} minutes and reports where
      it got to, so that a slow relay cannot leave half the messages sent with no record of which.
      ${cadenceDays > 0
        ? html`Clients inside your cadence are named in the report rather than dropped quietly.`
        : html`<strong>With no cadence set, it has no memory of who it has already written to:</strong>
            pressing the button twice reminds everyone still outstanding twice — which is why the last
            column above is there, why each request keeps its own history, and why the setting above
            exists.`}</p>
      <p><a href="/requests">Back to the board</a></p>`,
  }));
}

/**
 * Save the practice's chase cadence.
 *
 * A whole number of days, 0 for no limit, and nothing clever about it. The value is validated here rather
 * than in the store because this is where the sentence explaining a refusal can go — and a refusal is what
 * a practice gets for `-1`, for `3.5`, for `"soon"`, or for a number so large the setting would silence
 * the button for a season, which is not what the setting is for.
 */
async function setCadencePage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const raw = (field(fields, 'days') ?? '').trim();
  const days = Number(raw);

  if (!/^\d+$/.test(raw) || !Number.isInteger(days) || days < 0 || days > MAX_CADENCE_DAYS) {
    return fail(
      response,
      400,
      `A cadence has to be a whole number of days between 0 and ${MAX_CADENCE_DAYS}. 0 means no limit, which is where this starts.`,
      practitioner,
    );
  }

  setCadence(db, practiceId, days);
  return redirect(response, `/chase?saved=${days}`);
}

/**
 * Send the ordinary reminder to everyone who owes something.
 *
 * Four rules, each of them a failure this feature would otherwise have:
 *
 * 1. **A failure never stops the run and is never hidden.** One client with a dead mailbox must not stop
 *    the other thirty being written to, and the report says which failed and what the server said.
 * 2. **The run bounds itself in time** — see `CHASE_BUDGET_MS` — and says where it stopped.
 * 3. **Every send is recorded per request**, in the same events the single-send path writes, so a
 *    client's history says what was sent to them and when, whichever way it was sent.
 * 4. **The practice's own cadence is respected, and the clients it holds back are named.** A run that
 *    quietly skipped people would be indistinguishable from a run that wrote to them, which is the one
 *    thing a report must never be. The split comes from `chaseSplits`, the same function the page reads,
 *    so the pre-flight count and the run cannot disagree.
 */
async function sendAllReminders({ db, request, response, practitioner, practiceId, mailer, chaseBudgetMs = CHASE_BUDGET_MS }) {
  if (!requireSignIn({ practitioner, response })) return;
  if (!mailer) {
    return fail(response, 400, 'This installation has no mail server configured, so nothing can be sent.', practitioner);
  }

  const origin = originOf(request);
  const { sendable, held, withoutAddress, cadenceDays } = chaseSplits(db, practiceId);

  const results = [];
  const startedAt = Date.now();

  for (const [index, row] of sendable.entries()) {
    if (Date.now() - startedAt > chaseBudgetMs) {
      for (const rest of sendable.slice(index)) results.push({ row: rest, outcome: 'not-attempted' });
      break;
    }
    results.push(await sendOneReminder(db, row, origin, mailer));
  }

  return sendPage(
    response,
    200,
    chaseReportPage({
      practitioner,
      results,
      skipped: withoutAddress,
      held,
      cadenceDays,
      elapsedMs: Date.now() - startedAt,
    }),
  );
}

/** One request's reminder, sent. Its own function so that the loop above reads as a loop. */
async function sendOneReminder(db, row, origin, mailer) {
  const token = newToken();
  issueToken(db, {
    requestId: row.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + REMINDER_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });

  const message = messageFor({ db, found: row, origin, token });
  const hasLink = /\/r\/[A-Za-z0-9_-]{20,}/.test(message.body);

  try {
    const { messageId } = await sendMail(mailer, {
      to: row.client_email,
      subject: message.subject,
      body: message.body,
    });
    recordEvent(db, {
      requestId: row.id,
      kind: 'reminder.sent',
      detail: `to ${row.client_email} (${messageId})${hasLink ? '' : ' — with no link in it'}`,
    });
    return { row, outcome: 'sent', to: row.client_email, messageId, hasLink };
  } catch (error) {
    recordEvent(db, {
      requestId: row.id,
      kind: 'reminder.failed',
      detail: `to ${row.client_email} — ${error.message}`,
    });
    return { row, outcome: 'failed', to: row.client_email, reason: error.message };
  }
}

/**
 * What happened, per client.
 *
 * This page is the whole reason the run is safe to press. It names every outcome — sent, failed, not
 * attempted, and who was never a candidate — with the server's own words for a failure. A bulk action
 * whose result is "done" teaches a practice to distrust it, and the first time a message quietly did not
 * arrive they would go back to sending them by hand.
 */
function chaseReportPage({ practitioner, results, skipped, held = [], cadenceDays = 0, elapsedMs }) {
  const sent = results.filter((entry) => entry.outcome === 'sent');
  const failed = results.filter((entry) => entry.outcome === 'failed');
  const later = results.filter((entry) => entry.outcome === 'not-attempted');
  const seconds = Math.round(elapsedMs / 1000);

  const outcomeOf = (entry) => (entry.outcome === 'sent'
    ? html`<strong>sent</strong> <span class="note">${entry.messageId}${entry.hasLink ? '' : ' — with no link in it'}</span>`
    : entry.outcome === 'failed'
      ? html`<strong class="error">not sent</strong> <span class="note">${entry.reason}</span>`
      : html`<span class="note">not attempted — the run was out of time</span>`);

  return page({
    title: 'What happened',
    practitioner,
    body: html`
      <h1>What happened</h1>
      <p>${sent.length} sent, ${failed.length} failed, ${later.length} not attempted${held.length > 0
        ? html`, ${held.length} held back by your cadence`
        : ''}${skipped.length > 0
        ? html`, ${skipped.length} with no email address`
        : ''} — in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.</p>
      ${failed.length > 0
        ? html`<p class="error"><strong>${failed.length}
            ${failed.length === 1 ? 'message was' : 'messages were'} not sent.</strong> Nothing was lost:
            each one is still on <a href="/chase">the chase list</a>, so pressing the button again will
            try it again${cadenceDays > 0
              ? html` — but only once your ${cadenceDays}-day cadence lets it, so a failure inside the
                  cadence is a reason to open that request and send it by hand`
              : html` — along with everyone else still outstanding, because no cadence is set and the run
                  keeps no record of who it has already reminded`}.</p>`
        : ''}
      ${held.length > 0
        ? html`<p class="note"><strong>${held.length} ${held.length === 1 ? 'client was' : 'clients were'}
            not written to</strong>, because you asked not to remind the same client more often than every
            ${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'} and they were reminded more recently than
            that. Nothing is wrong: they are still on <a href="/chase">the chase list</a>, and the setting
            is on that page if you want to change it.</p>`
        : ''}
      ${later.length > 0
        ? html`<p class="warning"><strong>The run stopped before it finished.</strong> It reached its time
            budget, which is deliberate — a run cut off by the server halfway through would leave no record
            of who had already been written to. The ${later.length} below are untouched and still on
            <a href="/chase">the chase list</a>.</p>`
        : ''}
      ${results.length + skipped.length + held.length === 0
        ? html`<p>There was nothing to send.</p>`
        : html`<table>
            <thead><tr><th align="left">Client</th><th align="left">Request</th><th align="left">Outcome</th></tr></thead>
            <tbody>
              ${results.map((entry) => html`<tr>
                <td>${entry.row.client_name}</td>
                <td><a href="/requests/${entry.row.id}">${entry.row.title}</a></td>
                <td>${outcomeOf(entry)}</td>
              </tr>`)}
              ${held.map((row) => html`<tr>
                <td>${row.client_name}</td>
                <td><a href="/requests/${row.id}">${row.title}</a></td>
                <td><span class="note">held back by your cadence — reminded ${agoWords(row.lastRemindedAt, now())}</span></td>
              </tr>`)}
              ${skipped.map((row) => html`<tr>
                <td>${row.client_name}</td>
                <td><a href="/requests/${row.id}">${row.title}</a></td>
                <td><span class="note">no email address on this client</span></td>
              </tr>`)}
            </tbody>
          </table>`}
      <p><a href="/requests">Back to the board</a> &middot; <a href="/chase">the chase list</a></p>`,
  });
}

/**
 * The files still sealed to a key, for a re-encryption pass to work through.
 *
 * **This endpoint is the whole of the resume logic.** A file that has been moved is no longer sealed to
 * the old key, so it stops appearing here — which means closing the browser halfway through a pass loses
 * nothing but the time already spent, and reopening the page starts from wherever the data got to. No
 * progress table, no session, no cursor to get out of step with the files themselves.
 */
function pendingFor({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;

  const key = db
    .prepare('SELECT id, deleted_at FROM practice_key WHERE id = ? AND practice_id = ?')
    .get(params[0], practiceId);
  if (!key) return fail(response, 404, 'There is no key with that id in this practice.', practitioner);
  if (key.deleted_at) return sendJson(response, 200, { files: [], retired: true, keyId: key.id });

  const files = uploadsSealedTo(db, key.id, practiceId).map((row) => ({
    id: row.id,
    filename: row.filename,
    // Where the browser fetches the envelope, and where it will post the new one. The download is the
    // ordinary file route, so the pass needs no separate way of reading a document.
    url: `/requests/${row.request_id}/files/${row.id}`,
  }));

  return sendJson(response, 200, { files, retired: false, keyId: key.id });
}

/**
 * Replace one stored envelope with the same document sealed to a newer key.
 *
 * The practice's private key never comes near this: the browser decrypts, re-encrypts, and posts bytes the
 * server cannot read — the same property as an upload. What the server does is what it can honestly do:
 * check the bytes are a well-formed envelope, check the named key belongs to this practice and is live,
 * write them somewhere new, and move the row.
 *
 * **It cannot check the plaintext is the same document**, because that would need the private key. What
 * stands in place of that check is on the browser side, which verifies the round trip before posting; this
 * route's job is to refuse anything that is not an envelope, so a broken re-encryption cannot overwrite a
 * good file with rubbish.
 */
async function reencryptFile({ db, request, response, practitioner, practiceId, params, maxUploadBytes }) {
  if (!requireSignIn({ practitioner, response })) return;

  const type = String(request.headers['content-type'] ?? '');
  if (!type.startsWith('application/octet-stream')) {
    return fail(response, 415, "This route takes the new envelope as raw bytes, which needs the page's own script.");
  }

  const body = await readBody(request, maxUploadBytes);
  if (body.length === 0) return fail(response, 400, 'That upload was empty. Nothing was replaced.');

  const envelope = readEnvelope(body);
  if (!envelope.ok) {
    return fail(
      response,
      400,
      `Only an encrypted file can replace an encrypted file, and that one is not one (${envelope.reason}). Nothing was replaced.`,
    );
  }

  const keyId = String(request.headers['x-key-id'] ?? '');
  if (!keyId) return fail(response, 400, 'The new key has to be named, or there is no record of what opens the file now.');

  const existing = db
    .prepare(
      `SELECT u.id, u.storage_path FROM upload u
         JOIN request_item i ON i.id = u.request_item_id
         JOIN request r ON r.id = i.request_id
        WHERE u.id = ? AND r.practice_id = ?`,
    )
    .get(params[0], practiceId);
  if (!existing) return fail(response, 404, 'There is no file with that id.', practitioner);

  // Written under a name of its own, so the file the row currently points at is untouched until the row
  // moves. See the note on `replaceUpload` for why that order is the one that cannot lose a document.
  const storagePath = join(dirname(existing.storage_path), `${newId()}.bin`);
  await writeFile(storagePath, body);

  const replaced = replaceUpload(db, practiceId, {
    uploadId: existing.id,
    keyId,
    storagePath,
    sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  });

  if (!replaced.ok) {
    // The new bytes are referenced by nothing, so they go rather than becoming an orphan. A failure to
    // remove them is not worth reporting: the document is intact either way.
    await unlink(storagePath).catch(() => {});
    const why = {
      'not-found': 'There is no file with that id.',
      'no-such-key': "That key is not one of this practice's, or it has been retired.",
      already: 'That file is already sealed to that key, so there was nothing to do.',
    }[replaced.why] ?? 'That file could not be re-encrypted.';
    return fail(response, 400, why, practitioner);
  }

  // The old bytes go last: the row has moved, so nothing reads them now. A failure here leaves an orphan,
  // which is untidy and harmless — removing them before the row moved would not be.
  await unlink(replaced.previousPath).catch(() => {});

  return sendJson(response, 200, { ok: true, id: existing.id, filename: replaced.filename, keyId });
}

/**
 * Retire a key: its wrapped copies are destroyed and the row stays as a record.
 *
 * The page asks for a typed word rather than offering a button, because the consequence is not obvious and
 * is not reversible: a retired key cannot open the files it once opened, **including any copy of those
 * files the practice has kept elsewhere**. A backup of the data directory taken before the pass is a set of
 * envelopes nothing can open afterwards. That sentence belongs on the page, and the typing is what makes a
 * person read it.
 */
async function retireKey({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;

  const fields = formFields(await readBody(request));
  if (field(fields, 'confirm') !== 'retire') {
    return fail(
      response,
      400,
      'That key was not retired. The word has to be typed, because retiring it cannot be undone.',
      practitioner,
    );
  }

  const result = retirePracticeKey(db, practiceId, params[0]);
  if (!result.ok) {
    const why = {
      'not-found': 'There is no such key in this practice.',
      current: 'That is the current key — new files are sealed to it, so it cannot be retired.',
      already: 'That key has already been retired.',
      'holds-files': `That key still opens ${result.held} ${result.held === 1 ? 'file' : 'files'}. Move ${
        result.held === 1 ? 'it' : 'them'
      } to a newer key first, or the file cannot be read again.`,
    }[result.why] ?? 'That key could not be retired.';
    return fail(response, 400, why, practitioner);
  }

  return redirect(response, `/keys?retired=${encodeURIComponent(params[0])}`);
}

/**
 * The no-JavaScript answer to the move button.
 *
 * Re-sealing a stored document needs the private key, and the private key only ever exists in the browser.
 * There is no server-side version of this to fall back to, so a browser without the script gets a sentence
 * saying that rather than a 404 — or, worse, a button that looks like it worked.
 */
function moveWithoutScript({ response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  return fail(
    response,
    415,
    "Moving files needs the page's own script, because the key never leaves the browser. Nothing was changed.",
    practitioner,
  );
}

async function closeRequestPage({ db, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const closed = closeRequest(db, practiceId, params[0]);
  if (!closed) return fail(response, 404, 'There is no open request at that address.', practitioner);
  return redirect(response, `/requests/${params[0]}`);
}

async function reopenRequestPage({ db, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const reopened = reopenRequest(db, practiceId, params[0]);
  if (!reopened) return fail(response, 404, 'There is no closed request at that address.', practitioner);
  return redirect(response, `/requests/${params[0]}`);
}

/**
 * Add documents to a request that is already out with a client.
 *
 * A practice only knows the whole list once it starts looking, and a list fixed at creation is a list
 * they work around by sending a second email — which defeats the point of the request being the thing
 * that answers "did we get it?".
 *
 * A closed request is refused rather than quietly accepting. Reopening is a deliberate act and it
 * should stay one.
 */
async function addItemsPage({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (found.closed_at) {
    return fail(response, 400, `"${found.title}" is closed. Reopen it before adding to it.`, practitioner);
  }

  const fields = formFields(await readBody(request));
  const labels = parseItems(typeof fields.items === 'string' ? fields.items : '');
  if (labels.length === 0) {
    return fail(response, 400, 'There was nothing to add — give one document per line.', practitioner);
  }

  const added = addItems(db, { requestId: found.id, labels });
  if (added.length === 0) {
    // Said rather than silently ignored: a practice that adds something and sees no change would
    // reasonably conclude the button is broken.
    return fail(response, 400, 'Everything on that list is already on this request.', practitioner);
  }
  return redirect(response, `/requests/${found.id}`);
}

/**
 * The four things a practice can say about a single document.
 *
 * A table rather than a chain of `if`s, so that the set of things a practice can say is one place a
 * reader can check — and so that an unknown action is a refusal rather than a silent no-op.
 */
const ITEM_ACTIONS = {
  withdraw: ({ db, practiceId, requestId, itemId }) =>
    setItemWithdrawn(db, practiceId, requestId, itemId, true),
  restore: ({ db, practiceId, requestId, itemId }) =>
    setItemWithdrawn(db, practiceId, requestId, itemId, false),
  attention: ({ db, practiceId, requestId, itemId, note }) =>
    setItemAttention(db, practiceId, requestId, itemId, { note }),
  'clear-attention': ({ db, practiceId, requestId, itemId }) =>
    clearItemAttention(db, practiceId, requestId, itemId),
  // The practice saying "I have looked at this", and taking it back. Both are recorded, because the
  // second is how a mistake gets corrected and the history should show that it was.
  check: ({ db, practiceId, requestId, itemId }) =>
    setItemReviewed(db, practiceId, requestId, itemId, true),
  uncheck: ({ db, practiceId, requestId, itemId }) =>
    setItemReviewed(db, practiceId, requestId, itemId, false),
};

async function changeItemPage({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const [requestId, itemId, action] = params;

  const found = requestFor(db, practiceId, requestId);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const change = Object.hasOwn(ITEM_ACTIONS, action) ? ITEM_ACTIONS[action] : null;
  if (!change) {
    return fail(response, 400, `"${action}" is not something that can be said about a document.`, practitioner);
  }

  const fields = formFields(await readBody(request));
  const changed = change({ db, practiceId, requestId, itemId, note: field(fields, 'attention_note') });
  if (!changed) {
    return fail(
      response,
      404,
      'That document is not part of this request, or it is already in that state.',
      practitioner,
    );
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
  // Withdrawn items are not asked for. They stay visible to the practice — the request page shows them
  // — but a client asked again for something the practice has stopped wanting is a client who stops
  // trusting the list.
  const items = itemsOf(db, open.id).filter((item) => !item.withdrawn);

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
    <td>${item.needsAttention
      ? html`<strong>please send this again</strong>${item.attentionNote ? html`<br><span class="note">${item.attentionNote}</span>` : ''}`
      : item.received
        ? html`<strong>received</strong>`
        : item.clientSays
          ? html`<strong>you said:</strong> <span class="note">${item.clientSays}</span>`
          : 'still needed'}</td>
    <td>
      <form class="upload" method="post" action="/r/${params[0]}/items/${item.id}">
        <input type="file" name="file" required>
        <input type="text" name="note" placeholder="anything we should know? (optional)" maxlength="500">
        <button type="submit">Send</button>
        <div class="status note"></div>
      </form>
      ${item.received
        ? ''
        : html`<form method="post" action="/r/${params[0]}/items/${item.id}/says" class="inline">
            ${Object.entries(CLIENT_SAYS).map(([value, words]) => html`
              <button type="submit" name="says" value="${value}">${words}</button> `)}
          </form>`}
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
      <p class="note">If you cannot send one of these, say so with the buttons beside it — the practice
      would rather know than keep asking. Neither button takes it off the list; that is their call.</p>
      ${items.length === 0
        ? html`<p>Nothing is being asked of you at the moment. Add the practice's address to your
            contacts, in case they ask for something later.</p>`
        : ''}
      <p class="note">Nothing here needs an account. Come back to this page with the same
      link to send the rest — the list shows what has already arrived.</p>
      ${jsonTag('practice-key', { keyId: open.practice_key_id, publicKey: JSON.parse(open.practice_public_key) })}
      ${raw('<script type="module" src="/assets/upload.js"></script>')}`,
  }));
}

/**
 * The client saying something other than sending a file.
 *
 * Two sentences, both of which a practice would rather have than silence: "I do not have this" and "I
 * will send this later". The item stays on the list either way — whether to stop asking is the
 * practice's decision — and the client can take it back by saying nothing again.
 */
async function clientSays({ db, request, response, params }) {
  const [token, itemId] = params;
  const found = tokenLookup(db, token);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const item = itemInRequest(db, found.request.id, itemId);
  if (!item) return fail(response, 404, 'That document is not part of this request.');

  const fields = formFields(await readBody(request));
  const asked = field(fields, 'says');
  if (!Object.hasOwn(CLIENT_SAYS, asked)) {
    return fail(response, 400, 'That is not one of the answers this page offers. Nothing was changed.');
  }

  // A client can clear their own answer by choosing the same one again — otherwise the sentence would be
  // stuck on the practice's list with no way to withdraw it from the side that said it.
  const same = item.client_says === CLIENT_SAYS[asked];
  setClientSays(db, found.request.practice_id, found.request.id, itemId, same ? null : CLIENT_SAYS[asked]);
  return redirect(response, `/r/${token}`);
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
  if (item.withdrawn_at) {
    // A client may be holding a page from before the practice stopped asking. Saying so is better than
    // storing a file that nothing is waiting for, or than a "not found" that reads like their mistake.
    return fail(response, 409, 'The practice is no longer asking for that one. Refresh the page to see the current list.');
  }

  const type = String(request.headers['content-type'] ?? '');
  if (!type.startsWith('application/octet-stream')) {
    return fail(response, 415, 'This page sends files as raw bytes, which needs JavaScript to be enabled.');
  }

  // Before anything is read or written: the header helper, because the key check below needs it and a
  // rejected upload should leave nothing behind.
  const header = (name, fallback, limit) =>
    request.headers[name] ? decodeURIComponent(String(request.headers[name])).slice(0, limit) : fallback;

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

  // Which key the client sealed this to. The browser says, because the bytes cannot: an envelope's
  // header carries the *ephemeral* key it was made with, not the recipient it was made for. The claim
  // is checked before it is recorded, and a wrong one is refused rather than stored as unknown — this
  // column is what decides whether a key can ever be discarded, so a false answer is worse than none.
  const claimedKey = header('x-key-id', null, 64);
  let keyId = null;
  if (claimedKey !== null) {
    const key = db
      .prepare(
        `SELECT k.id FROM practice_key k JOIN request r ON r.practice_id = k.practice_id
          WHERE k.id = ? AND r.id = ?`,
      )
      .get(claimedKey, found.request.id);
    if (!key) {
      return fail(response, 400, 'That upload named a key this practice does not have. Nothing was stored.');
    }
    keyId = key.id;
  }

  const uploadId = newId();
  const directory = join(blobDir, found.request.id);
  await mkdir(directory, { recursive: true });
  const storagePath = join(directory, `${uploadId}.bin`);
  await writeFile(storagePath, body);

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
    keyId,
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
  const existing = practiceKeys(db, practiceId, practitioner.id);
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

async function saveKeys({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;

  const fields = formFields(await readBody(request));
  const publicKeyJson = field(fields, 'public_key');
  const wrapped = field(fields, 'wrapped_private_key');
  const problem = keyProblem(publicKeyJson, wrapped);
  if (problem) return fail(response, 400, problem, practitioner);

  addPracticeKey(db, practiceId, {
    publicKey: JSON.parse(publicKeyJson),
    wrappedPrivateKey: wrapped,
    createdBy: practitioner.id,
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
/**
 * Who is in this practice, how to ask someone to join, and what has been asked already.
 *
 * The form is JavaScript-driven because the sealing happens in the browser: the passphrase is typed
 * here, the key is unwrapped here, and the server receives a blob it cannot open. That is the same shape
 * as every other key operation in this product, and it is why the invitation is created by a fetch that
 * returns a token rather than by a form post that returns a page — the secret has to stay in the page
 * that generated it, and a navigation would throw it away.
 */
function membersPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;

  const members = membersOf(db, practiceId);
  const removed = removedMembersOf(db, practiceId);
  const invites = invitesOf(db, practiceId);
  const keys = practiceKeys(db, practiceId, practitioner.id);
  const newest = keys[0] ?? null;
  const mine = newest?.wrappedPrivateKey ?? null;
  const holders = newest ? new Set(wrappingHoldersOf(db, newest.id)) : new Set();
  const practice = practiceFor(db, practiceId);
  const justRemoved = url.searchParams.get('removed');

  return sendPage(response, 200, page({
    title: 'Members',
    practitioner,
    banner: justRemoved
      ? html`<p class="warning"><strong>${justRemoved} was removed.</strong> Their key copies are gone and
          their sessions have ended, so they cannot sign in again. Anything they already downloaded is
          still theirs — removal changes what happens next, not what has already happened.</p>`
      : null,
    body: html`
      <h1>${practice.name}</h1>
      <p class="note">${members.length === 1 ? 'One person' : `${members.length} people`} in this practice.
        The name is yours to change — it is the first thing a new member sees.</p>
      <form method="post" action="/members/name" class="inline">
        <input name="name" value="${practice.name}" maxlength="${MAX_PRACTICE_NAME}"
          aria-label="Practice name" required>
        <button type="submit">Rename</button>
      </form>
      <table>
        <thead><tr><th>Email</th><th>Joined</th><th>Can open the newest files?</th><th></th></tr></thead>
        <tbody>
          ${members.map((person) => html`<tr>
            <td>${person.email}${person.id === practitioner.id ? html` <span class="note">(you)</span>` : ''}</td>
            <td>${person.created_at.slice(0, 10)}</td>
            <td>${newest
              ? holders.has(person.id)
                ? html`yes`
                : html`<span class="warning">no — they hold no copy of the newest key</span>`
              : html`<span class="note">this practice has no key yet</span>`}</td>
            <td>${person.id === practitioner.id
              ? html`<span class="note">you cannot remove yourself</span>`
              : html`<a href="/members/${person.id}/remove">Remove</a>`}</td>
          </tr>`)}
        </tbody>
      </table>
      <p class="note">Removing somebody ends their access from then on. It does not take back a key they
        already have, and it does not change anything they have already downloaded — the page that asks
        says so in full before it does anything.</p>

      ${removed.length === 0
        ? ''
        : html`<h2>Removed</h2>
            <p class="note">No longer members. Their names stay in the records, because the requests they
              made and the files they uploaded say who did what. Someone still here can invite them back.</p>
            <table>
              <thead><tr><th>Email</th><th>Joined</th><th>Removed</th></tr></thead>
              <tbody>
                ${removed.map((person) => html`<tr>
                  <td>${person.email}</td>
                  <td>${person.created_at.slice(0, 10)}</td>
                  <td>${person.removed_at.slice(0, 10)}</td>
                </tr>`)}
              </tbody>
            </table>`}

      ${!newest
        ? html`<p class="note">This practice has no key, so there is nothing to invite anyone to.
            <a href="/setup">Make one first</a>.</p>`
        : !mine
          ? html`<p class="warning">You hold no copy of this practice's newest key, so you cannot invite
              anyone — an invitation carries a copy of <em>your</em> key, and handing over something you
              cannot read would be a strange thing to do. Someone who does hold a copy can invite you.</p>`
          : html`
            <h2>Invite someone</h2>
            <p class="warning"><strong>Whoever opens the link gets the key.</strong> It is not addressed to
              a particular person, it works once, and it stops working after ${INVITE_DAYS} days. Send it
              the way you would send a password, not the way you would send a link.</p>
            <form id="invite-form">
              <label for="passphrase">Your passphrase <span class="note">used in this browser, sent nowhere</span></label>
              <input id="passphrase" name="passphrase" type="password" autocomplete="current-password">
              <button type="submit">Create an invitation</button>
            </form>
            <p class="status" id="invite-status"></p>
            <p id="invite-link" hidden></p>
            <script type="application/json" id="invite-key">${raw(JSON.stringify({ keyId: newest.id, wrapped: mine }))}</script>
            ${raw('<script type="module" src="/assets/members.js"></script>')}`}

      ${invites.length > 0
        ? html`<h2>Invitations</h2>
            <table>
              <thead><tr><th>Sent by</th><th>When</th><th>Outcome</th></tr></thead>
              <tbody>
                ${invites.map((row) => html`<tr>
                  <td>${row.created_by_email}</td>
                  <td>${row.created_at.slice(0, 10)}</td>
                  <td>${row.used_at
                    ? html`accepted by ${row.used_by_email} on ${row.used_at.slice(0, 10)}`
                    : row.expires_at <= new Date().toISOString()
                      ? html`<span class="note">expired, and was never accepted</span>`
                      : html`<span class="note">not accepted yet</span>`}</td>
                </tr>`)}
              </tbody>
            </table>`
        : ''}
      <p><a href="/keys">Keys</a></p>`,
  }));
}

/**
 * Create an invitation, from a blob the browser sealed.
 *
 * Two checks, and the second is the one that matters: the key must belong to this practice **and this
 * member must hold a copy of it**. Without that, a member who holds no copy could mint an invitation
 * carrying something they cannot read — and the blob itself is whatever was posted, so it has to be
 * tied to a key the practice actually has.
 */
async function createInvitePage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));

  const keyId = field(fields, 'key_id');
  const sealedKey = field(fields, 'sealed_key');

  if (!/^invite\$sha-256\$/.test(sealedKey ?? '')) {
    return sendJson(response, 400, { error: 'that is not a sealed invitation' });
  }

  const held = practiceKeys(db, practiceId, practitioner.id).some(
    (key) => key.id === keyId && key.wrappedPrivateKey !== null,
  );
  if (!held) {
    return sendJson(response, 400, { error: 'that is not a key you hold a copy of' });
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  createInvite(db, {
    practiceId,
    createdBy: practitioner.id,
    keyId,
    sealedKey,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return sendJson(response, 201, { token, expiresAt, days: INVITE_DAYS });
}

/**
 * The page someone lands on from an invitation link.
 *
 * The secret is in the fragment, which the server never receives — so this page cannot know whether the
 * link is valid in the way that matters. It can know whether the *token* is live, and it hands the
 * browser the sealed blob to try. If the fragment is missing or wrong, the browser finds out when the
 * blob refuses to open, which is the only place that can find out.
 */
async function invitePage({ db, response, params, error = null }) {
  const found = inviteByToken(db, params[0]);

  if (found.state !== 'open') {
    const said = {
      unknown: 'There is no invitation at that address.',
      used: 'That invitation has been used. An invitation works once — ask for another one.',
      expired: 'That invitation has expired. Ask whoever sent it for a new one.',
    }[found.state];
    return sendPage(response, found.state === 'unknown' ? 404 : 410, page({
      title: 'That invitation',
      body: html`<h1>That invitation</h1><p>${said}</p>
        <p class="note">Nothing was created, and no key was handed over.</p>`,
    }));
  }

  return sendPage(response, 200, page({
    title: `Join ${found.invite.practice_name}`,
    body: html`
      <h1>Join ${found.invite.practice_name}</h1>
      <p>You have been invited to a practice on this Tickmark. You will get your own login and your own
        passphrase, and you will be able to open the documents clients have already sent.</p>
      ${error ? html`<p class="error">${error}</p>` : ''}
      <form method="post" action="/invite/${params[0]}" id="accept-form">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="username">
        <label for="password">Password <span class="note">for signing in</span></label>
        <input id="password" name="password" type="password" required minlength="${MIN_PASSWORD}"
          autocomplete="new-password">
        <label for="passphrase">Passphrase <span class="note">protects the key; it is not stored anywhere</span></label>
        <input id="passphrase" name="passphrase" type="password" autocomplete="new-password">
        <label for="again">Passphrase again</label>
        <input id="again" name="again" type="password" autocomplete="new-password">
        <input type="hidden" name="wrapped_private_key" id="wrapped_private_key">
        <button type="submit">Join</button>
      </form>
      <p class="status" id="accept-status"></p>
      <p class="note">Your browser opens the invitation with a secret that came in the link itself. That
        secret is never sent to the server, which is why this page needs JavaScript.</p>
      <script type="application/json" id="invite-blob">${raw(JSON.stringify({ sealed: found.invite.sealed_key }))}</script>
      ${raw('<script type="module" src="/assets/invite.js"></script>')}`,
  }));
}

/**
 * Accept an invitation: a person, a password, and a sealed copy of the practice's key.
 *
 * The passphrase is never sent — the browser used it to seal the copy and does not post it. So this
 * handler cannot check that the record it is given is any good: it can only check that it *looks* like a
 * record, which is the same position the server is in when a key is first made, and for the same reason.
 */
async function acceptInvite({ db, request, response, params }) {
  const found = inviteByToken(db, params[0]);
  if (found.state !== 'open') return invitePage({ db, response, params });

  const fields = formFields(await readBody(request));
  const email = field(fields, 'email')?.toLowerCase() ?? null;
  const password = typeof fields.password === 'string' ? fields.password : '';
  const wrapped = field(fields, 'wrapped_private_key');

  const refuse = (problem) => invitePage({ db, response, params, error: problem });

  if (field(fields, 'passphrase') || field(fields, 'again')) {
    // A filled passphrase field means the browser did not run: the form posts those fields only because
    // they exist, and the script clears them before submitting. Saying so is better than creating a
    // member whose key copy is empty.
    return refuse('That did not arrive the way it should have. This page needs JavaScript, because the key is sealed in your browser.');
  }

  const problem = validateCredentials(email, password);
  if (problem) return refuse(problem);

  if (!/^pbkdf2\$sha-256\$/.test(wrapped ?? '')) {
    return refuse('That did not arrive with a sealed copy of the key. If this page is open in an old tab, reload it from the link.');
  }

  // An existing account is refused the invitation — unless it is a **removed member of this same
  // practice**, in which case the invitation is their way back in. The email column is `UNIQUE`, so
  // without this path somebody who left could never be invited again at all, and `claimInvite` restores
  // their existing row rather than inserting a second one.
  const existing = practitionerByEmail(db, email);
  const comingBack = existing && existing.removed_at !== null && existing.practice_id === found.invite.practice_id;
  if (existing && !comingBack) {
    return refuse('There is already an account for that email address. Sign in instead — an invitation is not needed to join a practice you are already in.');
  }

  const passwordHash = await hashPassword(password);
  const claimed = claimInvite(db, {
    token: params[0],
    email,
    passwordHash,
    wrappedPrivateKey: wrapped,
  });

  if (claimed.state === 'email-taken') {
    return refuse('There is already an account for that email address. Sign in instead — an invitation is not needed to join a practice you are already in.');
  }
  if (claimed.state !== 'joined' && claimed.state !== 'rejoined') return invitePage({ db, response, params });

  const { token } = createSession(db, claimed.practitionerId);
  return redirect(response, '/requests', [sessionCookie(token)]);
}

/**
 * Rename the practice.
 *
 * Anyone in the practice may do this, and that is deliberate rather than lazy: there are no roles yet
 * (`docs/members.md` says so), and inventing a hidden owner-only rule here would be a permission system
 * with one rule in it and no way to see the rest. When roles exist, this becomes one of the things a
 * role decides — and until then the members page does not pretend otherwise.
 */
/**
 * Removing a member: the page that asks, and the act.
 *
 * Two steps rather than a button in a table row, because this is the only destructive thing in the
 * product that can be aimed at a person, and the page has more to say than a row can hold. Three things
 * it says, and the third is the reason `docs/members.md` left this unbuilt for two passes:
 *
 * 1. **What it does.** Their copies of the practice's keys are destroyed and their sessions end.
 * 2. **What it does not do.** If they had the key — and they did, or they could not have worked there —
 *    then any copy of it they kept still opens under their passphrase, and any document they downloaded
 *    is theirs. **Removal is a statement about the future.** A button that looked like revocation of the
 *    past would be a lie the software told on the firm's behalf.
 * 3. **The one thing that is easy to miss**: if they are the last person holding a copy of the newest
 *    key, removing them leaves nobody able to open the files encrypted to it. It is allowed — removal
 *    needs no key — but it is stated before the act rather than discovered afterwards.
 *
 * Anyone in the practice may remove anyone else, for the same reason anyone may rename it: there are no
 * roles, and inventing a hidden owner-only rule here would be a permission system with one rule in it.
 * You cannot remove yourself: the act is for somebody who has left, and the person who has left is the
 * one nobody can act for.
 *
 * **Two rules overlap here, and the second is consequently unreachable from a browser.** Removing the last
 * member is refused by the store, and removing yourself is refused by this handler — but the last member
 * is always the person asking, so the self-removal rule always fires first, and the store's "last member"
 * sentence can never appear on a page. It is kept anyway: it is the invariant that no practice ends up
 * with nobody in it, and anything else calling the store gets it. `test/removal.test.js` says where each
 * one is exercised, and says that the UI cannot reach the second.
 */
function removeMemberPage({ db, response, practitioner, practiceId, params, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const member = memberIn(db, practiceId, params[0]);
  if (!member || member.removed_at !== null) {
    return fail(response, 404, 'There is nobody in this practice at that address.', practitioner);
  }

  const newest = practiceKeys(db, practiceId, practitioner.id)[0] ?? null;
  const holders = newest ? wrappingHoldersOf(db, newest.id) : [];
  const others = holders.filter((id) => id !== member.id);
  const copies = db
    .prepare('SELECT COUNT(*) AS n FROM key_wrapping WHERE practitioner_id = ?')
    .get(member.id).n;
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM session WHERE practitioner_id = ?').get(member.id).n;

  const lastHolder = holders.includes(member.id) && others.length === 0;

  return sendPage(response, 200, page({
    title: `Remove ${member.email}`,
    practitioner,
    body: html`
      <h1>Remove ${member.email}?</h1>
      <p>They joined on ${member.created_at.slice(0, 10)}. Removing them
        ${copies === 0
          ? html`destroys no key copies, because they hold none`
          : html`destroys their ${copies} ${copies === 1 ? 'copy' : 'copies'} of this practice's keys`}
        and ends their ${sessions} ${sessions === 1 ? 'session' : 'sessions'}, so they cannot sign in
        again and cannot open anything sent from now on.</p>

      ${lastHolder
        ? html`<p class="warning"><strong>They are the last person who can open the files encrypted to the
            newest key.</strong> Remove them and nobody — including you — will be able to open those files
            until somebody who does hold a copy invites someone. You can still do it; this is here so it is
            not a surprise afterwards.</p>`
        : ''}

      <p class="warning"><strong>This does not take back what they already have.</strong> If they kept a
        copy of a key, it still opens under their passphrase. Any document they downloaded is theirs and
        stays theirs. Nothing can undo that — it is the same fact as the one on the keys page about
        rotation, seen from the other side.</p>

      <p>Their name stays in the records — the requests they made, the files they uploaded, the keys they
        added. An invitation is how they would come back, and it would restore this same record rather
        than make a new one.</p>

      <form method="post" action="/members/${member.id}/remove">
        <button type="submit">Remove ${member.email}</button>
      </form>
      <p><a href="/members">Cancel</a></p>`,
  }));
}

function removeMemberAction({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;

  // Yourself is a request about your own membership rather than about somebody who has left. Refusing
  // keeps the act's meaning intact, and the members page says why.
  if (params[0] === practitioner.id) {
    return fail(response, 400, 'You cannot remove yourself. Removal is for somebody who has left the practice; signing out ends your own session.', practitioner);
  }

  const result = removeMember(db, practiceId, params[0]);
  if (result.state === 'not-found' || result.state === 'already-removed') {
    return fail(response, 404, 'There is nobody in this practice at that address.', practitioner);
  }
  if (result.state === 'last-member') {
    return fail(response, 400, 'That is the only person in this practice. A practice with nobody in it could never be signed in to again, so this is refused.', practitioner);
  }

  return redirect(response, `/members?removed=${encodeURIComponent(result.email)}`);
}

async function renamePracticePage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const name = (field(fields, 'name') ?? '').trim();

  if (name.length === 0) {
    return fail(response, 400, 'A practice needs a name. It can be anything — it is only shown to you and to the people you invite.', practitioner);
  }
  if (name.length > MAX_PRACTICE_NAME) {
    return fail(response, 400, `That name is longer than ${MAX_PRACTICE_NAME} characters, which is more than a heading can hold.`, practitioner);
  }

  renamePractice(db, practiceId, name);
  return redirect(response, '/members');
}

function keysPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const every = allPracticeKeys(db, practiceId, practitioner.id);
  const live = every.filter((key) => key.deletedAt === null);
  const retired = every.filter((key) => key.deletedAt !== null);
  const counts = filesPerKey(db, practiceId);
  const unaccounted = counts.get(null) ?? 0;
  const current = live[0] ?? null;
  const justRetired = url.searchParams.get('retired');

  /**
   * A key that has been retired is history, not a control.
   *
   * Its wrapped copies are gone, so there is no passphrase form, nothing to move and nothing to do — and
   * showing a control that cannot work is the same mistake as a Send button with no mail server. What it
   * keeps is the date it was made and the date it stopped opening anything, which is the record deleting
   * the row would have thrown away.
   */
  const retiredRows = retired.map((key) => html`<tr>
    <td>${key.createdAt.slice(0, 19).replace('T', ' ')}</td>
    <td>retired ${(key.deletedAt ?? '').slice(0, 10)} — its copies were destroyed, so it opens nothing</td>
  </tr>`);

  const rows = live.map((key) => {
    const holds = counts.get(key.id) ?? 0;
    return html`<tr>
      <td>${key.createdAt.slice(0, 19).replace('T', ' ')}</td>
      <td>${key === current
        ? html`<strong>current</strong> — new files are encrypted to this one`
        : 'older — opens the files sent while it was current'}</td>
      <td>${holds}</td>
      <td>
        <form class="passphrase" data-key-id="${key.id}" method="post" action="/keys/${key.id}/passphrase">
          <input type="password" name="old" placeholder="current passphrase" required autocomplete="current-password">
          <input type="password" name="fresh" placeholder="new passphrase" required autocomplete="new-password">
          <input type="password" name="again" placeholder="the new one again" required autocomplete="new-password">
          <button type="submit">Change the passphrase</button>
          <span class="status note"></span>
        </form>
        ${key === current || holds === 0
          ? ''
          : html`<form class="reencrypt" data-key-id="${key.id}" method="post" action="/keys/${key.id}/move">
              <input type="password" name="passphrase" placeholder="this key's passphrase" required autocomplete="current-password">
              <input type="password" name="current_passphrase" placeholder="the current key's passphrase, if it differs" autocomplete="current-password">
              <button type="submit">Move ${holds} ${holds === 1 ? 'file' : 'files'} to the current key</button>
              <span class="status note"></span>
              <progress value="0" max="${holds}"></progress>
            </form>`}
        ${key === current || holds > 0
          ? ''
          : html`<form method="post" action="/keys/${key.id}/retire">
              <input type="text" name="confirm" placeholder="type: retire" required autocomplete="off">
              <button type="submit">Retire this key</button>
            </form>`}
      </td>
    </tr>`;
  });

  return sendPage(response, 200, page({
    title: 'Keys',
    practitioner,
    banner: live.length === 0
      ? html`<p class="warning">This practice has no key yet, so it cannot be sent files.
          <a href="/setup">Make one</a>.</p>`
      : justRetired
        ? html`<p class="success"><strong>Retired.</strong> Its wrapped copies have been destroyed, so it
            cannot open anything. The record of it stays below — and any copy of a file sealed to it that
            you kept or backed up cannot be opened any more.</p>`
        : null,
    body: html`
      <h1>Keys</h1>
      ${live.length === 0
        ? ''
        : html`<table>
            <thead><tr><th align="left">Made</th><th align="left">What it is for</th><th align="left">Files</th><th align="left">Passphrase</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
      ${unaccounted > 0
        ? html`<p class="note">${unaccounted} file${unaccounted === 1 ? '' : 's'} arrived before Tickmark
            recorded which key was used, so which key opens ${unaccounted === 1 ? 'it' : 'them'} is not written
            down anywhere. Nothing is lost — the key that opens a file is whichever one decrypts it — but it
            means those files are not counted in the column above, and <strong>moving files to a new key
            cannot touch them</strong>, because the pass works from that count.</p>`
        : ''}
      <p class="note"><strong>Moving files to a new key is what makes an old key retirable.</strong> This
      browser fetches each file, opens it with the old key's passphrase, seals it to the current key, and
      checks the round trip before anything is replaced — the server only ever handles bytes it cannot read.
      If you close this page halfway through, nothing is lost: a file that has been moved is no longer sealed
      to the old key, so the count above <em>is</em> the progress, and pressing the button again carries on
      from where it stopped.</p>
      <p class="note"><strong>Retiring a key cannot be undone, and it reaches further than this server.</strong>
      It destroys the practice's copies, so the files here are fine once they have been moved — but
      <em>any copy of a file still on the old key that you have kept or backed up</em> becomes unopenable,
      because the key that opened it will not exist. Move everything first, then retire.</p>
      <p><a href="/setup">Make a new key</a> — for files that arrive from now on. The ones you have
      keep working.</p>
      <p class="note">Changing a passphrase does not change the key, so nothing has to be
      re-encrypted and no file becomes unopenable. Store the new one somewhere that is not this
      server: a copy of a key without its passphrase is a file nobody can open.</p>
      ${retired.length > 0
        ? html`<h2>Retired keys</h2>
            <table><thead><tr><th align="left">Made</th><th align="left">What became of it</th></tr></thead>
            <tbody>${retiredRows}</tbody></table>
            <p class="note">Kept as a record rather than deleted: a key that vanished would take with it the
            only evidence of what it opened.</p>`
        : ''}
      ${live.length > 0
        ? jsonTag('key-records', {
            currentKeyId: current?.id ?? null,
            currentPublicKey: current?.publicKey ?? null,
            keys: live.map((key) => ({ id: key.id, wrapped: key.wrappedPrivateKey, publicKey: key.publicKey })),
          })
        : ''}
      ${live.length > 0 ? raw('<script type="module" src="/assets/keys.js"></script>') : ''}
      ${live.length > 1 && (counts.get(live[1].id) ?? 0) > 0
        ? raw('<script type="module" src="/assets/reencrypt.js"></script>')
        : ''}`,
  }));
}

/**
 * Accept a key re-wrapped under a new passphrase.
 *
 * The server cannot check the old passphrase, because checking it would mean being able to open the
 * record — which is the thing it must not be able to do. What it does check is that the new record
 * is one it would have written: the right shape, and a KDF cost inside what this version accepts.
 */
async function changePassphrase({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const wrapped = field(fields, 'wrapped_private_key');

  const problem = wrappedKeyProblem(wrapped);
  if (problem) return fail(response, 400, problem, practitioner);

  const changed = replaceWrappedKey(db, practiceId, practitioner.id, params[0], wrapped);
  if (!changed) return fail(response, 404, 'There is no key of yours with that id.', practitioner);
  return redirect(response, '/keys');
}
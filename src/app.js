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
import {
  CHALLENGE_COOKIE,
  MIN_PASSWORD,
  challengeCookie,
  challengeFor,
  clearChallengeCookie,
  clearSessionCookie,
  clearTwoFactor,
  confirmTwoFactor,
  createSession,
  endChallenge,
  endSession,
  parseCookies,
  practitionerFor,
  recordAcceptedStep,
  sessionCookie,
  setPendingSecret,
  spendRecoveryCode,
  startChallenge,
  twoFactorState,
  unusedRecoveryCodes,
} from './auth.js';
import {
  codeStepFor,
  generateRecoveryCodes,
  generateSecret,
  inGroups,
  otpauthUri,
} from './totp.js';
import { RequestError, field, formFields, readBody } from './http.js';
import { TONES, badge, empty, html, page, raw, redirect, section, sendCsv, sendPage, tile } from './views.js';

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
import { VERSION } from './version.js';
import { MailError, sendMail } from './mailer.js';
import { COMMON_ZONES, dateIn, knownZone, monthIn, todayIn } from './clock.js';
import { createAttemptLimiter } from './ratelimit.js';
import { ROLE_BLURBS, ROLE_WORDS, ROLES, holdsKey, refusalFor, roleMeets, roleName } from './roles.js';
import {
  addItems,
  addPracticeKey,
  addTemplateItems,
  clearItemAttention,
  clientFor,
  clientSummaries,
  clientsForBulkSend,
  clientsDueForAsking,
  closeRequest,
  closedCount,
  createPractitioner,
  createPractice,
  createTemplate,
  deleteTemplate,
  removeTemplateItem,
  renameTemplate,
  templateFor,
  templateItemsOf,
  templatesOf,
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
  logContact,
  markArrivalsChecked,
  membersOf,
  outstandingOf,
  lastNoticeAt,
  practiceFor,
  previousChecklistFor,
  renamePractice,
  recordClientMessage,
  setPracticeContact,
  requestOwner,
  requestsForClient,
  setPracticeNotify,
  ownersOf,
  setPracticeTimezone,
  MAX_CLIENT_MESSAGE,
  setRole,
  updateClient,
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
  setItemLabel,
  setItemWithdrawn,
  tokenLookup,
  tokensFor,
  updateRequest,
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
 * "Ready to work on" is the word the research uses and the word a practice would use. The others describe **whose
 * turn it is**, because that is the question the list exists to answer — and each of the three is a different
 * job: "files to check" is material nobody has opened, "waiting on the client" is nothing to do but wait, and
 * "the client answered" is a decision somebody owes them.
 */
const REQUEST_STATE_WORDS = {
  ready: 'ready to work on',
  'to-check': 'files to check',
  // Parallel to "waiting on the client", because the two are the same sentence from opposite sides: this one
  // means the client has replied and the practice owes them an answer.
  answered: 'the client answered',
  waiting: 'waiting on the client',
};

/**
 * Which of the three colours a request state is.
 *
 * One function rather than the same ternary in four places, which is what it was until `answered` arrived and had
 * to be added to each of them — a state that renders in the wrong colour in one place is worse than a state that
 * is missing, because it looks like it has been considered.
 */
const stateTone = (state) => (state === 'ready'
  ? TONES.done
  : state === 'to-check' || state === 'answered'
    ? TONES.todo
    : TONES.waiting);

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

/**
 * What one client link may store, in total.
 *
 * The per-file ceiling above bounds a single upload, and bounds nothing else: a link is a bearer token that
 * anybody holding it can post to, so the number of files behind one is not something a practice decides. Two
 * gigabytes and five hundred files is generous for a season's documents — a client scanning everything at high
 * resolution lands around a tenth of it — and it turns "fill the disk" from something that happens by accident
 * into something that has to be deliberate.
 *
 * Why a count as well as a size: a full disk is not the only way to run out of room. Two hundred thousand
 * ten-kilobyte files exhausts inodes long before it exhausts bytes, and the symptom is the same — SQLite cannot
 * write, so the whole install stops rather than the one upload failing.
 *
 * **This bounds a link, not a practice.** A practice with sixty clients has sixty of these, so it is a per-link
 * ceiling and not a storage plan. A total is a billing question, and billing questions belong to the hosted
 * layer rather than to the product — see docs/operations.md.
 */
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_FILES = 500;

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
  // The second half of a sign-in, only reachable when the password was already right — see `signIn`.
  ['GET', '/signin/code', signInCodePage],
  ['POST', '/signin/code', signInCode],
  // A person's own second factor. Any member, any role: this is about their account, not the practice's
  // records, so it is not gated the way the members page is.
  ['GET', '/account/two-factor', twoFactorPage],
  ['POST', '/account/two-factor/start', twoFactorStart],
  ['POST', '/account/two-factor/confirm', twoFactorConfirm],
  ['POST', '/account/two-factor/codes', twoFactorNewCodes],
  ['POST', '/account/two-factor/off', twoFactorOff],
  ['POST', '/signout', signOut],
  ['GET', '/setup', setupForm, 'owner'],
  ['POST', '/setup', saveKeys, 'owner'],
  ['GET', '/keys', keysPage, 'owner'],
  ['POST', /^\/keys\/([^/]+)\/passphrase$/, changePassphrase, 'owner'],
  ['GET', '/members', membersPage, 'owner'],
  ['POST', '/members/invite', createInvitePage, 'owner'],
  ['POST', '/members/name', renamePracticePage, 'owner'],
  ['POST', '/members/notify', setNotifyPage, 'owner'],
  // Removal is two steps on purpose: a page that says what will happen (and what will not), then the act.
  ['GET', /^\/members\/([^/]+)\/remove$/, removeMemberPage, 'owner'],
  ['POST', /^\/members\/([^/]+)\/remove$/, removeMemberAction, 'owner'],
  // What a member may do, changed by an owner. It sits beside removal because it is the same question —
  // who is in this practice, and what they may do while they are.
  ['POST', /^\/members\/([^/]+)\/role$/, changeRolePage, 'owner'],
  ['GET', /^\/assets\/([A-Za-z0-9._-]+)$/, asset],
  ['GET', '/requests', listRequests],
  // The same two lists as files. Accountants reconcile a season in a spreadsheet, so a list that cannot
  // be got out of the tool is a list they retype.
  ['GET', '/requests.csv', requestsCsv],
  ['GET', '/clients.csv', clientsCsv],
  // Clients: a record of its own, and the page every request starts from when the client is known.
  ['GET', '/clients', listClients],
  ['GET', /^\/clients\/([^/]+)$/, viewClient],
  ['POST', /^\/clients\/([^/]+)$/, saveClient],
  ['GET', '/requests/new', newRequestForm],
  // The end of a season, done in one go. A string route before the pattern below, because
  // `/^\/requests\/([^/]+)$/` would otherwise swallow "close" as a request id.
  ['GET', '/templates', templatesPage],
  ['POST', '/templates', createTemplatePage],
  ['GET', /^\/templates\/([^/]+)$/, templatePage],
  ['POST', /^\/templates\/([^/]+)$/, saveTemplate],
  ['POST', /^\/templates\/([^/]+)\/items$/, addTemplateItemsPage],
  ['POST', /^\/templates\/([^/]+)\/items\/([^/]+)\/remove$/, removeTemplateItemPage],
  ['POST', /^\/templates\/([^/]+)\/delete$/, deleteTemplatePage],
  // One list, one deadline, one action: a request per client, each with its own link.
  ['GET', '/ask-everyone', askEveryonePage],
  ['POST', '/ask-everyone', askEveryone],
  ['POST', /^\/requests\/([^/]+)\/save-as-template$/, saveAsTemplate],
  ['GET', '/requests/close', closeSeveralPage],
  ['POST', '/requests/close', closeSeveral],
  ['POST', '/requests', createRequestPage],
  ['GET', /^\/requests\/([^/]+)$/, viewRequest],
  // Changing a request after it exists, and asking for it by email — the two things a practice needs the
  // day a deadline moves or a client has to be contacted, both of which happen after creation.
  ['GET', /^\/requests\/([^/]+)\/edit$/, editRequestForm],
  ['POST', /^\/requests\/([^/]+)\/edit$/, saveRequest],
  ['POST', /^\/requests\/([^/]+)\/send$/, draftOpening],
  ['POST', /^\/requests\/([^/]+)\/send-request$/, sendOpening],
  ['GET', /^\/requests\/([^/]+)\/files\/([^/]+)$/, serveEnvelope, 'accountant'],
  ['POST', /^\/requests\/([^/]+)\/link$/, issueLink],
  ['POST', /^\/requests\/([^/]+)\/check-all$/, checkAllArrivalsPage, 'accountant'],
  ['POST', /^\/requests\/([^/]+)\/contact$/, logContactPage],
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
  // The mail relay's test bench: a real send against whatever the environment configures, with the
  // relay's own reply when it refuses. Off the nav on purpose — the people who need it arrive from
  // docs/mail.md, and the rest of the practice never has to see it.
  ['GET', '/admin/test-email', testEmailForm, 'owner'],
  ['POST', '/admin/test-email', testEmailSend, 'owner'],
  // Re-sealing a stored document to a newer key, and retiring a key that no longer opens anything. The
  // whole of a key's life belongs to an owner, because it decides who can read what from here on.
  ['GET', /^\/keys\/([^/]+)\/pending$/, pendingFor, 'owner'],
  ['POST', /^\/keys\/([^/]+)\/move$/, moveWithoutScript, 'owner'],
  ['POST', /^\/files\/([^/]+)\/reencrypt$/, reencryptFile, 'owner'],
  ['POST', /^\/keys\/([^/]+)\/retire$/, retireKey, 'owner'],
  // Public: no session, gated by the token in the path.
  ['GET', /^\/r\/([^/]+)$/, clientPage],
  ['POST', /^\/r\/([^/]+)\/items\/([^/]+)\/says$/, clientSays],
  // Two things a client needed and could not do: send something nobody asked for, and say something that
  // is not a file. Both used to leave the product and become an ordinary email.
  ['POST', /^\/r\/([^/]+)\/extra$/, receiveExtra],
  ['POST', /^\/r\/([^/]+)\/message$/, clientMessage],
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
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxRequestFiles = DEFAULT_MAX_REQUEST_FILES,
  webDir = join(HERE, '..', 'web'),
  mailer = null,
  // How long a run of reminders may take. Injected so that a test can watch the run stop halfway, which
  // is otherwise a two-minute test — and a safety property that cannot be tested is a safety property
  // nobody has checked.
  chaseBudgetMs = CHASE_BUDGET_MS,
  // How many times one account may be guessed at before sign-in stops answering for a while. Injected so a
  // test can hit the cap in three attempts rather than eleven, and so a hosted deployment can swap the
  // in-process limiter for a shared one without touching a route.
  signInLimiter = createAttemptLimiter(),
  // Multi-tenancy arrives as an injected resolver and never as edits to the route table: given a
  // request, it names the practice and the database, blob directory and mailer that answer for it.
  // A resolution of null is a host with no practice behind it, answered before any database is
  // opened. Without a resolver every request is answered by the process's own database — which is
  // the whole of the single-tenant server. See docs/saas.md §2.4.
  resolveTenant = null,
  // A last pre-pass in front of everything the core serves, and the only place the SaaS gateway
  // hooks in: `preHandle(request, response, url)` answers a request itself and returns true, or
  // returns false and gets out of the way. The core never learns what a gateway is; the gateway
  // never edits the route table. (docs/saas.md §2.4.)
  preHandle = null,
  // Called when a client link is issued, with `{ practiceId, token }`. A no-op by default: the
  // single-tenant server has nowhere else for a link to live. The SaaS entry injects the recorder
  // that files the link's digest prefix into the registry, so a client link can find its way home
  // without a host header — and the core never learns that a registry exists.
  onLinkIssued = null,
  // What /healthz counts. The process's own database in single-tenant mode; injected by the SaaS
  // entry, whose process database is the registry and holds no `practitioner` table at all.
  healthCheck = null,
} = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    // A health check that touches the database, because a process that is up and cannot
    // read its own schema is not healthy. Deliberately before tenant resolution: the health of
    // the process is not a question about any one practice. In SaaS mode the process's own
    // database is the registry, and it says so, because "healthy" with the registry broken
    // would be a lie with a 200 on it.
    if (url.pathname === '/healthz') {
      try {
        const practices = healthCheck ? healthCheck() : db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n;
        // The version is on the health check because that is the one address an operator can reach without
        // signing in, and "which build is running" is the first question anybody asks when something is wrong.
        // It costs one string and it turns a guess into an answer.
        return sendJson(response, 200, { ok: true, version: VERSION, practices });
      } catch (error) {
        return sendJson(response, 503, { ok: false, error: error.message });
      }
    }

    // The one object every handler below reads from, resolved per request before any routing.
    // Declared here so that the catch block reports against the practice the request was
    // actually answered by, not whichever one started the process.
    let scoped = { db, blobDir, mailer, chaseBudgetMs, maxUploadBytes, maxRequestBytes, maxRequestFiles, onLinkIssued };

    try {
      if (preHandle) {
        const claimed = await preHandle(request, response, url);
        if (claimed) return;
      }

      if (resolveTenant) {
        // The resolver is given the response because it may be the one to answer — a practice with
        // a closed subscription gets its billing page from here, before any tenant file is opened.
        const tenant = resolveTenant(request, url, response);
        if (tenant?.handled) return;
        if (!tenant) return fail(response, 404, 'There is no practice at that address.');
        scoped = {
          db: tenant.db,
          blobDir: tenant.blobDir ?? blobDir,
          mailer: tenant.mailer ?? mailer,
          chaseBudgetMs: tenant.chaseBudgetMs ?? chaseBudgetMs,
          maxUploadBytes: tenant.maxUploadBytes ?? maxUploadBytes,
          // A hosted plan's storage ceiling arrives the same way the per-file one does: injected, so plan limits
          // are a deployment concern and the core never learns what a plan is.
          maxRequestBytes: tenant.maxRequestBytes ?? maxRequestBytes,
          maxRequestFiles: tenant.maxRequestFiles ?? maxRequestFiles,
          onLinkIssued: tenant.onLinkIssued ?? onLinkIssued,
        };
      }

      for (const [method, pattern, handler, needed = null] of ROUTES) {
        if (request.method !== method) continue;
        let params = null;
        if (typeof pattern === 'string') {
          if (url.pathname === pattern) params = [];
        } else {
          params = url.pathname.match(pattern);
        }
        if (!params) continue;

        const context = await contextFor(scoped.db, request, response, url, params.slice(1));

        // **The permission check lives here rather than in fifteen handlers**, and that is the point of it:
        // a check written inside a handler is invisible from everywhere except that handler, so the way to
        // find out what an assistant can do would be to read the whole file and hope. The role a route needs
        // is on the route, so the model can be read off the table in one screen — and there is a test that
        // walks it and fails when a sensitive address has no role beside it.
        //
        // A signed-out visitor is sent to sign in rather than told they lack permission: they may well have
        // the right role, and they have simply not said who they are yet.
        if (needed && !roleMeets(context.practitioner?.role, needed)) {
          if (!requireSignIn(context)) return;
          return fail(response, 403, refusalFor(needed, context.practitioner.role), context.practitioner);
        }

        await handler({
          ...context,
          blobDir: scoped.blobDir,
          maxUploadBytes: scoped.maxUploadBytes,
          // These two were missing when the ceilings were first written, and every ceiling test failed — which is
          // what the tests are for. The dispatcher lists what a handler may have rather than passing the whole
          // scope, so a new limit is not in force until it is named here.
          maxRequestBytes: scoped.maxRequestBytes,
          maxRequestFiles: scoped.maxRequestFiles,
          webDir,
          mailer: scoped.mailer,
          chaseBudgetMs: scoped.chaseBudgetMs,
          signInLimiter,
          onLinkIssued: scoped.onLinkIssued,
        });
        return;
      }
      return fail(response, 404, 'There is no page at that address.');
    } catch (error) {
      if (error instanceof RequestError) {
        return fail(response, error.status, error.message, practitionerFor(scoped.db, request));
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
        <div class="hero">
          <p class="eyebrow">Documents, chased politely</p>
          <h1>The list of documents a client owes you,
            and a tick as each one arrives.</h1>
          <p class="lead">Tickmark is a self-hosted tool for a practice that needs documents from
          clients. Build the list, send a link, and watch it get ticked off. The client needs no
          account and installs nothing.</p>
          <div class="actions">
            <a class="btn primary lg" href="/signup">Create a practice</a>
            <a class="btn lg" href="/signin">Sign in</a>
          </div>
          <div class="tiles">
            ${tile('1 link', 'per client, no account needed')}
            ${tile('0 keys', 'the server holds — it cannot read your files')}
            ${tile('every tick', 'kept, with the date it happened')}
          </div>
          <p class="note">Files are encrypted in the client's browser before they are sent, so the
          server stores what it cannot read. That is why your passphrase cannot be reset for you —
          and why it is worth saving the first time you choose one.</p>
          <p class="note">Early days. Anything not described in <code>docs/mvp.md</code>
          does not exist yet.</p>
        </div>
      `,
    }),
  );
}

/** The shape an address has to have, in the one place it is written down. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one place a credential is validated, so sign-up and sign-in cannot drift apart. */
function validateCredentials(email, password) {
  if (!email) return 'An email address is required.';
  if (email.length > 254) return 'That email address is too long.';
  if (!EMAIL_SHAPE.test(email)) return 'That does not look like an email address.';
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `A password of at least ${MIN_PASSWORD} characters is required.`;
  }
  if (password.length > 1024) return 'That password is too long.';
  return null;
}

function credentialsForm({ action, title, submit, error = null, email = '', hint = false }) {
  return html`
    <div class="center">
      <div class="card">
        <h1>${title}</h1>
        ${error ? html`<p class="error">${error}</p>` : ''}
        <form method="post" action="${action}">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required value="${email}" autocomplete="username" autofocus>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="${MIN_PASSWORD}"
                 autocomplete="${action === '/signup' ? 'new-password' : 'current-password'}">
          ${hint
            ? html`<p class="note">At least ${MIN_PASSWORD} characters. It is the only thing
                between a stranger and other people's financial records, so it is stored with
                a deliberately expensive hash rather than a fast one.</p>`
            : ''}
          <button type="submit" class="primary">${submit}</button>
        </form>
      </div>
    </div>`;
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

/**
 * The form that asks for the six digits.
 *
 * One field, one button, and a sentence about recovery codes underneath — because the person who needs it is
 * the person whose phone is in a taxi, and they will not think to look for it.
 */
function codeForm({ error = null, action = '/signin/code' }) {
  return html`<div class="center">
    <div class="card">
      <h1>Your code</h1>
      <p class="note">Six digits from your authenticator app.</p>
      ${error ? html`<p class="error">${error}</p>` : ''}
      <form method="post" action="${action}">
        <label for="code">Code <span class="note">— or one of your recovery codes</span></label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required
          maxlength="20" class="code-input">
        <button type="submit">Continue</button>
      </form>
      <p class="note">Codes change every thirty seconds. If the app on the phone is not with you, a recovery
      code from the sheet you were given will work once.</p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------
// Two-factor: setting it up
// ---------------------------------------------------------------------------------

/**
 * Check a code for the person themselves, for the two actions that could lock them out or lock them in.
 *
 * Accepts a recovery code as well, and for turning two-factor *off* that matters more than anything else on
 * this page: the person who needs to turn it off is very often the person whose phone is gone.
 */
function codeAuthorises(db, practitionerId, code) {
  const state = twoFactorState(db, practitionerId);
  if (state.state !== 'on') return true;
  const step = codeStepFor(state.secret, code);
  if (step !== null && step !== state.lastStep) {
    recordAcceptedStep(db, practitionerId, step);
    return true;
  }
  return spendRecoveryCode(db, practitionerId, code);
}

/**
 * The page where somebody arms their own second factor.
 *
 * Per person rather than per practice, because that is what the secret is: a thing on *your* phone. A firm
 * where one member has two-factor and another does not is a normal state, and the members page shows which is
 * which so an owner can see it rather than guess.
 *
 * **The secret is shown as text, in groups, and that is not a gap.** A QR code needs Reed–Solomon error
 * correction and a renderer, which is a dependency this project will not take for a screen shown once — and
 * manual entry works in every authenticator app ever made. The `otpauth://` URI is offered alongside it for
 * anyone who would rather paste it into a generator.
 */
function twoFactorPage({ db, response, practitioner, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const state = twoFactorState(db, practitioner.id);
  const justOff = url.searchParams.get('off') === '1';
  const left = state.state === 'on' ? unusedRecoveryCodes(db, practitioner.id) : 0;

  return sendPage(response, 200, page({
    title: 'Two-factor sign-in',
    practitioner,
    here: '/members',
    banner: justOff
      ? html`<p class="warning"><strong>Two-factor is off.</strong> Your password is now the only thing between
          somebody and your account — and an account can add a key of its own, which is worth knowing before
          leaving it off.</p>`
      : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/members">Members</a></p>
          <h1>Two-factor sign-in</h1>
          <p class="sub">A six-digit code from an app on your phone, asked for after your password. It is the
          only thing that stops a stolen password from becoming a stolen practice.</p>
        </div>
      </div>

      <section class="card">
        <h2>${state.state === 'on' ? badge('on', TONES.done) : badge('not set up', TONES.waiting)}</h2>
        ${state.state === 'off' ? twoFactorOffCard(practitioner) : ''}
        ${state.state === 'unconfirmed' ? twoFactorPendingCard({ db, practitioner, secret: state.secret }) : ''}
        ${state.state === 'on' ? twoFactorOnCard({ practitioner, left }) : ''}
      </section>

      <section class="card">
        <h2>How this fits the rest</h2>
        <p class="note">Two-factor protects <strong>your account</strong>. It has nothing to do with the
        encryption: your passphrase still unwraps your copy of the practice key, and the server still cannot read
        a document. The two are separate on purpose — a second factor that could recover a lost passphrase would
        be a second factor that could read your files.</p>
        <p class="note">An operator who runs this server can turn two-factor off for you by editing the database,
        because they can already read everything else about your account. What they cannot do is read your
        documents, which is the promise this product actually makes.</p>
      </section>`,
  }));
}

/** Nothing set up: the reason it is worth doing, and one button. */
const twoFactorOffCard = (practitioner) => html`
  <p>Two-factor is not set up for <strong>${practitioner.email}</strong>.</p>
  <p class="note"><strong>Why this is worth doing.</strong> The passphrase protects your key, so nobody with
  your password can read documents that have already arrived. But uploads are sealed to the practice's
  <em>public</em> keys — and somebody signed in as you can add one of their own. From that moment every
  document your clients send is encrypted to them, and nothing would look wrong anywhere.</p>
  <form method="post" action="/account/two-factor/start">
    <button type="submit" class="primary">Set it up</button>
  </form>`;

/** Started and not armed: the secret, and the code that finishes it. */
const twoFactorPendingCard = ({ db, practitioner, secret }) => html`
  <p><strong>Not armed yet.</strong> Add this secret to your authenticator app, then type the code it shows to
  finish. Until you do, nothing about how you sign in has changed.</p>
  <p class="note">In your app, choose "add account" and enter this by hand:</p>
  <p class="secret">${inGroups(secret)}</p>
  <p class="note">Or paste this into a code generator, if you would rather:
    <code class="wrap">${otpauthUri({ secret, account: practitioner.email, issuer: practiceFor(db, practitioner.practiceId)?.name ?? 'Tickmark' })}</code></p>
  <form method="post" action="/account/two-factor/confirm" class="stack">
    <label for="code">The six digits it shows</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6"
      class="code-input">
    <div class="row"><button type="submit" class="primary">Turn it on</button></div>
  </form>`;

/** Armed: what that means, how many codes are left, and the two actions that need a code. */
const twoFactorOnCard = ({ practitioner, left }) => html`
  <p>Signing in as <strong>${practitioner.email}</strong> asks for a code from your app.</p>
  <p class="note">${left} recovery ${left === 1 ? 'code is' : 'codes are'} unused. Those are the ones for the day
  the phone is gone.</p>
  ${left === 0
    ? html`<p class="warning"><strong>None left.</strong> If that phone is lost there is no way back in except an
        operator with access to the database. Make some more now.</p>`
    : ''}
  <div class="actions">
    <form method="post" action="/account/two-factor/codes" class="inline">
      <input name="code" inputmode="numeric" maxlength="6" placeholder="code" aria-label="A code" required>
      <button type="submit">New recovery codes</button>
    </form>
    <form method="post" action="/account/two-factor/off" class="inline">
      <input name="code" inputmode="numeric" maxlength="20" placeholder="code"
        aria-label="A code or a recovery code" required>
      <button type="submit" class="danger">Turn it off</button>
    </form>
  </div>
  <p class="note">Both need a code — from the app, or a recovery code. That is what they are for.</p>`;

/** Generate a secret and hold it, unarmed, so the page can show it. */
function twoFactorStart({ db, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  setPendingSecret(db, practitioner.id, generateSecret());
  return redirect(response, '/account/two-factor');
}

/**
 * Arm it, and hand over the recovery codes — **the only time they are ever shown**.
 *
 * They are stored as digests, so there is no page that can show them again and no operator who can read them
 * out. The response is rendered directly rather than redirected for the same reason: a redirect would need the
 * codes to survive somewhere, and the only somewhere would be a session or a URL.
 */
async function twoFactorConfirm({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const state = twoFactorState(db, practitioner.id);
  if (state.state !== 'unconfirmed') {
    return fail(response, 400, 'There is no setup waiting to be finished. Start again from the two-factor page.', practitioner);
  }

  const step = codeStepFor(state.secret, field(fields, 'code') ?? '');
  if (step === null) {
    return fail(
      response,
      400,
      'That code was not right. Check the app is showing the code for this account, wait for the next one, and type it again.',
      practitioner,
    );
  }

  const codes = generateRecoveryCodes();
  confirmTwoFactor(db, practitioner.id, codes);
  recordAcceptedStep(db, practitioner.id, step);

  sendPage(response, 200, page({
    title: 'Two-factor is on',
    practitioner,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Two-factor is on</h1>
          <p class="sub">Nothing else to do — the next time you sign in, it will ask for a code.</p>
        </div>
      </div>
      <section class="card">
        <h2>Your recovery codes</h2>
        <p class="warning"><strong>Write these down now.</strong> This is the only time they are shown: they
        are stored scrambled, so nobody — not us, not an operator with the database — can read them back to
        you.</p>
        <ul class="codes">${codes.map((code) => html`<li><code>${code}</code></li>`)}</ul>
        <p class="note">Each one works <strong>once</strong>, instead of a code from the app. Keep them
        somewhere that is not the phone: a password manager, or a piece of paper somewhere sensible. If you
        lose the phone and the codes, only somebody with access to this server can get you back in.</p>
        <div class="actions"><a class="btn" href="/requests">Done</a></div>
      </section>`,
  }));
}

/** New recovery codes, for the practice that has used theirs or lost the sheet. */
async function twoFactorNewCodes({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  if (!codeAuthorises(db, practitioner.id, field(fields, 'code') ?? '')) {
    return fail(response, 400, 'That code was not right, so no new codes were made. The old ones still work.', practitioner);
  }

  const codes = generateRecoveryCodes();
  // The unused ones are replaced rather than added to: a sheet of sixteen half-remembered codes is worse than a
  // sheet of eight, and the practice asked for new ones because they could not find the old.
  confirmTwoFactor(db, practitioner.id, codes);

  sendPage(response, 200, page({
    title: 'New recovery codes',
    practitioner,
    body: html`
      <div class="page-head"><div class="titles"><h1>New recovery codes</h1></div></div>
      <section class="card">
        <p class="warning"><strong>Write these down now.</strong> They replace the ones you had, and this is
        the only time they are shown.</p>
        <ul class="codes">${codes.map((code) => html`<li><code>${code}</code></li>`)}</ul>
        <div class="actions"><a class="btn" href="/account/two-factor">Done</a></div>
      </section>`,
  }));
}

async function twoFactorOff({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  if (!codeAuthorises(db, practitioner.id, field(fields, 'code') ?? '')) {
    return fail(
      response,
      400,
      'That code was not right, so two-factor is still on. Use a code from the app, or one of your recovery codes.',
      practitioner,
    );
  }
  clearTwoFactor(db, practitioner.id);
  return redirect(response, '/account/two-factor?off=1');
}

async function signIn({ db, request, response, signInLimiter }) {
  const fields = formFields(await readBody(request));
  const email = field(fields, 'email')?.toLowerCase() ?? null;
  const password = typeof fields.password === 'string' ? fields.password : '';

  // Checked before the password is verified, because the point is to spend no expensive hashing on a guess
  // — and because the answer is "not now" rather than "wrong", which the form says in those words.
  const key = email ?? '';
  const blockedFor = signInLimiter?.blockedFor(key) ?? 0;
  if (blockedFor > 0) {
    const minutes = Math.ceil(blockedFor / 60000);
    return sendPage(response, 429, page({
      title: 'Too many attempts',
      body: credentialsForm({
        action: '/signin',
        title: 'Too many attempts',
        submit: 'Sign in',
        error: `Too many failed attempts for that address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or use a different address to sign in.`,
        email: email ?? '',
      }),
    }));
  }

  const record = email ? practitionerByEmail(db, email) : null;
  let accepted = false;
  if (record) {
    accepted = await verifyPassword(password, record.password_hash);
  } else {
    await spendTheSameTimeAsARealCheck(password);
  }
  if (accepted) signInLimiter?.succeeded(key);
  else signInLimiter?.failed(key);

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

  // **The password is right and the sign-in is not finished.** Everything above this line is unchanged and
  // every failure on it is answered exactly as it always was, so an install with two-factor set up on nobody
  // behaves byte for byte as it did before. What is new is only this: when a person has armed a second
  // factor, the password stops being the whole of the proof.
  const second = twoFactorState(db, record.id);
  if (second.state === 'on') {
    const { token } = startChallenge(db, record.id);
    // The challenge rides in its own cookie rather than in the URL: a query string ends up in logs, in
    // history and in whatever the browser sends as a referrer, and this is the one token in the product that
    // is one code away from being a session.
    return redirect(response, '/signin/code', [challengeCookie(token)]);
  }

  const { token } = createSession(db, record.id);
  return redirect(response, '/requests', [sessionCookie(token)]);
}

/**
 * The second half of a sign-in: the code.
 *
 * Two things are accepted here and they are deliberately different in kind. A **code from the authenticator**
 * is the ordinary path. A **recovery code** is the one for the day the phone is gone, and it is spent rather
 * than checked — a sheet of codes where one has been used should say so.
 *
 * A wrong code does **not** end the challenge. Somebody typing six digits from a phone that is a few seconds
 * out of step deserves another go, and the challenge dies on its own in ten minutes; what stops a brute-force
 * is that there are a million codes and ten minutes.
 */
async function signInCode({ db, request, response }) {
  const jar = parseCookies(request.headers.cookie);
  const challenge = challengeFor(db, jar[CHALLENGE_COOKIE]);
  if (!challenge) {
    return sendPage(response, 410, page({
      title: 'That sign-in has expired',
      body: html`<h1>That sign-in has expired</h1>
        <p>Nothing was signed in. Start again — it takes a moment.</p>
        <div class="actions"><a class="btn" href="/signin">Sign in again</a></div>`,
    }));
  }

  const fields = formFields(await readBody(request));
  const code = field(fields, 'code') ?? '';
  const person = twoFactorState(db, challenge.practitionerId);
  if (person.state !== 'on') {
    // Turned off in another tab between the password and the code. Nothing to check, so finish the sign-in
    // rather than leaving somebody stuck on a page asking for a code that no longer exists.
    endChallenge(db, challenge.id);
    const { token } = createSession(db, challenge.practitionerId);
    return redirect(response, '/requests', [sessionCookie(token), clearChallengeCookie()]);
  }

  const step = codeStepFor(person.secret, code);
  const fresh = step !== null && step !== person.lastStep;
  if (!fresh && !spendRecoveryCode(db, challenge.practitionerId, code)) {
    return sendPage(response, 401, page({
      title: 'That code was not right',
      body: codeForm({
        error: 'That code was not right. Codes change every thirty seconds, so try the one showing now — or use one of your recovery codes if the phone is not to hand.',
      }),
    }));
  }

  if (fresh) recordAcceptedStep(db, challenge.practitionerId, step);
  endChallenge(db, challenge.id);
  const { token } = createSession(db, challenge.practitionerId);
  return redirect(response, '/requests', [sessionCookie(token), clearChallengeCookie()]);
}

/** The page that asks for the six digits, or for a recovery code. */
function signInCodePage({ request, response, db }) {
  const jar = parseCookies(request.headers.cookie);
  if (!challengeFor(db, jar[CHALLENGE_COOKIE])) {
    return sendPage(response, 410, page({
      title: 'That sign-in has expired',
      body: html`<h1>That sign-in has expired</h1>
        <p>Nothing was signed in. Start again — it takes a moment.</p>
        <div class="actions"><a class="btn" href="/signin">Sign in again</a></div>`,
    }));
  }
  sendPage(response, 200, page({ title: 'Your code', body: codeForm({}) }));
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
 * A template's list, as the lines the request form's textarea expects.
 *
 * A document's note goes on the same line, after an em dash, because that is how a practice types one — and it
 * is the same shape the duplicate-a-request path writes, so both ways of filling that textarea agree.
 */
function templateItemLines(template) {
  return template.items.map((item) => (item.note ? `${item.label} — ${item.note}` : item.label)).join('\n');
}

/**
 * The message a practice gets when a client does something.
 *
 * This is the other half of the loop, and the half the research is most specific about: *"a job should flip to
 * ready when the document set is complete, not when files arrive"*, and *"a system that hides its uncertainty is
 * worse than none"*. A practice with sixty clients cannot poll a board, so without this the product knows
 * something its owner does not — which is the one thing a document-chasing tool must not do.
 *
 * Five decisions in the wording, each of them a failure this would otherwise have:
 *
 * 1. **It says what arrived *and* what has not.** "3 documents arrived" invites the question "is that all of
 *    them?", and the answer is the only thing the practice actually needs.
 * 2. **It carries the client's own words.** An answer to "why can't you send this?" is a decision waiting to be
 *    made, in the client's own phrasing — and it is quoted rather than summarised, because "I do not have this"
 *    and "I will send this later" are different situations and telling them apart is the point of asking.
 * 3. **It never says the work is ready unless it is.** All arrived is reported as all arrived; anything else
 *    carries the count still owed, and something flagged for re-sending is said outright.
 * 4. **It does not name files.** Filenames are metadata the server can see and the practice can see, but an
 *    email is a copy that leaves the building — quoted, forwarded, sync'd to a phone in plaintext — and the
 *    practice is one click from the real names. The narrower thing is the right one here; the labels are enough
 *    to know whether to go and look.
 * 5. **It is a nudge to look, not a running total.** One message per request per day (see the caller), because
 *    a client sending six files must not produce six emails — that is how a helpful notification becomes one the
 *    practice filters into a folder and stops reading.
 */
export function arrivalDraft({
  clientName,
  title,
  received,
  total,
  missing = [],
  answers = [],
  again = [],
  said = [],
  extra = 0,
  link,
  practiceName = null,
}) {
  const lines = ['Hello,', ''];
  const complete = received === total && again.length === 0 && answers.length === 0;

  if (complete) {
    lines.push(
      `Everything asked for has arrived: ${total} of ${total} ${total === 1 ? 'document' : 'documents'} for ${title}.`,
    );
  } else {
    lines.push(`${clientName} has sent ${received} of ${total} ${total === 1 ? 'document' : 'documents'} for ${title}.`);
  }
  lines.push('');

  // The client's own words, before anything else, because they change what the practice does next: a document
  // somebody has explained they cannot supply is not chased, it is decided about.
  if (answers.length > 0) {
    lines.push(
      `${answers.length === 1 ? 'One document has an answer' : `${answers.length} documents have answers`} from ${clientName}:`,
      '',
      ...answers.map((item) => `  - ${item.label} — "${item.says}"`),
      '',
      'Those are waiting on a decision from you rather than on the client.',
      '',
    );
  }

  // A message, quoted rather than summarised. The two fixed buttons cover "I cannot send this" and "I will send
  // it later"; anything else the client writes is theirs and paraphrasing it would lose the part that matters.
  if (said.length > 0) {
    lines.push(`And ${said.length === 1 ? 'a message' : `${said.length} messages`} from ${clientName}:`, '');
    for (const message of said) lines.push(`  "${message}"`, '');
  }

  // Files that answer nothing. Named rather than counted, because the practice has to decide what they are.
  if (extra > 0) {
    lines.push(
      `${extra} ${extra === 1 ? 'file was' : 'files were'} sent that nothing had asked for. They are on the request.`,
      '',
    );
  }

  if (complete) {
    lines.push('There is nothing more to wait for. Open the request to check what came in and mark it off.', '');
  } else if (missing.length > 0) {
    lines.push('Still outstanding:', '', ...missing.map((label) => `  - ${label}`), '');
  }
  // Said before the link, because it changes what the practice does next: a document that has been sent but is
  // no use is a thing to chase, not a thing to count as arrived.
  if (again.length > 0) {
    lines.push(
      `${again.length} ${again.length === 1 ? 'document has' : 'documents have'} been sent but flagged as needing sending again:`,
      '',
      ...again.map((item) => `  - ${item.label}${item.note ? ` (${item.note})` : ''}`),
      '',
    );
  }

  lines.push('The request, with the files themselves:', link);

  // Said only when the position may have moved on, because a message sent on the first file of a sitting
  // describes that moment and the client may well have sent the rest by the time it is read.
  if (!complete) {
    lines.push('', 'That is where it stood when this was sent — the request itself shows the current position.');
  }
  lines.push('', ...signOff(practiceName));
  return {
    // The subject is a fact that stays true when it is read a week later in a list, because a subject is the one
    // part of an email people read without opening it. "Sent 1 of 3" would be true when written and false minutes
    // later, and a practice scanning a column of subjects deserves better than arithmetic that has moved on. The
    // count is in the body, where the snapshot is dated.
    //
    // Which of the two things happened is *derived* from the facts rather than passed in as a "trigger", because a
    // caller that got the trigger wrong would produce a subject that contradicts its own body. Nothing received
    // and an answer present means the answer is what happened; anything else is a file.
    subject: complete
      ? `Everything has arrived for ${title}`
      : received === 0 && said.length > 0
        ? `${clientName} has written about ${title}`
        : received === 0 && answers.length > 0
          ? `${clientName} has answered about ${title}`
          : `${clientName} has sent something for ${title}`,
    body: lines.join('\n'),
  };
}

/**
 * Tell the practice that something happened on the client's side — **after the client has already been answered.**
 *
 * Two triggers reach this: a file arriving, and a client saying something ("I do not have this", "I will send it
 * later"). They share one message and one set of rules, because they are the same event from the practice's point
 * of view — the client has done something and somebody has to look. Every email this product sent before this one
 * was triggered by the practice pressing a button; this is the other half of the loop, and the half the research
 * is most specific about: *"a job should flip to ready when the document set is complete, not when files arrive"*
 * is a sentence about the person doing the work being told.
 *
 * The ordering is the whole design. The client's action is recorded and their response sent before this runs, so a
 * mail server that is down, slow, or refusing the practice's own address can never make a client's upload fail,
 * never make them wait, and never make an answer look like an error. The client is doing the practice a favour.
 *
 * Everything is wrapped, and every outcome is named rather than thrown. Returns a short word for the caller —
 * and for the tests, which is how each of these rules is checked without reading a log.
 */
export async function notifyPracticeOfChange({ db, requestRow, mailer, origin }) {
  try {
    const practice = practiceFor(db, requestRow.practice_id);
    if (!practice) return 'no-practice';
    if (!mailer) return 'no-mail-server';
    if (!practice.notifyOnUpload) return 'turned-off';

    const owner = requestOwner(db, requestRow.id);
    if (!owner?.email) return 'nobody-to-tell';

    // Once per request per day, on the practice's own calendar. Without this, a client sending six files sends
    // six emails — and the sixth is the reason the practice turns the whole thing off. The day is counted from
    // the practice's timezone, which is the one piece of time arithmetic this product does.
    const last = lastNoticeAt(db, requestRow.id);
    if (last && dateIn(practice.timezone, new Date(last)) === todayIn(practice.timezone)) return 'already-told';

    const items = itemsOf(db, requestRow.id).filter((item) => !item.withdrawn);
    if (items.length === 0) return 'nothing-asked-for';

    const message = arrivalDraft({
      clientName: requestRow.client_name,
      title: requestRow.title,
      received: items.filter((item) => item.received).length,
      total: items.length,
      missing: items.filter((item) => !item.received).map((item) => item.label),
      // What the client said, which is the reason this email fires on an answer as well as on a file: an item the
      // client has explained they cannot supply is still outstanding, and a practice that does not know is a
      // practice that nags them about it.
      answers: items
        .filter((item) => item.clientSays)
        .map((item) => ({ label: item.label, says: item.clientSays })),
      // Flagged documents are listed apart, because "we have all of it" and "we have all of it and one of them is
      // the wrong year" are different mornings for the person reading this.
      again: items
        .filter((item) => item.needsAttention)
        .map((item) => ({ label: item.label, note: item.attentionNote })),
      // A client's own words are quoted, and their own documents are counted. Both are facts about the request;
      // neither is a "reason this email was sent", which is why the subject is derived from them rather than
      // passed in as a trigger that a caller could get wrong.
      said: history(db, requestRow.id)
        .filter((event) => event.kind === 'client.messaged')
        .map((event) => event.detail),
      extra: uploadsOf(db, requestRow.id).filter((upload) => upload.request_item_id === null).length,
      link: `${origin}/requests/${requestRow.id}`,
      practiceName: practice.name,
    });

    const { messageId } = await sendMail(mailer, { to: owner.email, subject: message.subject, body: message.body });
    recordEvent(db, { requestId: requestRow.id, kind: 'notice.sent', detail: `${owner.email} — ${messageId}` });
    return 'sent';
  } catch (error) {
    // A failed notification is recorded and swallowed. It is never the client's problem and never worth failing
    // their action over: what happened is on the board either way, and with no `notice.sent` written the next
    // change will try again rather than being suppressed by a day that never happened.
    try {
      recordEvent(db, { requestId: requestRow.id, kind: 'notice.failed', detail: error.message });
    } catch {
      // If even that fails, the log is the last resort. The client has already had their answer.
    }
    console.error(`tickmark: could not tell the practice about a change to ${requestRow.id}:`, error);
    return 'failed';
  }
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
 * How a letter from the practice ends: the practice's own name.
 *
 * It was `Thanks,` and nothing else, which is the one thing an email asking a stranger for their bank
 * statements must not be: unsigned. A client who has never heard of Tickmark, receiving a message from an
 * address they may not recognise, asking them to open a link and upload documents, needs the sender's name in
 * front of them — and the name on the portal they land on. This is a *draft*, so a practice that signs its
 * letters differently can change it; the point is that the default is not anonymous.
 */
const signOff = (practiceName) => (practiceName ? ['Thanks,', '', practiceName] : ['Thanks,']);

/**
 * The message a practice sends when it first asks for something.
 *
 * A different letter from a reminder, and the difference is the whole point: nothing has gone wrong yet, so
 * there is nothing to chase and nobody to correct. It introduces the request, lists everything wanted, and
 * says who is asking.
 *
 * The practice's own note to the client is quoted at the top when there is one, because that note was
 * written *for this client* — "here is the list for your 2026 filing, please upload these by Friday" — and
 * a letter that made the client open the portal to read it would be hiding the practice's own words behind
 * a click.
 *
 * Like the reminder, this is a pure function of the facts so the wording has one home and can be tested
 * without a mail server, and like the reminder it is a **draft**: the page puts it in a textarea the
 * practice edits, because the tool does not know this client and the practice does.
 */
export function openingDraft({ clientName, title, dueAt, items, note = null, link, practiceName = null }) {
  const lines = [`Hello ${clientName},`, ''];

  if (note) {
    lines.push(note, '');
  } else {
    lines.push(`We need the following for ${title}:`, '');
  }

  lines.push(`  - ${items.join('\n  - ')}`, '');

  lines.push('You can send them at this link — no account or password needed:', link);
  if (dueAt) lines.push('', `We would like these by ${dueAt}.`);
  lines.push(
    '',
    'If something on the list does not apply to you, reply and tell us — it is easier than sending the wrong thing.',
    '',
    ...signOff(practiceName),
  );

  return { subject: `Documents we need for ${title}`, body: lines.join('\n') };
}

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
export function reminderDraft({
  clientName,
  title,
  dueAt,
  outstanding,
  again = [],
  theySaid = [],
  link,
  practiceName = null,
}) {
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
    ...signOff(practiceName),
  );

  return { subject: `Still needed for ${title}`, body: lines.join('\n') };
}

/**
 * Whose turn it is. An answered request sorts with the ones waiting on the practice rather than the ones waiting
 * on the client: somebody has to decide something, and the client is the one waiting for that.
 */
const REQUEST_ORDER = { 'to-check': 0, answered: 1, waiting: 2, ready: 3 };

/** An undated request sorts last: "no date" must not read as "due now". */
const dueFirst = (a, b) => (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');
const byClientName = (a, b) => a.client_name.localeCompare(b.client_name);

/**
 * The orders the board can be read in, defined once and used by both the page and the export.
 *
 * The list exists to answer "what do I do now?", so the default is **whose turn it is**: files to check
 * first, because chasing a client about a document that is already sitting there is the mistake that state
 * exists to prevent. The other orders exist because the question changes — at the end of a season it is
 * dates, and when a client rings up it is their name.
 *
 * Shared with the CSV export on purpose: a file whose rows are in a different order from the screen it was
 * downloaded from is a file somebody has to sort again by hand.
 */
const REQUEST_ORDERS = {
  state: (a, b) =>
    (REQUEST_ORDER[a.progress.state] ?? 9) - (REQUEST_ORDER[b.progress.state] ?? 9) ||
    dueFirst(a, b) ||
    byClientName(a, b),
  due: (a, b) => dueFirst(a, b) || byClientName(a, b),
  client: byClientName,
  asked: (a, b) => b.created_at.localeCompare(a.created_at),
};

function listRequests({ db, response, practitioner, url, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const showingClosed = url.searchParams.get('closed') === '1';
  const wanted = url.searchParams.get('state');
  const query = (url.searchParams.get('q') ?? '').trim();
  const sort = url.searchParams.get('sort') ?? 'state';
  const all = requestsFor(db, practiceId, { scope: showingClosed ? 'closed' : 'open' });
  const closed = closedCount(db, practiceId);
  // Overdue is a question about the practice's calendar, not Greenwich's: a due date of the 31st is late on
  // the 31st where they are, and answering it in UTC makes that answer wrong for part of every day — in the
  // direction that says "overdue" a day early in Auckland and a day late in Honolulu.
  const today = todayIn(practiceFor(db, practiceId).timezone);

  /**
   * The season notice: who is due an ask, said on the page a practice actually opens.
   *
   * `clientsDueForAsking` has existed since 2u and is accurate, and its one weakness was that it lived only on
   * the clients page — a practice who works from the board every morning would never be told that the year had
   * come round, which is the remembering half of "no scheduled requests" and the only half this product wants.
   *
   * Shown only on the board's home state — not the closed tab, not a filtered or searched list — because a
   * notice that follows somebody around stops being a notice. And it is information rather than a nag: it
   * appears when there is season work, and asking the clients removes them from the list, so it clears itself.
   */
  const seasonNotice =
    showingClosed || wanted || query
      ? null
      : clientsDueForAsking(db, practiceId, { timezone: practiceFor(db, practiceId).timezone });

  const counts = {};
  for (const row of all) counts[row.progress.state] = (counts[row.progress.state] ?? 0) + 1;
  // Search before the state filter, so the count under the search box is "what matched" rather than
  // "what matched that also happens to be in the tab I am looking at", which nobody can act on.
  //
  // Matched against the client, the title and the address: an accountant looking for a request by the
  // address it came from is as likely as by the name, and matching a substring at all is what makes this
  // useful for the way a practice actually remembers things ("the 2025 one", "northwind").
  const needle = query.toLowerCase();
  const matching = needle
    ? all.filter((row) =>
        [row.client_name, row.title, row.client_email ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : all;

  const rows = matching
    .filter((row) => !wanted || row.progress.state === wanted)
    .sort(REQUEST_ORDERS[sort] ?? REQUEST_ORDERS.state);

  /**
   * A link back to this list with one thing changed, and everything else kept.
   *
   * Written once because there are now four filters that compose — tab, state, search, order — and a URL
   * built by hand at each call site is how one of them quietly gets dropped. An empty value removes its
   * parameter rather than sending `q=`, so the address bar stays readable and a link can be sent to
   * somebody else.
   */
  const href = (changes = {}) => {
    const params = new URLSearchParams();
    const merged = {
      closed: showingClosed ? '1' : '',
      state: wanted ?? '',
      q: query,
      sort: sort === 'state' ? '' : sort,
      ...changes,
    };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    const string = params.toString();
    return `/requests${string ? `?${string}` : ''}`;
  };

  const dueCell = (row) => {
    if (!row.due_at) return html`<span class="muted">no date</span>`;
    if (row.due_at < today && !showingClosed) {
      return html`${badge('overdue', TONES.wrong)} <span class="muted">${row.due_at}</span>`;
    }
    return row.due_at;
  };

  const stateBadge = (state) => badge(REQUEST_STATE_WORDS[state], stateTone(state));

  const table = rows.length === 0
    ? empty(
        query
          ? `Nothing matches “${query}”`
          : showingClosed
            ? 'Nothing has been closed yet'
            : wanted
              ? 'Nothing is in that state'
              : 'No requests yet',
        query
          ? html`The search looks at the client, the request and the address. <a href="${href({ q: '' })}">Clear it</a> to see everything again.`
          : showingClosed
            ? 'When a year is finished with, close the request: the record, the files and the client’s link all stay exactly as they are.'
            : wanted
              ? html`<a href="/requests">Show everything open</a>.`
              : html`Start one and send the client a link — it takes a minute, and the client needs no account.`,
        query || showingClosed || wanted ? null : html`<a class="btn primary" href="/requests/new">New request</a>`,
      )
    : html`<div class="scroll"><table class="board">
        <colgroup>
          <col class="c-client"><col class="c-request"><col class="c-state">
          <col class="c-due"><col class="c-out"><col class="c-check">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Client</th>
            <th align="left">Request</th>
            <th align="left">State</th>
            <th align="left">Due</th>
            <th align="right">Outstanding</th>
            <th align="right">To check</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td><span class="cell-t">${row.client_name}</span></td>
            <td>
              <a class="cell-t" href="/requests/${row.id}">${row.title}</a>
              <a class="cell-s" href="/requests/new?from=${row.id}">Duplicate</a>
            </td>
            <td><a href="/requests?state=${row.progress.state}">${stateBadge(row.progress.state)}</a></td>
            <td>${dueCell(row)}</td>
            <td align="right">${row.progress.outstanding === 0
              ? html`<span class="muted">—</span>`
              : html`<strong>${row.progress.outstanding}</strong>`}</td>
            <td align="right">${row.progress.toCheck === 0
              ? html`<span class="muted">—</span>`
              : html`<strong>${row.progress.toCheck}</strong>`}</td>
          </tr>`)}
        </tbody>
      </table></div>`;

  return sendPage(response, 200, page({
    title: showingClosed ? 'Closed requests' : 'Requests',
    practitioner,
    here: '/requests',
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>${showingClosed ? 'Closed requests' : 'Requests'}</h1>
          <p class="sub">${showingClosed
            ? 'Closed is a status, not a deletion — the record, the files and the client’s link all stay as they are.'
            : 'Each request is a short list of documents the client owes you, with a tick as each one arrives.'}</p>
        </div>
        <div class="do">
          ${showingClosed ? '' : html`<a class="btn primary" href="/requests/new">New request</a>`}
        </div>
      </div>
      ${seasonNotice?.length
        ? html`<p class="info"><strong>${seasonNotice.length}
            ${seasonNotice.length === 1 ? 'client is' : 'clients are'} due to be asked.</strong>
            Nothing is open for them, and you asked around this time of year last time —
            <a href="/ask-everyone?due=1">start the ask</a>. The list arrives with those clients ticked,
            and nothing is sent until you press it.</p>`
        : ''}
      <div class="bar">
        <div class="seg">
          <a href="${href({ closed: '' })}"${showingClosed ? '' : raw(' aria-current="page"')}>Open</a>
          <a href="${href({ closed: '1' })}"${showingClosed ? raw(' aria-current="page"') : ''}>closed (${closed})</a>
        </div>
        ${html`<form class="search" method="get" action="/requests">
              ${showingClosed ? html`<input type="hidden" name="closed" value="1">` : ''}
              ${wanted ? html`<input type="hidden" name="state" value="${wanted}">` : ''}
              ${sort !== 'state' ? html`<input type="hidden" name="sort" value="${sort}">` : ''}
              <input type="search" name="q" value="${query}" placeholder="Client, request or address"
                aria-label="Search requests">
              <button type="submit">Search</button>
              ${query
                ? html`<a class="clear" href="${href({ q: '' })}">Clear</a>`
                : ''}
            </form>`}
      </div>
      ${rows.length > 1 || wanted || query
        ? html`<p class="note">${rows.length} ${rows.length === 1 ? 'request' : 'requests'}${query
            ? html` matching “${query}”`
            : ''}${wanted ? html` · filtered to <a href="${href({ state: '' })}">everything</a>` : ''}
            ${showingClosed
              ? ''
              : html` · <a href="${href({ sort: sort === 'due' ? '' : 'due' })}">${sort === 'due' ? 'by whose turn it is' : 'by due date'}</a>
                  · <a href="${href({ sort: sort === 'client' ? '' : 'client' })}">${sort === 'client' ? 'by whose turn it is' : 'by client'}</a>`}
            · <a class="clear" href="/requests.csv${href({}).replace('/requests', '')}">Download as CSV</a>${showingClosed
              ? ''
              : html` · at the end of a season, <a href="/requests/close">close several at once</a>`}</p>`
        : html`<p class="note">${showingClosed
            ? ''
            : html`At the end of a season, <a href="/requests/close">close several at once</a>. `}Start the whole
            year from one list with <a href="/ask-everyone">ask everyone at once</a>.</p>`}
      ${showingClosed || all.length === 0
        ? ''
        : html`<div class="tiles">
            ${(counts['to-check'] ?? 0) > 0
              ? tile(counts['to-check'], 'with files to check', {
                  href: '/requests?state=to-check',
                  tone: 'attn',
                  current: wanted === 'to-check',
                })
              : ''}
            ${(counts.answered ?? 0) > 0
              ? tile(counts.answered, 'with an answer to read', {
                  href: '/requests?state=answered',
                  tone: 'attn',
                  current: wanted === 'answered',
                })
              : ''}
            ${tile(counts.waiting ?? 0, 'waiting on clients', {
              href: '/requests?state=waiting',
              current: wanted === 'waiting',
            })}
            ${tile(counts.ready ?? 0, 'ready to work on', {
              href: '/requests?state=ready',
              current: wanted === 'ready',
            })}
            ${tile(all.length, showingClosed ? 'closed in total' : 'open in total', { href: '/requests' })}
          </div>`}
      ${table}
      ${showingClosed || all.length === 0
        ? ''
        : html`<p class="note">Something missing? <a href="/chase">chase everyone outstanding</a> — everyone, in one list.</p>`}`,
  }));
}
/**
 * The form a request is made from.
 *
 * `clients` is the practice's existing names, offered as an autocomplete list rather than as a select
 * box. A datalist keeps the field free text — a new client is still typed, not created somewhere else
 * first — while making the names that already exist visible at the moment the match is decided. That is
 * where a typo becomes a duplicate client, so that is where the choice belongs.
 *
 * `forClient` is the client a request is definitely for, carried in a hidden field. Hidden rather than
 * inferred from the name on submit, because it was already decided on the previous page: re-deciding it
 * by matching a name would mean a rename here silently produced a second client.
 */
function requestForm({ error = null, values = {}, clients = [], forClient = null } = {}) {
  return html`
    <h1>New request</h1>
    ${error ? html`<p class="error">${error}</p>` : ''}
    <form method="post" action="/requests" class="card">
      ${forClient ? html`<input type="hidden" name="client_id" value="${forClient}">` : ''}
      <div class="field">
        <label for="client">Client</label>
        <input id="client" name="client" required value="${values.client ?? ''}"
          list="client-names" autocomplete="off">
        ${clients.length > 0
          ? html`<datalist id="client-names">
              ${clients.map((client) => html`<option value="${client.name}">${client.email ?? ''}</option>`)}
            </datalist>
            <p class="form-hint">One of the ${clients.length} this practice already has, or a new one.
            A name that matches an existing client is theirs — with their address on it.</p>`
          : ''}
      </div>
      <div class="field">
        <label for="client_email">Client email <span class="note">(optional, for the reminder text)</span></label>
        <input id="client_email" name="client_email" type="email" value="${values.client_email ?? ''}">
        <p class="form-hint">Saved on the client, so the chase uses it from now on — typing it here also
        fixes it for them.</p>
      </div>
      <div class="field">
        <label for="title">What is this for?</label>
        <input id="title" name="title" required value="${values.title ?? ''}" placeholder="2025 return">
      </div>
      <div class="field">
        <label for="due">Due <span class="note">(optional)</span></label>
        <input id="due" name="due" type="date" value="${values.due ?? ''}">
      </div>
      <div class="field">
        <label for="client_note">A note for your client <span class="note">(optional — shown at the top of their page)</span></label>
        <textarea id="client_note" name="client_note" rows="3" maxlength="2000"
          placeholder="Hi Sarah, here is the list for your 2026 corporate tax filing. Please upload these by Friday.">${values.client_note ?? ''}</textarea>
      </div>
      <div class="field">
        <label for="items">What do you need? <span class="note">one document per line</span></label>
        <textarea id="items" name="items" rows="8" required placeholder="Bank statements for all accounts, 2025&#10;Signed engagement letter&#10;Photo ID">${values.items ?? ''}</textarea>
      </div>
      <button type="submit" class="primary">Create the request</button>
    </form>`;
}

function newRequestForm({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;

  // Four ways in, and they compose:
  //
  // - `?from=<request id>` fills the form in from a request that already exists.
  // - `?for=<client id>` is "this is for them", so the client is filled in and carried.
  // - `?like=last` fills the checklist from that client's most recent request.
  // - `?template=<id>` fills the checklist and the note from a saved list.
  //
  // The first and the last are two versions of the same idea, and the difference is *where the list lives*.
  // Duplicating a request is right when the thing you are copying is one specific job; a template is right when
  // the list is the practice's standard and no single request is its home. Both fill the form in rather than
  // creating anything outright, so the practice sees and adjusts the list before it goes anywhere.
  //
  // What carries over is the title, the checklist and the note to the client — the note pre-filled rather
  // than dropped, because "please upload these by Friday" is usually still true next year and easier to edit
  // than to rewrite. The client does not carry over *from a request*: a duplicate exists for "next year" or
  // "another client with the same paperwork", and pre-filling last year's client is how a return goes to the
  // wrong person. Coming from a client's own page is the opposite case — there the client is the one thing
  // that is certainly right.
  const from = url?.searchParams?.get('from');
  const source = from ? requestFor(db, practiceId, from) : null;

  const forId = url?.searchParams?.get('for');
  const forClient = forId ? clientFor(db, practiceId, forId) : null;
  const likeLast = url?.searchParams?.get('like') === 'last';
  const previous = forClient && likeLast ? previousChecklistFor(db, practiceId, forClient.id) : null;

  const templateId = url?.searchParams?.get('template');
  const template = templateId ? templateFor(db, practiceId, templateId) : null;

  const clients = clientSummaries(db, practiceId).map((row) => ({ name: row.name, email: row.email }));

  const values = source
    ? {
        client: '',
        client_email: '',
        title: source.title,
        due: '',
        client_note: source.client_note ?? '',
        items: itemsOf(db, source.id)
          .filter((item) => !item.withdrawn)
          .map((item) => (item.note ? `${item.label} — ${item.note}` : item.label))
          .join('\n'),
      }
    : template
      ? {
          client: forClient?.name ?? '',
          client_email: forClient?.email ?? '',
          title: forClient ? '' : template.name,
          due: '',
          client_note: template.note ?? '',
          items: templateItemLines(template),
        }
      : forClient
        ? {
            client: forClient.name,
            client_email: forClient.email ?? '',
            title: previous?.title ?? '',
            items: (previous?.items ?? []).join('\n'),
          }
        : {};

  return sendPage(response, 200, page({
    title: 'New request',
    practitioner,
    here: source || forClient ? null : '/requests',
    banner: template
      ? html`<p class="note">Starting from <a href="/templates/${template.id}">${template.name}</a> —
          ${template.items.length} ${template.items.length === 1 ? 'document' : 'documents'} filled in below.
          Edit anything you like: the template itself is not changed, and nothing is created until you press the
          button.</p>`
      : source
      ? html`<p class="note">Duplicating <a href="/requests/${source.id}">${source.title}</a> — the
          checklist below is copied from it. Choose the client and, if you want one, a due date:
          nothing is created until you press the button, and the earlier request is not touched.</p>`
      : forClient
        ? html`<p class="note">For <a href="/clients/${forClient.id}">${forClient.name}</a> — the client
            is already chosen, so nothing here can file it against the wrong one.${previous && previous.items.length > 0
              ? html` Their last request's checklist is filled in below; change whatever is different
                  this year.`
              : ''}</p>`
        : null,
    body: requestForm({ values, clients, forClient: forClient?.id ?? null }),
  }));
}

async function createRequestPage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const clientName = field(fields, 'client');
  const clientEmail = field(fields, 'client_email');
  const carriedClientId = field(fields, 'client_id');
  const title = field(fields, 'title');
  const due = field(fields, 'due');
  const clientNote = field(fields, 'client_note')?.trim() || null;
  const rawItems = typeof fields.items === 'string' ? fields.items : '';
  const items = parseItems(rawItems);
  const values = {
    client: clientName ?? '',
    client_email: clientEmail ?? '',
    title: title ?? '',
    due: due ?? '',
    client_note: clientNote ?? '',
    items: rawItems,
  };

  // The client the form was opened for, if it came from a client's page and still belongs to this
  // practice. Scoped by practice like every other read, so a hand-edited hidden field cannot borrow
  // somebody else's client — it simply stops being found.
  const carried = carriedClientId ? clientFor(db, practiceId, carriedClientId) : null;

  const problem = !clientName
    ? 'A client is required.'
    : !title
      ? 'A title is required.'
      : items.length === 0
        ? 'At least one document is required, one per line.'
        : (clientNote?.length ?? 0) > 2000
          ? 'The note for your client is longer than 2000 characters. Shorten it, or put the detail on the documents themselves.'
          : null;

  const clients = clientSummaries(db, practiceId).map((row) => ({ name: row.name, email: row.email }));
  const render = (error) => sendPage(response, 400, page({
    title: 'New request',
    practitioner,
    body: requestForm({ error, values, clients, forClient: carried?.id ?? null }),
  }));

  if (problem) return render(problem);

  // Two ways a request gets its client, and the difference is deliberate. Arriving from a client's own
  // page, the client is already decided — so the row is used, and the name on the form is applied to it
  // as a correction (a typo noticed at the last moment). Typing a name on a blank form is a match: an
  // existing client of that name, or a new one.
  let clientId;
  if (carried) {
    if (clientName.length > 200) return render('That name is longer than 200 characters.');
    const clash = db
      .prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
      .get(practiceId, clientName, carried.id);
    if (clash) {
      return render(
        `There is already a client called ${clientName}. Rename one of them on the clients page — two records with one name is how a request ends up filed against the wrong one.`,
      );
    }
    updateClient(db, {
      practiceId,
      clientId: carried.id,
      name: clientName,
      email: clientEmail || carried.email,
    });
    clientId = carried.id;
  } else {
    clientId = findOrCreateClient(db, {
      practiceId,
      createdBy: practitioner.id,
      name: clientName,
      email: clientEmail,
    });
  }

  const requestId = createRequest(db, {
    practiceId,
    createdBy: practitioner.id,
    clientId,
    title,
    dueAt: due,
    items,
    clientNote,
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
  const emailed = new URL(request.url, 'http://localhost').searchParams.get('emailed');
  const justContacted = new URL(request.url, 'http://localhost').searchParams.get('contacted') === '1';
  const checkedCount = new URL(request.url, 'http://localhost').searchParams.get('checked');

  const allItems = itemsOf(db, found.id);
  const live = allItems.filter((item) => !item.withdrawn);
  const withdrawn = allItems.filter((item) => item.withdrawn);
  const links = tokensFor(db, found.id);
  const filesFor = new Map();
  const extras = [];
  for (const upload of uploadsOf(db, found.id)) {
    // Files the client sent that nobody asked for. They belong to the request and to no item, so they are
    // gathered separately rather than being filed against a checklist line they do not answer.
    if (upload.request_item_id === null) {
      extras.push(upload);
      continue;
    }
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
  // What the client wrote in their own words, so the practice sees it beside the documents rather than only
  // in a mail client. The history below shows it too; this is the part that is meant to be noticed.
  const messages = events.filter((event) => event.kind === 'client.messaged');
  // When this client was last in touch by any means, for the line in the chasing card: the question the practice
  // asks before pressing "Draft a reminder" is "have I already spoken to them?", and until 2v the page could not
  // answer it for a phone call.
  const lastContact = events
    .filter((event) => event.kind === 'reminder.sent' || event.kind === 'request.contacted')
    .map((event) => event.at)
    .sort()
    .at(-1) ?? null;

  // The confirmation line, when the practice has just arrived from a send. Two of them, because "we asked
  // for it" and "we chased them for it" are different acts and the page should say which just happened.
  const emailedNotice = emailed
    ? html`<p class="success"><strong>Request sent.</strong> Its identifier is <code>${emailed}</code> — if
        the client says it never arrived, this is what to quote to your mail provider. The link inside it
        works for 30 days and can be revoked from this page.</p>`
    : null;

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

  // The practice's own words about a document, and — behind a disclosure — the ability to correct them. A
  // disclosure rather than a second always-visible form: renaming is rare, and a row with three inputs in it
  // is a row nobody can read.
  const labelCell = (item) => html`
    <span class="cell-t">${item.label}</span>
    ${item.note ? html`<span class="cell-s">${item.note}</span>` : ''}
    ${found.closed_at
      ? ''
      : html`<details class="rename">
          <summary>Wrong words?</summary>
          <form method="post" action="/requests/${found.id}/items/${item.id}/relabel" class="stack">
            <input type="text" name="label" value="${item.label}" maxlength="200" required
              aria-label="What this document is called">
            <input type="text" name="note" value="${item.note ?? ''}" maxlength="500"
              placeholder="a note for the client (optional)" aria-label="A note for the client">
            <div class="row tight">
              <button type="submit">Save</button>
            </div>
            <span class="status"></span>
          </form>
        </details>`}`;

  const rows = live.map((item) => html`<tr>
    <td>${labelCell(item)}</td>
    <td>${item.needsAttention
      ? html`${badge('needs attention', TONES.wrong)}${item.attentionNote ? html`<span class="cell-s">${item.attentionNote}</span>` : ''}`
      : !item.received && item.clientSays
        ? html`${badge('client says:', TONES.waiting)}<span class="cell-s">${item.clientSays}</span>`
        : item.received
          ? item.checked
            ? badge('checked', TONES.done)
            : html`${badge('to check', TONES.todo)}<span class="cell-s">nobody has looked at this yet</span>`
          : badge('outstanding', TONES.waiting)}</td>
    <td>${filesOf(item).length === 0
      ? html`<span class="muted">—</span>`
      : filesOf(item).map((file) => html`<div class="file">
          <span class="name">${file.filename}</span>
          <span class="note">${file.uploaded_at.slice(0, 10)}</span>
          <button type="button" class="save" disabled
                  data-url="/requests/${found.id}/files/${file.id}"
                  data-name="${file.filename}">Save</button>
          <span class="status note"></span>
          ${file.client_note ? html`<div class="note">they said: ${file.client_note}</div>` : ''}
        </div>`)}</td>
    <td>${found.closed_at ? html`<span class="muted">closed</span>` : controlsFor(item)}</td>
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
    here: '/requests',
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a>${found.closed_at ? html` · closed` : ''}</p>
          <h1>${found.title}</h1>
          <p class="sub">For ${found.client_name}${found.due_at ? html` · needed by ${found.due_at}` : ''}${withdrawn.length > 0 ? html` · ${withdrawn.length} no longer asked for` : ''}</p>
        </div>
        <div class="do">
          ${found.closed_at || itemsOf(db, found.id).filter((item) => !item.withdrawn).length === 0
            ? ''
            : html`<form method="post" action="/requests/${found.id}/send" class="inline">
                <button type="submit" class="primary">Email this request</button>
              </form>`}
          <a class="btn" href="/requests/${found.id}/edit">Edit</a>
          <a class="btn" href="/requests/new?from=${found.id}">Duplicate</a>
        </div>
      </div>
      ${emailedNotice}
      ${checkedCount && /^\d+$/.test(checkedCount)
        ? html`<p class="success"><strong>${checkedCount} document${checkedCount === '1' ? '' : 's'} checked.</strong>
            Each one is recorded against the document it belongs to, so the history below says who looked at what and
            when — the same rows the per-document buttons write.</p>`
        : ''}
      ${justContacted
        ? html`<p class="success"><strong>Recorded.</strong> Nothing was sent — this is in the record, and it
            counts against your chase cadence, so the batch run will leave them alone until you would be back in
            touch anyway.</p>`
        : ''}
      ${found.client_note ? html`<div class="greeting">${found.client_note}</div>` : ''}
      ${sentNotice}
      <p class="count">${received} of ${live.length} received${found.due_at ? html`, due ${found.due_at}` : ''}${withdrawn.length > 0 ? html` · ${withdrawn.length} no longer asked for` : ''}.</p>
      ${found.closed_at
        ? html`<p class="info"><strong>Closed.</strong> Nothing has been deleted — the client’s link still
            works, and reopening puts it back on the list exactly as it was.</p>`
        : ''}
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
                to send twice.</p>
              <form method="post" action="/requests/${found.id}/check-all">
                <div class="actions">
                  <button type="submit" class="primary">Mark all ${progress.toCheck} as checked</button>
                </div>
                <p class="note">One press for the usual case: you downloaded them, read them, and they are fine.
                Each one is still checked off on its own in the record, exactly as the buttons beside it do. If a
                document needs sending again, use that button instead — checking it says somebody looked, and the
                flag is what keeps it outstanding.</p>
              </form>`
            : progress.state === 'answered'
              ? html`<p class="warning"><strong>The client has answered.</strong> ${progress.clientSaid}
                  ${progress.clientSaid === 1 ? 'document has' : 'documents have'} an answer from them —
                  see the list below. They are waiting on a decision: if the answer is fine, take the
                  document off the list; if it is not, that is a conversation rather than another
                  reminder.</p>`
              : progress.needsAttention > 0 && progress.received === progress.items
                ? html`<p class="warning"><strong>Waiting on a replacement.</strong> Everything asked for has
                    arrived, but ${progress.needsAttention} of them
                    ${progress.needsAttention === 1 ? 'is' : 'are'} going to be sent again — the list below says
                    which and why, and the client's page says the same. The next reminder asks for them.</p>`
                : html`<p class="note">Waiting on the client for ${progress.outstanding} of
                    ${progress.items} ${progress.items === 1 ? 'document' : 'documents'}.</p>`}
      ${attention.length > 0
        ? html`<p class="warning"><strong>${attention.length === 1 ? 'One document needs attention' : `${attention.length} documents need attention`}:</strong>
            ${attention.map((item) => item.label).join(', ')}. The client's page says what is wrong with
            each one, and the next reminder asks for them again.</p>`
        : ''}
      <p class="note"><a href="/requests/new?from=${found.id}">Duplicate this request</a> — the title and
      checklist are copied into a new draft; you choose the client and the due date. For next year,
      or for another client with the same paperwork.</p>
      ${live.length > 0
        ? html`<details class="rename">
            <summary>Keep this list for next time</summary>
            <form method="post" action="/requests/${found.id}/save-as-template" class="stack">
              <label for="template-name">What should the list be called?</label>
              <input id="template-name" name="name" maxlength="${MAX_TEMPLATE_NAME}" value="${found.title}">
              <div class="row tight"><button type="submit">Save as a template</button></div>
            </form>
            <p class="note">A template is a starting point you can use for one client or for everyone at once.
            It copies what is on this request now; the request itself is not changed, and changing the template
            later will not change this.</p>
          </details>`
        : ''}
      ${keys.length > 0 && received > 0
        ? html`<div class="unlock">
            <label for="passphrase">Your passphrase, to open what has arrived</label>
            <input id="passphrase" type="password" autocomplete="current-password">
            <button type="button" id="unlock">Unlock</button>
            <p id="unlock-status" class="note">It is used in this browser and sent nowhere. Unlocking
            keeps the keys in this tab so that saving several files does not mean typing it again.</p>
          </div>`
        : ''}
      <div class="scroll"><table class="items">
        <colgroup>
          <col class="c-doc"><col class="c-state"><col class="c-files"><col class="c-say">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Document</th>
            <th align="left">State</th>
            <th align="left">Files</th>
            <th align="left">What you can say</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${!found.closed_at
        ? html`<form method="post" action="/requests/${found.id}/items" class="card">
            <label for="new-items">Remembered something else? <span class="note">one document per line</span></label>
            <textarea id="new-items" name="items" rows="3" placeholder="The 2024 statements as well"></textarea>
            <button type="submit">Add to this request</button>
          </form>`
        : ''}
      ${withdrawn.length > 0
        ? html`<section class="card"><h2>No longer being asked for</h2>
            <ul>${withdrawn.map((item) => html`<li>${item.label}
              <form method="post" action="/requests/${found.id}/items/${item.id}/restore" class="inline">
                <button type="submit">Ask for it again</button>
              </form></li>`)}</ul>
            <p class="note">Withdrawn rather than deleted: the client's page stops asking, and the
            record keeps saying it was once asked for.</p></section>`
        : ''}
      <section class="card">
        <h2>The link for this client</h2>
        ${links.length === 0
          ? html`<p class="note">No link has been created yet. A link is how the client sends anything —
              they need no account, and it can be revoked at any time.</p>`
          : html`<ul class="plain">
              ${links.map((link) => html`<li>
                <span class="note">created ${link.created_at}, expires ${link.expires_at}</span>
                ${link.revoked_at
                  ? html` ${badge('revoked', TONES.done_for)}`
                  : html` <form method="post" action="/requests/${found.id}/revoke" class="inline">
                      <input type="hidden" name="token_id" value="${link.id}">
                      <button type="submit">Revoke</button>
                    </form>`}
              </li>`)}
            </ul>`}
        <form method="post" action="/requests/${found.id}/link" class="inline">
          <label for="days">A new link, valid for
            <select id="days" name="days">
              <option value="7">7 days</option>
              <option value="30" selected>30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <button type="submit">Create a link</button>
        </form>
      </section>
      <section class="card">
        <h2>Chasing this client</h2>
        ${outstanding.length > 0
          ? html`<p>${outstanding.length} still outstanding:
                ${outstanding.map((item) => item.label).join(', ')}.</p>
              <form method="post" action="/requests/${found.id}/remind" class="inline">
                <label for="remind-days">The reminder's link, valid for
                  <select id="remind-days" name="days">
                    <option value="7">7 days</option>
                    <option value="30" selected>30 days</option>
                    <option value="90">90 days</option>
                  </select>
                </label>
                <button type="submit">Draft a reminder</button>
              </form>`
          : html`<p><strong>Everything asked for has arrived.</strong> There is nothing to chase.</p>`}
        ${lastContact
          ? html`<p class="note">Last contact: ${agoWords(lastContact, now())}.</p>`
          : ''}

        <h3>Been in touch another way?</h3>
        <form method="post" action="/requests/${found.id}/contact" class="stack">
          <label for="contact-note">What happened? <span class="note">it goes in the record, and it is what stops the chase writing to them again</span></label>
          <input id="contact-note" name="note" maxlength="200" required
            placeholder="Phoned — Sarah says the statements are with the bank">
          <div class="row tight"><button type="submit">Record it</button></div>
        </form>
        <p class="note">A phone call, a letter, a conversation in the office — anything that is not an email from
        here. <strong>Nothing is sent and the client is not told:</strong> this is you making the record true, so the
        tool knows you have already spoken to them.</p>
      </section>
      ${messages.length > 0
        ? html`<section class="card">
            <h2>In the client's own words</h2>
            <p class="note">Written on their page, and kept with this request. Nothing here needs answering
            through this tool — it is here so the reason a document is late is beside the documents.</p>
            ${messages.map((event) => html`<div class="said">
              <p class="note"><span class="when">${event.at}</span></p>
              <p>${event.detail}</p>
            </div>`)}
          </section>`
        : ''}
      ${extras.length > 0
        ? html`<section class="card">
            <h2>Sent without being asked</h2>
            <p class="note">Files the client sent that are not on the checklist. They are encrypted the same
            way as everything else, and they answer nothing — so they do not count toward what is outstanding.</p>
            <div class="scroll"><table>
              <thead><tr><th align="left">File</th><th align="left">Arrived</th><th align="left">Open</th></tr></thead>
              <tbody>
                ${extras.map((upload) => html`<tr>
                  <td><span class="cell-t">${upload.filename}</span>
                    ${upload.client_note ? html`<span class="cell-s">${upload.client_note}</span>` : ''}</td>
                  <td class="note">${upload.uploaded_at}</td>
                  <td><a class="btn sm" href="/requests/${found.id}/files/${upload.id}">Download</a></td>
                </tr>`)}
              </tbody>
            </table></div>
          </section>`
        : ''}
      <section class="card">
        <h2>What has happened</h2>
        <ul class="plain">
          ${events.map((event) => html`<li><code>${event.kind}</code> <span class="note">${event.at}${event.detail ? ` — ${event.detail}` : ''}</span></li>`)}
        </ul>
      </section>
      <section class="card">
        <h2>The file itself</h2>
        ${found.closed_at
          ? html`<p>Closed ${found.closed_at}. It stays on the list of closed requests, and
                nothing has been deleted.</p>
              <div class="actions">
                <form method="post" action="/requests/${found.id}/reopen"><button type="submit">Reopen it</button></form>
              </div>`
          : html`<p class="note">Closing is a status, not a deletion: the record, the files and the
                client's link all stay exactly as they are.</p>
              <div class="actions">
                <form method="post" action="/requests/${found.id}/close"><button type="submit">Close this request</button></form>
              </div>`}
      </section>
      ${received > 0 && !holdsKey(practitioner.role)
        ? html`<p class="note"><strong>${received} ${received === 1 ? 'document has' : 'documents have'} arrived,
            and you cannot open ${received === 1 ? 'it' : 'them'}.</strong> Your role holds no copy of the
            practice key, so nothing here decrypts for you — that is what the role means rather than a
            setting somebody chose. An owner can make you a copy; it needs a passphrase from you, and it
            takes a moment on the members page.</p>`
        : ''}
      ${keys.length > 0 ? jsonTag('key-records', { keys: keys.map((key) => ({ id: key.id, wrapped: key.wrappedPrivateKey })) }) : ''}
      ${received > 0 && holdsKey(practitioner.role) ? raw('<script type="module" src="/assets/download.js"></script>') : ''}`,
  }));
}

/**
 * The board as a spreadsheet.
 *
 * This exists because of what the request actually is: an accountant reconciling a season works in a
 * spreadsheet, and a page that cannot be got out of the tool is a page they retype. It honours the same
 * filters as the page it comes from — same tab, same state, same search — because an export that ignores
 * the filter somebody just applied is an export they have to filter again by hand.
 *
 * What it carries is deliberately not everything: the counts that answer "what is outstanding" and the
 * dates that answer "what is late", in the order the screen shows them. Not the client's documents, not
 * the history, not anything the practice would not want in a file they might email to a colleague.
 */
function requestsCsv({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const showingClosed = url.searchParams.get('closed') === '1';
  const wanted = url.searchParams.get('state');
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const sort = url.searchParams.get('sort') ?? 'state';

  const rows = requestsFor(db, practiceId, { scope: showingClosed ? 'closed' : 'open' })
    .filter((row) => !wanted || row.progress.state === wanted)
    .filter((row) =>
      query
        ? [row.client_name, row.title, row.client_email ?? ''].join(' ').toLowerCase().includes(query)
        : true,
    )
    .sort(REQUEST_ORDERS[sort] ?? REQUEST_ORDERS.state)
    .map((row) => [
      row.client_name,
      row.client_email ?? '',
      row.title,
      REQUEST_STATE_WORDS[row.progress.state] ?? row.progress.state,
      row.progress.items,
      row.progress.received,
      row.progress.outstanding,
      row.progress.toCheck,
      row.due_at ?? '',
      row.created_at.slice(0, 10),
      row.closed_at ? row.closed_at.slice(0, 10) : '',
    ]);

  return sendCsv(response, showingClosed ? 'tickmark-closed-requests.csv' : 'tickmark-requests.csv', [
    ['Client', 'Address', 'Request', 'State', 'Documents', 'Received', 'Outstanding', 'To check', 'Due', 'Asked', 'Closed'],
    ...rows,
  ]);
}

// ---------------------------------------------------------------------------------
// Asking everyone at once
// ---------------------------------------------------------------------------------

/**
 * The one action that makes fifty clients possible.
 *
 * The research this product was built from is blunt about where a practice breaks: *manual tracking breaks
 * down past 50 clients*, and a season's document-gathering is 150–175 hours of following up. Built one at a
 * time, sending the same standard request to sixty clients is an afternoon of typing — which is how firms
 * quietly stop doing it, and why the incumbents sell "bulk send" as a headline feature.
 *
 * Three rules, and they are the chase's three, because a second set of rules for the same job is a second
 * chance to get it wrong:
 *
 * 1. **The page is the preview.** Every client is listed with whether they can be written to and why not, so
 *    nothing happens that the practice did not see first. That is why there is no "are you sure?" step.
 * 2. **A failure never stops the run and is never hidden.** One dead mailbox must not stop the other fifty.
 * 3. **The run bounds itself in time**, and says where it stopped. Requests it did not reach exist, with their
 *    links issued, and can be sent individually from their own pages — nothing is lost, it is only late.
 *
 * What it deliberately does not do: merge clients, or guess who *should* get a list. The practice ticks names.
 */
function askEveryonePage({ db, response, practitioner, practiceId, url, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;
  const templates = templatesOf(db, practiceId);
  const clients = clientsForBulkSend(db, practiceId);
  const reachable = clients.filter((client) => client.email);
  const chosen = templateFor(db, practiceId, url.searchParams.get('template') ?? '');

  // Arriving from the "due to be asked" list, those clients are ticked already. The page is still the preview —
  // every name and address is on it, and the counting is done by a person — but the sixty ticks a season-start
  // needs have been made by the software, which is the whole point of having worked out who is due.
  const dueIds = url.searchParams.get('due') === '1'
    ? new Set(clientsDueForAsking(db, practiceId, { timezone: practiceFor(db, practiceId).timezone }).map((row) => row.id))
    : new Set();
  const dueReachable = clients.filter((client) => dueIds.has(client.id) && client.email).length;

  return sendPage(response, 200, page({
    title: 'Ask everyone at once',
    practitioner,
    here: '/templates',
    // Two notices, both of them true, so both are shown: a page with no mail server still needs to say who is
    // ticked and why, and a page full of ticked clients still needs to say that nothing can be sent.
    banner: html`
      ${!mailer
        ? html`<p class="warning"><strong>This installation has no mail server configured</strong>, so nothing can
            be sent from here. The requests would be made, but not delivered — see
            <a href="/admin/test-email">the mail test page</a>.</p>`
        : ''}
      ${dueReachable > 0
        ? html`<p class="info"><strong>${dueReachable}
            ${dueReachable === 1 ? 'client is' : 'clients are'} ticked because the year has come round</strong> —
            nothing is open for them and they were last asked in this month of an earlier year. Untick anybody you
            do not want to write to; nothing is sent until you press the button.</p>`
        : ''}`,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/templates">Templates</a></p>
          <h1>Ask everyone at once</h1>
          <p class="sub">One list, one deadline, one action — a request per client, each with its own link, all sent
          while you get on with something else.</p>
        </div>
      </div>

      ${templates.length === 0
        ? empty(
            'No template to send',
            'This works from a saved list, so that sixty clients are asked for the same set of documents rather than sixty slightly different ones.',
            html`<a class="btn primary" href="/templates">Make a template</a>`,
          )
        : reachable.length === 0
          ? empty(
              'No client can be emailed yet',
              'Every client on your list is missing an email address, and this action is entirely about writing to people.',
              html`<a class="btn primary" href="/clients">Go to clients</a>`,
            )
          : html`<form method="post" action="/ask-everyone" class="card">
              <h2>The list and the deadline</h2>
              <label for="template_id">Which list?</label>
              <select id="template_id" name="template_id" required>
                ${templates.map((template) => html`<option value="${template.id}"${chosen?.id === template.id ? ' selected' : ''}>${template.name} (${template.item_count} documents)</option>`)}
              </select>

              <label for="title">What is it for?</label>
              <input id="title" name="title" maxlength="200" required
                value="${chosen ? chosen.name : ''}" placeholder="2026 tax return">

              <div class="row">
                <div class="grow">
                  <label for="due">Needed by <span class="note">(optional)</span></label>
                  <input id="due" name="due" type="date">
                </div>
                <div class="grow">
                  <label for="days">The link works for</label>
                  <select id="days" name="days">
                    <option value="30">30 days</option>
                    <option value="60" selected>60 days</option>
                    <option value="120">120 days</option>
                    <option value="365">a year</option>
                  </select>
                </div>
              </div>

              <label for="client_note">A note for all of them <span class="note">(optional — it appears at the top of each client's page)</span></label>
              <textarea id="client_note" name="client_note" rows="3"
                placeholder="Here is the list for your 2026 filing. Please send these by the end of the month.">${chosen?.note ?? ''}</textarea>
              <p class="note">The same words go to everyone, so leave out anything only true of one client — any
              request can be edited afterwards.</p>

              <h2>Who to ask</h2>
              <p class="note">${reachable.length} of ${clients.length}
                ${clients.length === 1 ? 'client' : 'clients'} can be emailed.</p>
              <div class="pick">
                ${clients.map((client) => html`<label class="${client.email ? '' : 'off'}">
                  <input type="checkbox" name="client_id" value="${client.id}"${client.email ? '' : raw(' disabled')}${dueIds.has(client.id) ? raw(' checked') : ''}>
                  <span>
                    <span class="what">${client.name}</span>
                    <span class="who">${client.email
                      ? html`${client.email}${client.open_requests > 0 ? html` · ${client.open_requests} already open` : ''}${dueIds.has(client.id) ? html` · due for this year’s ask` : ''}`
                      : html`no email address — add one on their page first`}</span>
                  </span>
                </label>`)}
              </div>

              <div class="actions">
                <button type="submit" class="primary">Ask the ticked clients</button>
                ${mailer ? html`<button type="submit" name="everyone" value="1">Ask everyone who can be emailed</button>` : ''}
                <a class="btn ghost" href="/requests">Cancel</a>
              </div>
            </form>`}
    `,
  }));
}

/**
 * Make a request for each chosen client and send each one its own link.
 *
 * **Creation and sending are separated on purpose.** Making sixty requests is a fast database operation that
 * either happens or does not; sending sixty emails is sixty network round-trips, any of which can hang. Done
 * interleaved, a run that died at the thirtieth client would leave thirty clients in a state nobody could
 * describe. So every request exists before the first email is attempted, the run bounds itself in time, and
 * what it did not reach is reported as unsent *and finishable* rather than as lost.
 */
async function askEveryone({ db, request, response, practitioner, practiceId, mailer, chaseBudgetMs = CHASE_BUDGET_MS }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));

  const template = templateFor(db, practiceId, field(fields, 'template_id') ?? '');
  const title = (field(fields, 'title') ?? '').trim();
  const due = (field(fields, 'due') ?? '').trim();
  const clientNote = (field(fields, 'client_note') ?? '').trim() || null;
  const days = Math.min(Math.max(Number(field(fields, 'days', '60')) || 60, 1), 365);

  if (!template) return fail(response, 400, 'Pick the list to send.', practitioner);
  if (template.items.length === 0) {
    return fail(response, 400, `${template.name} has no documents on it, so there would be nothing to ask for.`, practitioner);
  }
  if (title.length === 0) {
    return fail(response, 400, 'A title is required — it is what the client sees at the top of their page.', practitioner);
  }
  if (title.length > 200) return fail(response, 400, 'That title is longer than 200 characters.', practitioner);
  if ((clientNote?.length ?? 0) > 2000) {
    return fail(response, 400, 'That note is longer than 2000 characters.', practitioner);
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return fail(response, 400, 'That due date is not a date a browser would send.', practitioner);
  }

  // Who was asked for. The second button means exactly what it says — everyone who can be emailed — and both
  // paths end at the same list, so there is one thing to reason about afterwards.
  const all = clientsForBulkSend(db, practiceId);
  const asked = field(fields, 'everyone') === '1';
  const ticked = Array.isArray(fields.client_id) ? fields.client_id : fields.client_id ? [fields.client_id] : [];
  const wanted = asked
    ? all.filter((client) => client.email)
    : all.filter((client) => ticked.includes(client.id) && client.email);

  // Who could not be written to. When the practice ticked names, it is the ticked ones without an address; when
  // they asked for everyone, it is *every* client without one — because an "ask everyone" that quietly skips the
  // people it cannot reach is the exact omission this page exists to prevent, and the report has to name them for
  // the practice to be able to go and fix it.
  const withoutAddress = all.filter((client) => !client.email && (asked || ticked.includes(client.id)));
  if (wanted.length === 0) {
    return fail(
      response,
      400,
      ticked.length === 0
        ? 'Tick at least one client, or use the button that asks everyone who can be emailed.'
        : 'Every client you ticked is missing an email address, so there is nowhere to send to.',
      practitioner,
    );
  }
  if (!mailer) {
    return fail(
      response,
      400,
      'This installation has no mail server configured, so there is nothing this could send. Nothing was made — the requests would exist with nobody told about them.',
      practitioner,
    );
  }
  const items = template.items.map((item) => item.label);
  const origin = originOf(request);
  const practiceName = practiceFor(db, practiceId).name;

  // Every request first, each with its own link issued here rather than inside the send loop: a request that was
  // made is then one its client can already use, whatever the email does.
  const made = wanted.map((client) => {
    const requestId = createRequest(db, {
      practiceId,
      createdBy: practitioner.id,
      clientId: client.id,
      title,
      dueAt: due || null,
      clientNote,
      items,
    });
    const token = newToken();
    issueToken(db, {
      requestId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
    });

    // The template's per-document notes, which `createRequest` takes only labels for — carried here so a list
    // that says "the 2025 statement, not the 2024 one" goes on saying it on all sixty requests.
    const fresh = itemsOf(db, requestId);
    for (const [index, item] of template.items.entries()) {
      if (item.note && fresh[index]) {
        db.prepare('UPDATE request_item SET note = ? WHERE id = ?').run(item.note, fresh[index].id);
      }
    }

    return { client, requestId, token };
  });

  const results = [];
  const startedAt = Date.now();
  for (const [index, row] of made.entries()) {
    if (Date.now() - startedAt > chaseBudgetMs) {
      for (const rest of made.slice(index)) results.push({ row: rest, outcome: 'not-attempted' });
      break;
    }
    results.push(
      await sendOneOpening(db, row, { origin, title, dueAt: due || null, clientNote, items }, mailer, practiceName),
    );
  }

  return sendPage(response, 200, askEveryoneReportPage({
    practitioner,
    template,
    title,
    results,
    withoutAddress,
    elapsedMs: Date.now() - startedAt,
  }));
}

/**
 * One client's opening ask, sent.
 *
 * It goes through `openingDraft` — the same wording the single-request page drafts — so "here is what we need"
 * has exactly one home, and a practice that improves it improves it on every request rather than on most.
 */
async function sendOneOpening(db, { client, requestId, token }, { origin, title, dueAt, clientNote, items }, mailer, practiceName) {
  const message = openingDraft({
    clientName: client.name,
    title,
    dueAt,
    items,
    note: clientNote,
    link: `${origin}/r/${token}`,
    practiceName,
  });

  try {
    const { messageId } = await sendMail(mailer, { to: client.email, subject: message.subject, body: message.body });
    recordEvent(db, { requestId, kind: 'request.sent', detail: `${client.email} — ${messageId}` });
    return { row: { client, requestId }, outcome: 'sent', to: client.email, messageId };
  } catch (error) {
    // Recorded against the request it belongs to, so that client's history says the ask failed rather than
    // showing nothing ever happened.
    recordEvent(db, { requestId, kind: 'reminder.failed', detail: `opening ask: ${error.message}` });
    return { row: { client, requestId }, outcome: 'failed', to: client.email, error: error.message };
  }
}

/**
 * What happened, per client, for the bulk ask.
 *
 * The same shape as the chase's report and for the same reason: a bulk action whose result is "done" teaches a
 * practice to distrust it, and the first time a message quietly did not arrive they would go back to sending
 * them one at a time — which is the whole thing this feature exists to stop.
 *
 * The row for a request that was not reached says the important part out loud: **it exists.** Its link works,
 * its client is simply not holding it yet, and it can be sent from its own page.
 */
function askEveryoneReportPage({ practitioner, template, title, results, withoutAddress, elapsedMs }) {
  const sent = results.filter((entry) => entry.outcome === 'sent');
  const failed = results.filter((entry) => entry.outcome === 'failed');
  const later = results.filter((entry) => entry.outcome === 'not-attempted');
  const seconds = Math.round(elapsedMs / 1000);

  const outcomeOf = (entry) => (entry.outcome === 'sent'
    ? html`<strong>sent</strong> <span class="note">${entry.messageId}</span>`
    : entry.outcome === 'failed'
      ? html`<strong class="error">not sent</strong> <span class="note">${entry.error}</span>`
      : html`<span class="note">not sent — the run was out of time</span>`);

  return page({
    title: 'What happened',
    practitioner,
    here: '/templates',
    banner: later.length > 0
      ? html`<p class="warning"><strong>${later.length}
          ${later.length === 1 ? 'request was' : 'requests were'} made but not emailed</strong>, because the run
          reached its time budget. Nothing is lost: each one exists, its link works, and you can send it from the
          request itself — or leave it, and the chase will include it.</p>`
      : null,
    body: html`
      <h1>${results.length} ${results.length === 1 ? 'client' : 'clients'} asked</h1>
      <p>“${title}” from <strong>${template.name}</strong> — ${sent.length} sent, ${failed.length} failed,
      ${later.length} not sent${withoutAddress.length > 0
        ? html`, ${withoutAddress.length} with no email address`
        : ''} in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.</p>

      ${failed.length > 0
        ? html`<p class="error"><strong>${failed.length}
            ${failed.length === 1 ? 'message was' : 'messages were'} not sent.</strong> The request exists and its
            link works, so the client can still be given it — open the request and use “Email this request”, or
            reply to the failure in your mail server's log first.</p>`
        : ''}
      ${withoutAddress.length > 0
        ? html`<p class="note"><strong>${withoutAddress.length}
            ${withoutAddress.length === 1 ? 'client was' : 'clients were'} not asked</strong> because they have no
            email address. Nothing was made for them: ${withoutAddress
              .map((client) => client.name)
              .join(', ')} — add an address on <a href="/clients">the clients page</a> and ask again.</p>`
        : ''}

      <div class="scroll"><table>
        <colgroup><col style="width:26%"><col style="width:32%"><col style="width:42%"></colgroup>
        <thead><tr><th align="left">Client</th><th align="left">Request</th><th align="left">Outcome</th></tr></thead>
        <tbody>
          ${results.map((entry) => html`<tr>
            <td><span class="cell-t">${entry.row.client.name}</span></td>
            <td><a href="/requests/${entry.row.requestId}">${title}</a></td>
            <td>${outcomeOf(entry)}</td>
          </tr>`)}
          ${withoutAddress.map((client) => html`<tr>
            <td><span class="cell-t">${client.name}</span></td>
            <td><span class="muted">—</span></td>
            <td>${badge('no email address on this client', TONES.wrong)}</td>
          </tr>`)}
        </tbody>
      </table></div>

      <p class="note"><a href="/requests">Back to the board</a> &middot;
      <a href="/templates">Templates</a> &middot; <a href="/chase">the chase list</a></p>`,
  });
}

// ---------------------------------------------------------------------------------
// Templates — the lists a practice uses every year
// ---------------------------------------------------------------------------------

const MAX_TEMPLATE_NAME = 120;

/**
 * Every request in this product used to be built from nothing, which is fine the first time and absurd the
 * fifty-first: the same forty document names, typed again, for the fifty-first client.
 *
 * A template is that list given a name and kept. It is a *starting point* rather than a record — a request
 * copies its items at the moment it is made, and nothing ever refers back — which is why this is the one
 * thing in the product that can be deleted outright. Deleting a template discards a draft; it cannot change
 * what any client was ever asked for.
 *
 * Templates are made here, or from a request that already has the right list on it, which is how the first
 * one usually appears: nobody retypes forty lines in order to stop retyping forty lines.
 */
function templatesPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const templates = templatesOf(db, practiceId);
  const made = url.searchParams.get('made');
  const removed = url.searchParams.get('removed');
  const reachable = clientSummaries(db, practiceId).filter((client) => client.email).length;

  return sendPage(response, 200, page({
    title: 'Templates',
    practitioner,
    here: '/templates',
    banner: made
      ? html`<p class="success"><strong>Saved.</strong> Use it for one client, or ask everyone at once.</p>`
      : removed
        ? html`<p class="success"><strong>Deleted.</strong> Requests already made from it are untouched — they
            copied what they needed at the time.</p>`
        : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a></p>
          <h1>Lists you use again</h1>
          <p class="sub">A checklist kept under a name, so the same request is not typed out for every client.</p>
        </div>
        <div class="do">
          ${reachable > 0
            ? html`<a class="btn primary" href="/ask-everyone">Ask everyone at once</a>`
            : html`<a class="btn" href="/clients">Add a client first</a>`}
        </div>
      </div>

      ${templates.length === 0
        ? empty('No templates yet', 'Make one below — or open a request and save its list, which is less typing if the list already exists.')
        : html`<div class="scroll"><table>
            <thead><tr>
              <th style="width: 34%">Name</th>
              <th style="width: 10%">Documents</th>
              <th style="width: 30%">Standing note</th>
              <th class="num" style="width: 26%">Use it</th>
            </tr></thead>
            <tbody>
              ${templates.map((template) => html`<tr>
                <td><a class="cell-t" href="/templates/${template.id}">${template.name}</a></td>
                <td><span class="badge off">${template.item_count}</span></td>
                <td>${template.note ? html`<span class="cell-s">${template.note}</span>` : html`<span class="muted">—</span>`}</td>
                <td class="num">
                  <a class="btn sm" href="/requests/new?template=${template.id}">One client</a>
                  <a class="btn sm" href="/ask-everyone?template=${template.id}">Everyone</a>
                </td>
              </tr>`)}
            </tbody>
          </table></div>`}

      ${section('Save a new list', html`
        <form method="post" action="/templates" class="card">
          <label for="name">What is it called?</label>
          <input id="name" name="name" maxlength="${MAX_TEMPLATE_NAME}" required
            placeholder="Sole trader — annual accounts">
          <label for="items">The documents, one per line</label>
          <textarea id="items" name="items" rows="8" required
            placeholder="Photo ID&#10;Bank statements, all accounts&#10;Last year's return"></textarea>
          <label for="note">A standing note to the client <span class="note">(optional — editable per client)</span></label>
          <input id="note" name="note" maxlength="2000" placeholder="Please send these by the end of the month.">
          <div class="actions"><button type="submit" class="primary">Save this list</button></div>
        </form>`)}
    `,
  }));
}

/** Make a template from a typed list. */
async function createTemplatePage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const name = (field(fields, 'name') ?? '').trim();
  const note = (field(fields, 'note') ?? '').trim() || null;
  const items = parseItems(field(fields, 'items') ?? '');

  if (name.length === 0) return fail(response, 400, 'A template needs a name so it can be found again.', practitioner);
  if (name.length > MAX_TEMPLATE_NAME) {
    return fail(response, 400, `That name is longer than ${MAX_TEMPLATE_NAME} characters.`, practitioner);
  }
  if (items.length === 0) return fail(response, 400, 'A template needs at least one document, one per line.', practitioner);

  const id = createTemplate(db, { practiceId, createdBy: practitioner.id, name, note, items });
  return redirect(response, `/templates/${id}`);
}

/** One template: what is on it, what it is called, and how to get rid of it. */
function templatePage({ db, response, practitioner, practiceId, params, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = templateFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no list at that address.', practitioner);
  const added = url.searchParams.get('added');
  const reachable = clientSummaries(db, practiceId).filter((client) => client.email).length;

  return sendPage(response, 200, page({
    title: found.name,
    practitioner,
    here: '/templates',
    banner: added === null
      ? null
      : added === '0'
        ? html`<p class="warning">Everything on that list was already on this one, so nothing was added.</p>`
        : html`<p class="success">${added} ${added === '1' ? 'document' : 'documents'} added.</p>`,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/templates">Templates</a></p>
          <h1>${found.name}</h1>
          <p class="sub">${found.items.length}
            ${found.items.length === 1 ? 'document' : 'documents'}, kept to be used again</p>
        </div>
        <div class="do">
          <a class="btn" href="/requests/new?template=${found.id}">Use for one client</a>
          ${reachable > 0 ? html`<a class="btn primary" href="/ask-everyone?template=${found.id}">Ask everyone</a>` : ''}
        </div>
      </div>

      ${section('What it asks for', html`
        ${found.items.length === 0
          ? empty('Nothing on it yet', 'Add the documents below, one per line.')
          : html`<div class="scroll"><table>
              <thead><tr><th style="width: 78%">Document</th><th class="num" style="width: 22%">Remove</th></tr></thead>
              <tbody>
                ${found.items.map((item) => html`<tr>
                  <td><span class="cell-t">${item.label}</span>${item.note ? html`<span class="cell-s">${item.note}</span>` : ''}</td>
                  <td class="num">
                    <form method="post" action="/templates/${found.id}/items/${item.id}/remove" class="inline">
                      <button type="submit" class="sm danger">Remove</button>
                    </form>
                  </td>
                </tr>`)}
              </tbody>
            </table></div>`}
        <form method="post" action="/templates/${found.id}/items" class="stack">
          <label for="items">Add documents, one per line</label>
          <textarea id="items" name="items" rows="4" placeholder="Payroll summary&#10;VAT returns"></textarea>
          <div class="actions"><button type="submit">Add them</button></div>
        </form>`)}

      ${section('Its name and standing note', html`
        <form method="post" action="/templates/${found.id}">
          <label for="name">Name</label>
          <input id="name" name="name" value="${found.name}" maxlength="${MAX_TEMPLATE_NAME}" required>
          <label for="note">A standing note to the client <span class="note">(a starting point, editable per client)</span></label>
          <input id="note" name="note" value="${found.note ?? ''}" maxlength="2000"
            placeholder="Please send these by the end of the month.">
          <div class="actions"><button type="submit" class="primary">Save</button></div>
        </form>
        <form method="post" action="/templates/${found.id}/delete">
          <p class="note">Deleting a template does not touch a single request made from it — those copied what
          they needed when they were made.</p>
          <div class="actions"><button type="submit" class="danger">Delete this template</button></div>
        </form>`)}
    `,
  }));
}

/** Rename a template, or change its standing note. */
async function saveTemplate({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = templateFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no list at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const name = (field(fields, 'name') ?? '').trim();
  if (name.length === 0) return fail(response, 400, 'A template needs a name.', practitioner);
  if (name.length > MAX_TEMPLATE_NAME) {
    return fail(response, 400, `That name is longer than ${MAX_TEMPLATE_NAME} characters.`, practitioner);
  }
  if ((field(fields, 'note') ?? '').length > 2000) {
    return fail(response, 400, 'That note is longer than 2000 characters.', practitioner);
  }

  renameTemplate(db, practiceId, found.id, { name, note: field(fields, 'note') ?? '' });
  return redirect(response, `/templates/${found.id}`);
}

/** Grow a template's list. */
async function addTemplateItemsPage({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = templateFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no list at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const labels = parseItems(field(fields, 'items') ?? '');
  const added = addTemplateItems(db, { templateId: found.id, labels });
  return redirect(response, `/templates/${found.id}?added=${added}`);
}

/** Take one document off a template. The row goes; nothing points at it. */
function removeTemplateItemPage({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  if (!removeTemplateItem(db, practiceId, params[0], params[1])) {
    return fail(response, 404, 'There is no such document on that list.', practitioner);
  }
  return redirect(response, `/templates/${params[0]}`);
}

/** Delete a template outright — the one place in the product that really removes a row. */
function deleteTemplatePage({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  if (!deleteTemplate(db, practiceId, params[0])) {
    return fail(response, 404, 'There is no list at that address.', practitioner);
  }
  return redirect(response, '/templates?removed=1');
}

/**
 * Save the list already on a request as a template.
 *
 * This is how the first template usually appears. A practice that has just built a good checklist by hand has
 * no reason to type it out again in another page, and a template that has to be retyped is a template nobody
 * makes.
 */
async function saveAsTemplate({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const items = itemsOf(db, found.id).filter((item) => !item.withdrawn);
  if (items.length === 0) {
    return fail(response, 400, 'There is nothing on this request to save.', practitioner);
  }

  const fields = formFields(await readBody(request));
  const typed = (field(fields, 'name') ?? '').trim();
  const id = createTemplate(db, {
    practiceId,
    createdBy: practitioner.id,
    // The request's own title is the obvious name, and it is what the practice would have typed anyway.
    name: (typed || found.title).slice(0, MAX_TEMPLATE_NAME),
    note: found.client_note,
    items: items.map((item) => item.label),
  });

  // The notes on individual documents come across too — they are as much a part of the list as the labels are,
  // and a template that quietly dropped them would ask for the right documents with none of the guidance.
  for (const item of items) {
    if (!item.note) continue;
    const made = templateItemsOf(db, id).find((row) => row.label === item.label);
    if (made) db.prepare('UPDATE template_item SET note = ? WHERE id = ?').run(item.note, made.id);
  }

  return redirect(response, `/templates/${id}?made=1`);
}

/**
 * Closing a season, rather than one request at a time.
 *
 * Everything else in this product can be done in a batch — chase everyone, filter the board, export the list —
 * and closing was the last one-at-a-time operation in the year's cycle, which is exactly the moment when there
 * are forty of them and no patience left.
 *
 * **The software suggests; the practice decides.** The ones with nothing outstanding are ticked already,
 * because a request where every document has arrived and been checked is finished by the product's own
 * definition. The rest are listed unticked with what is still missing, because "close the year" is not the
 * same as "abandon what is outstanding" and the difference should be a deliberate tick rather than a
 * side-effect of pressing a button.
 */
function closeSeveralPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const open = requestsFor(db, practiceId, { scope: 'open' });
  const finished = open.filter((row) => row.progress.state === 'ready');
  const rest = open.filter((row) => row.progress.state !== 'ready');
  const justClosed = url.searchParams.get('closed');
  const nothingDone = url.searchParams.get('nothing') === '1';

  const pick = (row) => html`<label>
    <input type="checkbox" name="request_id" value="${row.id}"${row.progress.state === 'ready' ? ' checked' : ''}>
    <span>
      <span class="what">${row.title}</span>
      <span class="who">${row.client_name} · ${badge(
        REQUEST_STATE_WORDS[row.progress.state],
        stateTone(row.progress.state),
      )}${
        row.progress.state === 'ready'
          ? ''
          : html` ${row.progress.outstanding} still outstanding, ${row.progress.toCheck} to check`
      }</span>
    </span>
  </label>`;

  return sendPage(response, 200, page({
    title: 'Close several requests',
    practitioner,
    here: '/requests',
    banner: justClosed
      ? html`<p class="success"><strong>${justClosed} closed.</strong> Nothing was deleted — they are on the
          closed tab, the clients' links still work, and any of them can be reopened from its own page.</p>`
      : nothingDone
        ? html`<p class="warning"><strong>Nothing was ticked</strong>, so nothing was closed. That is worth
            saying rather than doing something surprising.</p>`
        : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a></p>
          <h1>Close several at once</h1>
          <p class="sub">The end of a season, done in one go. Closing is a status, not a deletion: the record,
          the files and each client's link all stay exactly as they are.</p>
        </div>
      </div>
      ${open.length === 0
        ? empty('Nothing is open', 'Every request is already closed.', html`<a class="btn" href="/requests">Back to the board</a>`)
        : html`<form method="post" action="/requests/close" class="card">
            <h2>Tick the ones that are finished</h2>
            ${finished.length > 0
              ? html`<p class="note">${finished.length}
                  ${finished.length === 1 ? 'request has' : 'requests have'} nothing outstanding, so
                  ${finished.length === 1 ? 'it is' : 'they are'} ticked already.</p>`
              : ''}
            <div class="pick">${finished.map(pick)}</div>
            ${rest.length > 0
              ? html`<h3>Still owed something</h3>
                  <p class="note">Closing these stops the chase for them. If a document is on its way, leave
                  the request open — it can always be closed later.</p>
                  <div class="pick">${rest.map(pick)}</div>`
              : ''}
            <div class="actions">
              <button type="submit" class="primary">Close the ticked requests</button>
              <a class="btn ghost" href="/requests">Cancel</a>
            </div>
          </form>`}`,
  }));
}

/** Close whichever requests were ticked, and report how many rather than doing it quietly. */
async function closeSeveral({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const ticked = Array.isArray(fields.request_id) ? fields.request_id : fields.request_id ? [fields.request_id] : [];

  let closed = 0;
  for (const id of ticked) {
    // One at a time through the single-request path, so each request records its own event and the bulk
    // route cannot drift from the individual one. `closeRequest` refuses one already closed, which is why
    // the count is what the function returns rather than the length of the list.
    if (closeRequest(db, practiceId, id)) closed += 1;
  }

  return redirect(response, closed > 0 ? `/requests/close?closed=${closed}` : '/requests/close?nothing=1');
}

/**
 * The practice's clients: who they work for, and what each one still owes.
 *
 * Until this page existed a client was only reachable *through* one of their requests, which meant the
 * answer to "who do I work for, and who is late?" was a request board read sideways. A practice has
 * clients; requests are what it does about them. The order of those two facts had stopped matching the
 * order of the screens.
 *
 * The address column is not decoration either: a client with no address is a client the chase cannot
 * write to, and the only way to notice that was to reach the chase and find them listed as
 * unreachable. Here it is a state, on the row, with a place to fix it.
 */
function listClients({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim();
  const everyone = clientSummaries(db, practiceId);
  const needle = query.toLowerCase();
  const timezone = practiceFor(db, practiceId).timezone;
  // Who is due is computed for the *whole* practice, not for what is on screen: the tile counts the work, and a
  // count that changed when somebody typed in the search box would be a count nobody could act on.
  const due = clientsDueForAsking(db, practiceId, { timezone });
  const dueIds = new Set(due.map((row) => row.id));
  const onlyDue = url.searchParams.get('due') === '1';

  const searched = needle
    ? everyone.filter((row) => `${row.name} ${row.email ?? ''}`.toLowerCase().includes(needle))
    : everyone;
  const rows = onlyDue ? searched.filter((row) => dueIds.has(row.id)) : searched;
  const owing = rows.filter((row) => row.progress.outstanding > 0);
  const noAddress = rows.filter((row) => !row.email);
  const justSaved = url.searchParams.get('saved');

  const table = rows.length === 0
    ? empty(
        query
          ? `Nothing matches “${query}”`
          : onlyDue
            ? 'Nobody is due an ask this month'
            : 'No clients yet',
        query
          ? html`The search looks at the name and the address. <a href="/clients">Clear it</a> to see everyone again.`
          : onlyDue
            ? html`This list is the clients nothing is open for whose last ask was in this month of an earlier
                year. Either nobody is on an annual cycle that comes round now, or everybody has already been
                asked. <a href="/clients">Show everyone</a>.`
            : 'A client appears here the first time you ask them for something — type a name on a new request and they are kept.',
        query || onlyDue ? null : html`<a class="btn primary" href="/requests/new">New request</a>`,
      )
    : html`<div class="scroll"><table class="clients">
        <colgroup>
          <col class="c-name"><col class="c-mail"><col class="c-open">
          <col class="c-out"><col class="c-reminded"><col class="c-do">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Client</th>
            <th align="left">Address</th>
            <th align="right">Open</th>
            <th align="right">Outstanding</th>
            <th align="left">Last contact</th>
            <th align="left"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td>
              <a class="cell-t" href="/clients/${row.id}">${row.name}</a>
              ${dueIds.has(row.id)
                ? html`<span class="cell-s">last asked ${dateIn(timezone, new Date(row.last_request_at))}</span>`
                : row.closed_requests > 0
                  ? html`<span class="cell-s">${row.open_requests} open · ${row.closed_requests} closed</span>`
                  : ''}
            </td>
            <td>${row.email
              ? row.email
              : html`${badge('no address', TONES.wrong)}`}</td>
            <td align="right">${row.open_requests === 0
              ? html`<span class="muted">—</span>`
              : row.open_requests}</td>
            <td align="right">${row.progress.outstanding === 0
              ? html`<span class="muted">—</span>`
              : html`<strong>${row.progress.outstanding}</strong>`}</td>
            <td>${row.last_contact_at
              ? html`<span class="muted">${dateIn(timezone, new Date(row.last_contact_at))}</span>`
              : html`<span class="muted">never</span>`}</td>
            <td>
              <a class="btn sm" href="/requests/new?for=${row.id}">New request</a>
            </td>
          </tr>`)}
        </tbody>
      </table></div>`;

  return sendPage(response, 200, page({
    title: 'Clients',
    practitioner,
    here: '/clients',
    banner: justSaved
      ? html`<p class="success"><strong>Saved.</strong> ${justSaved} is what this practice will call them
          from now on, and every request of theirs moves with the record.</p>`
      : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Clients</h1>
          <p class="sub">Everyone this practice asks for documents, and what each of them still owes.</p>
        </div>
        <div class="do">
          <a class="btn primary" href="/requests/new">New request</a>
        </div>
      </div>
      <div class="bar">
        ${everyone.length === 0
          ? ''
          : html`<form class="search" method="get" action="/clients">
              <input type="search" name="q" value="${query}" placeholder="Name or address"
                aria-label="Search clients">
              <button type="submit">Search</button>
              ${query ? html`<a class="clear" href="/clients">Clear</a>` : ''}
            </form>`}
      </div>
      ${query
        ? html`<p class="note">${rows.length} ${rows.length === 1 ? 'client' : 'clients'} matching
            “${query}” · <a href="/clients.csv${query ? `?q=${encodeURIComponent(query)}` : ''}">Download as CSV</a></p>`
        : everyone.length > 0
          ? html`<p class="note"><a href="/clients.csv">Download as CSV</a> — everyone, with what each of
              them still owes.</p>`
          : ''}
      ${rows.length === 0
        ? ''
        : html`<div class="tiles">
            ${tile(rows.length, rows.length === 1 ? 'client' : 'clients')}
            ${due.length > 0
              ? tile(due.length, 'due to be asked', {
                  href: '/clients?due=1',
                  tone: 'attn',
                  current: onlyDue,
                })
              : tile(0, 'due to be asked')}
            ${owing.length > 0
              ? tile(owing.length, 'still owe something', { href: '/chase', tone: 'attn' })
              : tile(0, 'still owe something')}
            ${noAddress.length > 0
              ? tile(noAddress.length, 'with no address', { tone: 'warn' })
              : tile(0, 'missing an address')}
          </div>`}
      ${onlyDue && rows.length > 0
        ? html`<div class="card">
            <h2>The year coming round</h2>
            <p>These ${rows.length === 1 ? 'is a client' : 'are clients'} nothing is open for, whose last ask was in
            <strong>${monthIn(timezone)}</strong> of an earlier year — so this is the month they were asked last
            time. That is the whole rule: no cycle length to configure, and the list empties itself as you ask each
            one, because an open request takes them off it.</p>
            <p class="note">Nothing here has been sent, and nothing will be without you pressing a button: the next
            step shows every client and every address before anything leaves the building.</p>
            <div class="actions">
              <a class="btn primary" href="/ask-everyone?due=1">Ask them all again</a>
              <a class="btn" href="/clients">Show everyone</a>
            </div>
          </div>`
        : ''}
      ${noAddress.length > 0
        ? html`<p class="note">A client with no address is left out of every reminder — open one and add
            it. The chase names them rather than dropping them quietly, but an address is faster.</p>`
        : ''}
      ${table}`,
  }));
}

/**
 * The directory as a spreadsheet: who the practice works for, and what each one owes.
 *
 * Same reasoning as the board's export, and the same filters: a practice reconciling a season works in a
 * spreadsheet, and the list they want to sort by their own column is the one with the counts on it.
 */
function clientsCsv({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const rows = clientSummaries(db, practiceId)
    .filter((row) => (query ? `${row.name} ${row.email ?? ''}`.toLowerCase().includes(query) : true))
    .map((row) => [
      row.name,
      row.email ?? '',
      row.open_requests,
      row.closed_requests,
      row.progress.outstanding,
      row.last_contact_at ? row.last_contact_at.slice(0, 10) : '',
      row.created_at.slice(0, 10),
    ]);

  return sendCsv(response, 'tickmark-clients.csv', [
    ['Client', 'Address', 'Open requests', 'Closed requests', 'Outstanding', 'Last contact', 'First asked'],
    ...rows,
  ]);
}

/**
 * Save a client's name and address.
 *
 * The name is required because a client with no name cannot be found in the list, and the address is
 * optional because plenty of clients are only ever chased by phone — but clearing it is a decision
 * made here, on purpose, which is why an empty field on *this* form clears it while an empty field on
 * a request form does not.
 *
 * A name that is already taken by another client is refused rather than merged. Two records with one
 * name is how a request ends up filed against the wrong one, and merging is a decision about which
 * history survives — not something to do silently because somebody typed a name that matched.
 */
async function saveClient({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = clientFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no client at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const name = (field(fields, 'name') ?? '').trim();
  const email = (field(fields, 'email') ?? '').trim();
  if (!name) return fail(response, 400, 'A client needs a name.', practitioner);
  if (name.length > 200) return fail(response, 400, 'That name is longer than 200 characters.', practitioner);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(response, 400, 'That does not look like an email address.', practitioner);
  }

  const clash = db
    .prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(practiceId, name, found.id);
  if (clash) {
    return fail(
      response,
      400,
      `There is already a client called ${name}. Two records with one name is how a request ends up filed against the wrong one — rename this one, or use the other.`,
      practitioner,
    );
  }

  updateClient(db, { practiceId, clientId: found.id, name, email: email || null });
  return redirect(response, `/clients/${found.id}?saved=1`);
}

/**
 * One client: who they are, everything asked of them, and the two things a practice does about them.
 *
 * The reuse is the point of the page. "The same as last year" is the year-two workflow, and it is why
 * the new-request button carries the client with it and offers their most recent checklist — the
 * biggest repeat cost in the research was the same list rebuilt from scratch every January.
 */
function viewClient({ db, response, practitioner, params, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = clientFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no client at that address.', practitioner);

  const requests = requestsForClient(db, practiceId, found.id);
  const open = requests.filter((row) => !row.closed_at);
  const closed = requests.filter((row) => row.closed_at);
  const wanted = open.reduce((total, row) => total + outstandingOf(db, row.id).length, 0);
  const previous = previousChecklistFor(db, practiceId, found.id);
  const justSaved = url.searchParams.get('saved');

  const rowFor = (request) => html`<tr>
    <td><a class="cell-t" href="/requests/${request.id}">${request.title}</a></td>
    <td>${request.closed_at
      ? badge('closed', TONES.done_for)
      : badge(REQUEST_STATE_WORDS[request.progress.state], stateTone(request.progress.state))}</td>
    <td align="right">${request.progress.received} / ${request.progress.items}</td>
    <td>${request.due_at ?? html`<span class="muted">no date</span>`}</td>
    <td><span class="muted">${request.created_at.slice(0, 10)}</span></td>
  </tr>`;

  return sendPage(response, 200, page({
    title: found.name,
    practitioner,
    here: '/clients',
    banner: justSaved ? html`<p class="success"><strong>Saved.</strong></p>` : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/clients">Clients</a></p>
          <h1>${found.name}</h1>
          <p class="sub">${found.email ?? 'No address yet — reminders cannot be sent to them'}</p>
        </div>
        <div class="do">
          <a class="btn primary" href="/requests/new?for=${found.id}">New request</a>
        </div>
      </div>
      ${requests.length > 0
        ? html`<div class="tiles">
            ${tile(open.length, open.length === 1 ? 'open request' : 'open requests')}
            ${tile(wanted, 'still outstanding', { tone: wanted > 0 ? 'attn' : null })}
            ${tile(closed.length, closed.length === 1 ? 'closed request' : 'closed requests')}
          </div>`
        : ''}
      ${requests.length === 0
        ? empty(
            `${found.name} has nothing outstanding`,
            'Ask them for something and everything they send appears here, with the requests they have had before.',
            html`<a class="btn primary" href="/requests/new?for=${found.id}">Ask for documents</a>`,
          )
        : html`<section class="card">
            <h2>Everything asked of them</h2>
            <div class="scroll"><table class="items">
              <colgroup>
                <col class="c-title"><col class="c-state"><col class="c-received">
                <col class="c-due"><col class="c-asked">
              </colgroup>
              <thead>
                <tr>
                  <th align="left">Request</th>
                  <th align="left">State</th>
                  <th align="right">Received</th>
                  <th align="left">Due</th>
                  <th align="left">Asked</th>
                </tr>
              </thead>
              <tbody>${requests.map(rowFor)}</tbody>
            </table></div>
          </section>`}
      <section class="card">
        <h2>Their details</h2>
        <form method="post" action="/clients/${found.id}">
          <div class="field">
            <label for="name">What this practice calls them</label>
            <input id="name" name="name" required maxlength="200" value="${found.name}">
            <p class="form-hint">Fixing a typo here moves every request of theirs with it — which is why
            a client typed twice by mistake is a thing you can repair rather than live with.</p>
          </div>
          <div class="field">
            <label for="email">Their address <span class="note">for reminders</span></label>
            <input id="email" name="email" type="email" value="${found.email ?? ''}">
            <p class="form-hint">Leave it empty to remove the address: reminders then name them as
            unreachable rather than being sent nowhere.</p>
          </div>
          <button type="submit">Save</button>
        </form>
      </section>
      ${previous.items.length > 0
        ? html`<section class="card">
            <h2>Last time they were asked</h2>
            <p class="note">${previous.title ?? 'A previous request'} asked for
            ${previous.items.length} ${previous.items.length === 1 ? 'document' : 'documents'}:</p>
            <ul class="plain">${previous.items.map((label) => html`<li>${label}</li>`)}</ul>
            <div class="actions">
              <a class="btn" href="/requests/new?for=${found.id}&amp;like=last">Start one like this</a>
            </div>
          </section>`
        : ''}`,
  }));
}
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
    .prepare('SELECT * FROM upload WHERE id = ? AND request_id = ?')
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

async function issueLink({ db, request, response, practitioner, params, practiceId, onLinkIssued }) {
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

  // Optional, injected, and a no-op single-tenant: where else would a link live but in the file
  // that issued it? In SaaS mode the entry passes the registry's recorder, so a client's link can
  // find its practice without a host header. The core route never learns why.
  onLinkIssued?.({ practiceId, token, requestId: found.id });

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

/**
 * The reminder for one request: the words, and the list they were built from.
 *
 * One function, used by the single-request page and by the run that writes to everybody. Two
 * implementations of "what does a reminder say" would be two things free to disagree — and the place
 * the disagreement would show up is a client's inbox.
 */
function messageFor({ db, found, origin, token, practiceName = null }) {
  const items = itemsOf(db, found.id);
  const outstanding = outstandingOf(db, found.id);

  return {
    outstanding,
    total: items.length,
    ...reminderDraft({
      clientName: found.client_name,
      title: found.title,
      dueAt: found.due_at,
      practiceName,
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

  const message = messageFor({
    db,
    found,
    origin: originOf(request),
    token,
    practiceName: practiceFor(db, practiceId).name,
  });

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
 * Change a request after it exists.
 *
 * The gap this closes is not a missing feature so much as a missing operation: a title could be set once and
 * never corrected, and a due date could be set once and never moved. Both happen constantly — deadlines are
 * the most changeable fact in an accountant's week — and the only fix was to close the request and start
 * again, which throws away the link the client already has and the record of what they already sent.
 *
 * The client can be corrected here too. "This was filed against the wrong client" is a correction like any
 * other, and it carries the same rule as everywhere else: a name that matches an existing client moves the
 * request to *them* rather than creating a second record.
 */
function editRequestForm({ db, response, practitioner, params, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const clients = clientSummaries(db, practiceId).map((row) => ({ name: row.name, email: row.email }));
  const saved = url.searchParams.get('saved');

  return sendPage(response, 200, page({
    title: `Edit ${found.title}`,
    practitioner,
    here: '/requests',
    banner: saved
      ? html`<p class="success"><strong>Saved.</strong> ${saved === 'nothing' ? 'Nothing had changed.' : saved}</p>`
      : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a> · <a href="/requests/${found.id}">${found.title}</a></p>
          <h1>Edit this request</h1>
          <p class="sub">The client's link does not change, and neither does anything they have already sent.</p>
        </div>
      </div>
      <form method="post" action="/requests/${found.id}/edit" class="card narrow">
        <input type="hidden" name="client_id" value="${found.client_id}">
        <div class="field">
          <label for="client">Client</label>
          <input id="client" name="client" required value="${found.client_name}" list="client-names"
            autocomplete="off">
          ${clients.length > 0
            ? html`<datalist id="client-names">
                ${clients.map((client) => html`<option value="${client.name}">${client.email ?? ''}</option>`)}
              </datalist>
              <p class="form-hint">Choosing another of the practice's clients moves the request to them —
              nothing is copied, and nothing is left behind.</p>`
            : ''}
        </div>
        <div class="field">
          <label for="title">What is this for?</label>
          <input id="title" name="title" required value="${found.title}" maxlength="200">
        </div>
        <div class="field">
          <label for="due">Due <span class="note">(optional — clear it to remove the date)</span></label>
          <input id="due" name="due" type="date" value="${found.due_at ?? ''}">
        </div>
        <div class="field">
          <label for="client_note">A note for your client <span class="note">(optional — shown at the top of their page)</span></label>
          <textarea id="client_note" name="client_note" rows="4" maxlength="2000">${found.client_note ?? ''}</textarea>
        </div>
        <button type="submit">Save the changes</button>
      </form>
      <p class="note">To change the list itself — adding a document, or stopping asking for one — use the
      request's own page. The record keeps what was asked for and when.</p>`,
  }));
}

/** Save an edit, and record what actually changed rather than that something did. */
async function saveRequest({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const name = (field(fields, 'client') ?? '').trim();
  const title = (field(fields, 'title') ?? '').trim();
  const due = (field(fields, 'due') ?? '').trim();
  const note = (field(fields, 'client_note') ?? '').trim();
  const carriedClientId = field(fields, 'client_id');

  if (!name) return fail(response, 400, 'A client is required.', practitioner);
  if (!title) return fail(response, 400, 'A title is required.', practitioner);
  if (title.length > 200) return fail(response, 400, 'That title is longer than 200 characters.', practitioner);
  if (note.length > 2000) {
    return fail(response, 400, 'The note for your client is longer than 2000 characters.', practitioner);
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return fail(response, 400, 'That is not a date a browser would send.', practitioner);
  }

  // The client named on the form decides which record the request belongs to: the same name is the same
  // client, and a name typed differently on purpose is only a *new* client when it matches none of them.
  const carried = carriedClientId ? clientFor(db, practiceId, carriedClientId) : null;
  let clientId = carried?.id ?? null;
  if (!clientId) {
    clientId = findOrCreateClient(db, { practiceId, createdBy: practitioner.id, name });
  } else if (name !== carried.name) {
    const clash = db
      .prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
      .get(practiceId, name, carried.id);
    if (clash) return fail(response, 400, `There is already a client called ${name}.`, practitioner);
    updateClient(db, { practiceId, clientId: carried.id, name, email: carried.email });
  }

  const { changes } = updateRequest(db, {
    practiceId,
    requestId: found.id,
    clientId,
    title,
    dueAt: due || null,
    clientNote: note || null,
  });

  return redirect(
    response,
    `/requests/${found.id}/edit?saved=${encodeURIComponent(changes.length === 0 ? 'nothing' : changes.join(', '))}`,
  );
}

/**
 * Ask for the documents, by email.
 *
 * The gap this closes is small on paper and large in practice: the practice could already make a link and
 * already send mail, so the only way to ask for something was to copy a link out of one page and paste it
 * into another program. That step is where a practice decides the tool is a spreadsheet with extra steps.
 *
 * Like the reminder, it **issues a fresh link** rather than reusing one: a link cannot be recovered from the
 * server by design, and the practice may be sending to a client who never received the first one. It is
 * recorded as `request.sent` rather than as a reminder, because the record should say what actually
 * happened — "we asked for this on the 3rd" and "we chased them on the 20th" are different sentences.
 */
async function draftOpening({ db, request, response, practitioner, params, mailer, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (!practitioner.hasKey) return redirect(response, '/setup');

  const items = itemsOf(db, found.id).filter((item) => !item.withdrawn);
  if (items.length === 0) return redirect(response, `/requests/${found.id}`);

  const fields = formFields(await readBody(request));
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);

  const token = newToken();
  issueToken(db, {
    requestId: found.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  });

  return sendPage(response, 200, reminderPage({
    mailer,
    practitioner,
    found,
    opening: true,
    action: `/requests/${found.id}/send-request`,
    days,
    outstanding: items.length,
    total: items.length,
    draft: openingDraft({
      clientName: found.client_name,
      title: found.title,
      dueAt: found.due_at,
      items: items.map((item) => item.label),
      note: found.client_note,
      link: `${originOf(request)}/r/${token}`,
      practiceName: practiceFor(db, practiceId).name,
    }),
  }));
}

/**
 * Send the request that is on the screen.
 *
 * Identical in shape to sending a reminder, and for the same reasons: the text comes from the form, because
 * the practice may have edited it and their words are what their client should receive; and a failure keeps
 * the text and reports the relay's own words, because a send that loses what somebody typed is worse than a
 * send that fails.
 */
async function sendOpening({ db, request, response, practitioner, params, mailer, practiceId }) {
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
  const subject = field(fields, 'subject') ?? openingDraft({
    clientName: found.client_name,
    title: found.title,
    dueAt: found.due_at,
    items: itemsOf(db, found.id).filter((item) => !item.withdrawn).map((item) => item.label),
    note: found.client_note,
    link: '',
  }).subject;
  const body = typeof fields.message === 'string' ? fields.message : '';

  try {
    const messageId = await sendMail(mailer, { to: found.client_email, subject, body });
    recordEvent(db, {
      requestId: found.id,
      kind: 'request.sent',
      detail: `${found.client_email} — ${messageId}`,
    });
    return redirect(response, `/requests/${found.id}?emailed=${encodeURIComponent(messageId)}`);
  } catch (error) {
    if (!(error instanceof MailError)) throw error;
    return sendPage(response, 200, reminderPage({
      mailer,
      practitioner,
      found,
      opening: true,
      action: `/requests/${found.id}/send-request`,
      days: 30,
      outstanding: outstandingOf(db, found.id).length,
      total: itemsOf(db, found.id).length,
      draft: { subject, body },
      error: error.message,
    }));
  }
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
function reminderPage({
  mailer,
  practitioner,
  found,
  draft,
  days,
  outstanding,
  total,
  error = null,
  opening = false,
  action = null,
}) {
  const canSend = Boolean(mailer) && Boolean(found.client_email);
  const sendTo = action ?? `/requests/${found.id}/send-reminder`;

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
    title: `${opening ? 'Ask' : 'A reminder for'} ${opening ? found.client_name : ''}`.trim(),
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
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a> · <a href="/requests/${found.id}">${found.title}</a></p>
          <h1>${opening ? `Ask ${found.client_name} for these` : `A reminder for ${found.client_name}`}</h1>
          <p class="sub">${opening
            ? html`${total} ${total === 1 ? 'document is' : 'documents are'} being asked for. The link in the
                message is new, it works for ${days} days, and <strong>it is not recoverable</strong> — if you
                lose it, start this again.`
            : html`${outstanding} of ${total} still outstanding. The link in the message is new, it
                works for ${days} days, and <strong>it is not recoverable</strong> — if you lose it, draft the
                reminder again.`}</p>
        </div>
      </div>
      ${whyNot}
      <form method="post" action="${sendTo}" class="card">
        <div class="field">
          <label for="subject">Subject</label>
          <textarea id="subject" name="subject" rows="2">${draft.subject}</textarea>
        </div>
        <div class="field">
          <label for="message">Message <span class="note">what you see is what gets sent</span></label>
          <textarea id="message" name="message" rows="18" onclick="this.focus(); this.select();">${draft.body}</textarea>
        </div>
        ${canSend
          ? html`<button type="submit">Send it to ${found.client_email}</button>`
          : html`<button type="submit" disabled>Send it</button>`}
      </form>
      <p class="note"><a href="/requests/${found.id}">Back to the request</a></p>`,
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
      // When this request was last *contacted* — an email the run sent, or a call the practice recorded. Both,
      // because the practice's question is "have we been in touch about this", and the cadence exists to stop the
      // software contradicting what a person already did. A practice that phoned a client yesterday and is then
      // told to write to them today would conclude, correctly, that the tool was not paying attention.
      lastContactAt: db
        .prepare(
          "SELECT MAX(at) AS at FROM event WHERE request_id = ? AND kind IN ('reminder.sent', 'request.contacted')",
        )
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
 * Check off everything that has arrived, in one action, and say how many.
 *
 * The count in the redirect is what makes this honest: the page the practice lands on says "3 documents checked"
 * rather than leaving them to work out whether the press did anything.
 */
function checkAllArrivalsPage({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const checked = markArrivalsChecked(db, practiceId, params[0]);
  if (checked === 0) {
    return fail(
      response,
      404,
      'There was nothing to check: either that request does not exist, or nothing on it has arrived that nobody has looked at yet.',
      practitioner,
    );
  }
  return redirect(response, `/requests/${params[0]}?checked=${checked}`);
}

/**
 * Record a contact that was not an email from here.
 *
 * Nothing is sent — this is the practice writing down something they already did, and the client is not told. The
 * only sign of it is in the record and in the cadence, which is exactly the point: the tool stops offering to
 * chase somebody the practice spoke to this morning.
 */
async function logContactPage({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const note = (field(fields, 'note') ?? '').trim();

  if (note.length === 0) {
    return fail(
      response,
      400,
      'Say what happened in a few words — "phoned, sending the rest Friday". The note is the record; a row with nothing in it is a row somebody has to interpret later.',
      practitioner,
    );
  }
  if (note.length > 200) {
    return fail(response, 400, 'That note is longer than 200 characters. Keep it to what you would write on the file.', practitioner);
  }
  if (!logContact(db, practiceId, params[0], { note })) {
    return fail(response, 404, 'There is no request at that address.', practitioner);
  }

  return redirect(response, `/requests/${params[0]}?contacted=1`);
}

/**
 * Whether the practice's own cadence holds a reminder back.
 *
 * The rule is one line and it lives in one place, because the page and the run must agree about it: a page that
 * says "this sends 4" over a run that sends 2 would be the same class of lie as a banner that overstates itself
 * anywhere else.
 *
 * It reads **any** contact rather than only the emails this tool sent, which is the change 2v made: the setting is
 * about how often a client hears from the practice, and a phone call is hearing from the practice.
 */
function heldBackBy(line, cadenceDays, nowIso = now()) {
  if (cadenceDays <= 0 || !line.lastContactAt) return false;
  const days = (Date.parse(nowIso) - Date.parse(line.lastContactAt)) / 86400000;
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
    ? empty(
        'Nothing is outstanding for anyone.',
        html`<a href="/requests">The board</a> has the full picture.`,
      )
    : html`<div class="scroll"><table class="chase">
        <colgroup>
          <col style="width:17%"><col style="width:24%"><col style="width:29%">
          <col style="width:18%"><col style="width:12%">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Client</th>
            <th align="left">Request</th>
            <th align="left">Outstanding</th>
            <th align="left">To send to</th>
            <th align="left">Last</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td><span class="cell-t">${row.client_name}</span></td>
            <td><a class="cell-t" href="/requests/${row.id}">${row.title}</a></td>
            <td>${row.outstanding.map((item) => item.label).join(', ')}
              ${row.outstanding.some((item) => item.clientSays)
                ? html`<span class="cell-s">the client has already answered about some of these — the message
                    repeats that back rather than asking again</span>`
                : ''}</td>
            <td>${row.client_email ?? html`<span class="badge bad">no email address on this client</span>`}</td>
            <td>${row.lastContactAt
              ? html`<span class="cell-s">in touch ${agoWords(row.lastContactAt, now())}</span>`
              : html`<span class="cell-s muted">never in touch</span>`}
              ${held.includes(row) ? html`${badge('held back — inside your cadence', TONES.waiting)}` : ''}</td>
          </tr>`)}
        </tbody>
      </table></div>`;

  return sendPage(response, 200, page({
    title: 'Chase everyone',
    practitioner,
    here: '/chase',
    banner: !mailer
      ? html`<p class="warning">Tickmark has no mail server configured, so nothing can be sent. Set
          <code>TICKMARK_SMTP_URL</code> and <code>TICKMARK_MAIL_FROM</code> and restart it — or open a
          request and copy its reminder by hand.</p>`
      : sendable.length === 0
        ? html`<p class="note">Nothing would be sent at the moment${held.length > 0
            ? html`, because every client who owes something was in touch inside your
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
      <div class="page-head">
        <div class="titles">
          <h1>Chase everyone who owes you something</h1>
          <p class="sub">${rows.length} ${rows.length === 1 ? 'request has' : 'requests have'} something
          outstanding. Each one is sent the ordinary reminder for its own list, with its own link.</p>
        </div>
      </div>
      ${table}
      ${rows.length === 0
        ? ''
        : html`<div class="actions">
            <form method="post" action="/chase">
              ${mailer && sendable.length > 0
                ? html`<button type="submit" class="primary">Send ${sendable.length}
                    ${sendable.length === 1 ? 'reminder' : 'reminders'}</button>`
                : html`<button type="submit" disabled>Send${mailer ? '' : ' (no mail server)'}</button>`}
            </form>
          </div>`}

      <section class="card">
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
        same client being contacted twice in one afternoon, which is the accident worth preventing.
        <strong>It counts every kind of contact</strong>, including a call you record by hand, because the
        question is how often a client hears from you rather than how many emails the tool sent.
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
      </section>
      <p class="note"><a href="/requests">Back to the board</a></p>`,
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
    results.push(await sendOneReminder(db, row, origin, mailer, practiceFor(db, practiceId).name));
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
async function sendOneReminder(db, row, origin, mailer, practiceName = null) {
  const token = newToken();
  issueToken(db, {
    requestId: row.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + REMINDER_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });

  const message = messageFor({ db, found: row, origin, token, practiceName });
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
 * The mail setup's test bench (see docs/mail.md).
 *
 * Setting a relay up is the one piece of onboarding that involves someone else's machine, and the
 * failure modes — the password, the port, the firewall, the certificate — are exactly the things a
 * non-technical operator cannot tell apart. So the page sends one real message the way a reminder is
 * sent, and on a failure shows the relay's own reply next to one sentence that names which of those
 * four it was. It changes nothing: no reminder is marked sent, no link is issued, nothing is recorded.
 */
function testEmailPage({ practitioner, mailer, error = null, sent = null, to = '' }) {
  return page({
    title: 'Test email',
    practitioner,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Test the mail setup</h1>
          <p class="sub">One real message through the same code a reminder uses, so a success here is a
          relay a reminder will work with.</p>
        </div>
      </div>
      ${mailer
        ? html`<p class="info">Sending from <strong>${mailer.describe()}</strong>, as
              <strong>${mailer.from}</strong>.</p>`
        : html`<p class="warning"><strong>Sending is not configured.</strong> Set
              <code>TICKMARK_SMTP_URL</code> and <code>TICKMARK_MAIL_FROM</code> (see
              <code>docs/mail.md</code>) and restart. Until then Tickmark drafts reminders and does
              not send them.</p>`}
      ${error
        ? html`<p class="error"><strong>Not sent.</strong> ${error.message}</p>
            ${MAIL_STEP_ADVICE.find(([step]) => error.step.startsWith(step))?.[1]
              ? html`<p class="note">${MAIL_STEP_ADVICE.find(([step]) => error.step.startsWith(step))[1]}</p>`
              : ''}`
        : ''}
      ${sent
        ? html`<p class="success"><strong>Sent.</strong> The relay accepted the message for
              <strong>${sent.recipient}</strong> (<code>${sent.messageId}</code>). Acceptance is not
              delivery — check that it arrived, and that it did not land in spam.</p>`
        : ''}
      ${mailer
        ? html`<form method="post" action="/admin/test-email" class="card narrow">
              <div class="field">
                <label for="email">Send a test message to</label>
                <input id="email" name="email" type="email" required value="${to}">
              </div>
              <button type="submit">Send the test message</button>
            </form>
            <p class="note">A plain-text message, sent through the same code a reminder uses — so a
            success here is a relay a reminder will work with. A failure names the step that failed and
            the relay's own reply, which is what says whether it is the address, the password, the port
            or the firewall.</p>`
        : ''}`,
  });
}

/**
 * One sentence per way the conversation can fail, matched by the step `sendMail` names.
 *
 * The SMTP reply itself is always shown too — `550 5.1.1 no such user` is quotable to a mail provider
 * — because a canned sentence is a starting point and the server's words are the evidence.
 */
const MAIL_STEP_ADVICE = [
  ['connection', 'The relay could not be reached. Check the host and the port, and whether a firewall is in the way — this is where a wrong port or a blocked one shows up.'],
  ['timeout', 'The relay did not answer in time. Usually a wrong port, or a firewall that drops the connection rather than refusing it.'],
  ['starttls', 'The encrypted connection failed. Usually a certificate this machine does not trust (see TICKMARK_SMTP_CA_FILE in docs/mail.md), or a TLS-only relay spoken to on the wrong port.'],
  ['authentication', 'The relay refused the credentials — the username or the password is wrong, or the relay does not accept them.'],
  ['configuration', 'The settings themselves are wrong — TICKMARK_SMTP_URL or TICKMARK_MAIL_FROM (see docs/mail.md), or the recipient address.'],
  ['the server greeting', 'The relay answered, but not as an SMTP server. Check the host and port — this is what a web server or a firewall page looks like when an SMTP client dials it.'],
];

function testEmailForm({ response, practitioner, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;
  return sendPage(response, 200, testEmailPage({ practitioner, mailer }));
}

async function testEmailSend({ request, response, practitioner, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const to = field(fields, 'email') ?? '';

  if (!mailer) {
    return sendPage(response, 400, testEmailPage({ practitioner, mailer, to }));
  }

  try {
    const sent = await sendMail(mailer, {
      to,
      subject: 'Tickmark test message',
      body: [
        'This is a test message from Tickmark, sent from the mail setup page.',
        '',
        `Relay: ${mailer.describe()}`,
        '',
        'If you are reading this, the relay accepted the message. Check that it arrived in the mailbox — acceptance is not delivery.',
      ].join('\n'),
    });
    return sendPage(response, 200, testEmailPage({ practitioner, mailer, to, sent }));
  } catch (error) {
    // Anything that is not a MailError is a bug in this process, not in the relay — that one is
    // worth a stack trace in the log rather than a sentence in the browser.
    if (!(error instanceof MailError)) throw error;
    return sendPage(response, 400, testEmailPage({ practitioner, mailer, to, error }));
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
            not written to</strong>, because you asked not to be in touch with the same client more often than
            every ${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'} and they were contacted more recently
            than that — by an email from here, or by something you recorded yourself. Nothing is wrong: they
            are still on <a href="/chase">the chase list</a>, and the setting is on that page if you want to
            change it.</p>`
        : ''}
      ${later.length > 0
        ? html`<p class="warning"><strong>The run stopped before it finished.</strong> It reached its time
            budget, which is deliberate — a run cut off by the server halfway through would leave no record
            of who had already been written to. The ${later.length} below are untouched and still on
            <a href="/chase">the chase list</a>.</p>`
        : ''}
      ${results.length + skipped.length + held.length === 0
        ? empty('There was nothing to send.', 'Nobody owed anything that this run could write to.')
        : html`<div class="scroll"><table>
            <colgroup><col style="width:22%"><col style="width:34%"><col style="width:44%"></colgroup>
            <thead>
              <tr><th align="left">Client</th><th align="left">Request</th><th align="left">Outcome</th></tr>
            </thead>
            <tbody>
              ${results.map((entry) => html`<tr>
                <td><span class="cell-t">${entry.row.client_name}</span></td>
                <td><a href="/requests/${entry.row.id}">${entry.row.title}</a></td>
                <td>${outcomeOf(entry)}</td>
              </tr>`)}
              ${held.map((row) => html`<tr>
                <td><span class="cell-t">${row.client_name}</span></td>
                <td><a href="/requests/${row.id}">${row.title}</a></td>
                <td>${badge(`held back by your cadence — in touch ${agoWords(row.lastContactAt, now())}`, TONES.waiting)}</td>
              </tr>`)}
              ${skipped.map((row) => html`<tr>
                <td><span class="cell-t">${row.client_name}</span></td>
                <td><a href="/requests/${row.id}">${row.title}</a></td>
                <td>${badge('no email address on this client', TONES.wrong)}</td>
              </tr>`)}
            </tbody>
          </table></div>`}
      <p class="note"><a href="/requests">Back to the board</a> &middot; <a href="/chase">the chase list</a></p>`,
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
         JOIN request r ON r.id = u.request_id
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
  'relabel': ({ db, practiceId, requestId, itemId, fields }) =>
    setItemLabel(db, practiceId, requestId, itemId, {
      label: field(fields, 'label') ?? '',
      note: field(fields, 'note') ?? '',
    }),
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

  // The one route whose permission depends on *which* action it is: `/items/:id/:action` carries withdraw,
  // restore, attention, relabel — all coordination, all an assistant's to do — and `check`, which is a
  // statement that somebody has read the file. A member who holds no key cannot have read it, so the check
  // is refused here rather than tagged on the route. The dispatcher cannot know which action this is; the
  // handler can, and this is where it does.
  if (!holdsKey(practitioner.role) && (action === 'check' || action === 'check-clear')) {
    return fail(response, 403, refusalFor('accountant', practitioner.role), practitioner);
  }

  const fields = formFields(await readBody(request));
  const changed = change({
    db,
    practiceId,
    requestId,
    itemId,
    fields,
    note: field(fields, 'attention_note'),
  });
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
function clientPage({ db, response, params, maxUploadBytes, url }) {
  const found = tokenLookup(db, params[0]);

  if (found.state === 'expired') {
    return sendPage(response, 410, page({
      signIn: false,
      title: 'This link has expired',
      body: html`<h1>This link has expired</h1>
        <p>Ask the practice to send a new one — they can make one in a moment.</p>`,
    }));
  }
  if (found.state === 'revoked') {
    return sendPage(response, 410, page({
      signIn: false,
      title: 'This link has been cancelled',
      body: html`<h1>This link has been cancelled</h1>
        <p>Ask whoever sent it to you for a new one.</p>`,
    }));
  }
  if (found.state === 'unknown') {
    return sendPage(response, 404, page({
      signIn: false,
      title: 'No such link',
      body: html`<h1>No such link</h1>
        <p>Check the address you were sent: it may have wrapped across two lines in an
        email, or lost a character on the way.</p>`,
    }));
  }

  const open = found.request;
  // Who is asking. A client who has never heard of Tickmark and has just been emailed a link by an unknown
  // address needs the practice's name in front of them before the list — otherwise the page they land on
  // says "Documents requested" and never says by whom, which is exactly what a phishing page says.
  const practice = practiceFor(db, open.practice_id);
  // Withdrawn items are not asked for. They stay visible to the practice — the request page shows them
  // — but a client asked again for something the practice has stopped wanting is a client who stops
  // trusting the list.
  const items = itemsOf(db, open.id).filter((item) => !item.withdrawn);

  // What the client has already sent, by name and date. This is a **receipt**, and it is here because of
  // the question it answers: "did you get it?" is the phone call this page exists to prevent, and the
  // person best placed to answer it is the one holding the link. They chose the filenames, so showing
  // them back is not a disclosure — it is their own message returning to them.
  const answers = new Map();
  const extras = [];
  for (const upload of uploadsOf(db, open.id)) {
    // An upload with no item is the client's own document — something nobody asked for. It goes in a list of
    // its own rather than beside a checklist line, because it is not an answer to anything.
    if (upload.request_item_id === null) {
      extras.push(upload);
      continue;
    }
    const list = answers.get(upload.request_item_id) ?? [];
    list.push(upload);
    answers.set(upload.request_item_id, list);
  }
  const received = items.filter((item) => (answers.get(item.id) ?? []).length > 0).length;

  // What the client has said in their own words, newest last, so the page shows them the message they sent
  // rather than only telling the practice about it. Same reasoning as the receipt above.
  const said = history(db, open.id).filter((event) => event.kind === 'client.messaged');

  // What the browser is allowed to compare a newly picked file against. Deliberately **name, size and date
  // only** — the three facts this page already shows the client on the rows below, so the check discloses
  // nothing that was not already on the screen. A hash of the contents would catch more and is the one thing
  // this product will not hold; the reasoning is in web/preflight.js, and there is a test that fails if a hash
  // ever appears in this payload.
  const alreadySent = [...answers.values(), ...extras.map((upload) => [upload])]
    .flat()
    .map((upload) => ({
      name: upload.filename,
      bytes: upload.size_bytes,
      at: dateIn(practice?.timezone, new Date(upload.uploaded_at)),
    }));

  if (!open.practice_public_key) {
    return sendPage(response, 503, page({
      signIn: false,
      title: 'This link is not ready',
      body: html`<h1>This link is not ready</h1>
        <p>The practice has not finished setting up its encryption key, so there is nothing to
        encrypt your documents to yet. Ask them to send the link again once it is done.</p>`,
    }));
  }

  const rows = items.map((item) => html`<tr>
    <td>
      <span class="cell-t">${item.label}</span>
      ${item.note ? html`<span class="cell-s">${item.note}</span>` : ''}
      ${(answers.get(item.id) ?? []).map((upload) => html`<span class="cell-s">you sent
        <strong>${upload.filename}</strong> on ${dateIn(practice?.timezone, new Date(upload.uploaded_at))}</span>`)}
    </td>
    <td>${item.needsAttention
      ? html`${badge('please send this again', TONES.wrong)}${item.attentionNote ? html`<span class="cell-s">${item.attentionNote}</span>` : ''}`
      : (answers.get(item.id) ?? []).length > 0
        ? badge('received', TONES.done)
        : item.clientSays
          ? html`${badge('you said:', TONES.waiting)}<span class="cell-s">${item.clientSays}</span>`
          : badge('still needed', TONES.waiting)}</td>
    <td>
      <form class="upload" method="post" action="/r/${params[0]}/items/${item.id}">
        <input type="file" name="file" required>
        <input type="text" name="note" placeholder="anything we should know? (optional)" maxlength="500">
        <div class="row">
          <button type="submit">Send</button>
          <span class="status"></span>
        </div>
      </form>
      ${item.received
        ? ''
        : html`<form method="post" action="/r/${params[0]}/items/${item.id}/says" class="inline says">
            ${Object.entries(CLIENT_SAYS).map(([value, words]) => html`
              <button type="submit" name="says" value="${value}" class="ghost sm">${words}</button>`)}
          </form>`}
    </td>
  </tr>`);

  return sendPage(response, 200, page({
    title: `${practice?.name ?? 'Documents requested'} — ${open.title}`,
    // No sign-in link: a client has no account, and offering one is offering a door that is not
    // theirs. The practice's pages keep their own header, because there the link is the point.
    signIn: false,
    banner: html`<p class="note"><strong>What you send is encrypted in this browser before it
      leaves it.</strong> Only the practice can open it. What the server can still see is the
      name of the file, which document it answers, and when it arrived — so name files the way
      you would name an envelope, not the way you would name a letter.</p>`,
    body: html`
      <div class="client">
        <p class="eyebrow">${practice?.name ?? 'Documents requested'}</p>
        <h1>${open.title}</h1>
        <p class="who">${open.client_name}${open.due_at ? html` · needed by ${open.due_at}` : ''}</p>
        ${url.searchParams.get('said') === '1'
          ? html`<p class="success"><strong>Message sent.</strong> The practice has it, and it is kept with
              this request — you will see it below, and they will see it beside the documents.</p>`
          : ''}
        ${open.client_note ? html`<div class="greeting">${open.client_note}</div>` : ''}
        ${items.length === 0
          ? ''
          : received === items.length
            ? html`<p class="success"><strong>Thank you — everything asked for has arrived.</strong>
                ${items.length === 1 ? 'The document you sent is' : `All ${items.length} documents are`}
                with the practice. If they need anything else they will be in touch, and this page stays
                here if you want to check what you sent.</p>`
            : html`<p class="count">You have sent ${received} of ${items.length}
                ${items.length === 1 ? 'document' : 'documents'}.</p>`}
        <div class="scroll"><table>
          <thead><tr><th align="left">Document</th><th align="left">State</th><th align="left">Send it</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="note">If you cannot send one of these, say so with the buttons beside it — the practice
        would rather know than keep asking. Neither button takes it off the list; that is their call.</p>
        ${items.length === 0
          ? html`<p>Nothing is being asked of you at the moment. Add the practice's address to your
              contacts, in case they ask for something later.</p>`
          : ''}
        ${extras.length > 0
          ? html`<h2>Anything else you have sent</h2>
              <p class="note">Documents you sent that were not on the list. The practice has them.</p>
              <ul class="plain">${extras.map((upload) => html`<li>
                  <strong>${upload.filename}</strong>
                  <span class="note"> — sent on ${dateIn(practice?.timezone, new Date(upload.uploaded_at))}</span>
                </li>`)}</ul>`
          : ''}
        <h2>Send something that was not asked for</h2>
        <p class="note">If you have a document the practice has not asked for — a letter, a form, anything
        you think they need — this is the safe way to send it. It is encrypted the same way as everything
        else, and they will see it attached to this request.</p>
        <form class="upload" method="post" action="/r/${params[0]}/extra">
          <input type="file" name="file" required>
          <input type="text" name="note" placeholder="what is it? (optional)" maxlength="500">
          <div class="row">
            <button type="submit">Send it</button>
            <span class="status"></span>
          </div>
        </form>
        <h2>Send a message</h2>
        <p class="note">For anything that is not a file — the statements are in the post, you have changed
        your address, the bank said five days. It goes to the practice with this request, and it stays here
        so you can see what you said.</p>
        <form method="post" action="/r/${params[0]}/message" class="stack">
          <textarea name="body" rows="3" required maxlength="${MAX_CLIENT_MESSAGE}"
            placeholder="Anything the practice should know"></textarea>
          <div class="row"><button type="submit">Send the message</button></div>
        </form>
        ${said.length > 0
          ? html`<div class="said">
              <h3>What you have told them</h3>
              ${said.map((event) => html`<p class="note">
                <span class="when">${dateIn(practice?.timezone, new Date(event.at))}</span>
                ${event.detail}</p>`)}
            </div>`
          : ''}
        ${practice?.contact_email || practice?.contact_phone
          ? html`<h2>Asking the practice something</h2>
              <p class="note">If this page is not the right place for it — anything about fees, deadlines,
              or a document you would rather discuss first — the practice can be reached at:</p>
              <ul class="plain">
                ${practice.contact_email
                  ? html`<li><a href="mailto:${practice.contact_email}">${practice.contact_email}</a></li>`
                  : ''}
                ${practice.contact_phone ? html`<li>${practice.contact_phone}</li>` : ''}
              </ul>`
          : ''}
        <p class="note">Nothing here needs an account. Come back to this page with the same
        link to send the rest — the list shows what has already arrived.</p>
      </div>
      ${jsonTag('practice-key', { keyId: open.practice_key_id, publicKey: JSON.parse(open.practice_public_key) })}
      ${jsonTag('upload-limit', { maxBytes: maxUploadBytes })}
      ${jsonTag('already-sent', alreadySent)}
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
async function clientSays({ db, request, response, params, mailer }) {
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
  redirect(response, `/r/${token}`);

  // After the client has their answer back, and never before it — the same rule as an upload, for the same
  // reason. Clearing an answer ("actually, I will send it") is as much news as giving one, so both notify: the
  // practice needs to know the document is coming, not that their last reminder is still standing.
  //
  // No event is recorded for the client's words here: `setClientSays` already writes `item.client-said` or
  // `item.client-said-cleared`, so the record is the client's sentence and this is only the practice being told
  // about it. Two events for one action would be one event too many.
  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
}

/**
 * Take an encrypted file from a client, check it, and put it somewhere.
 *
 * One implementation for both kinds of upload, because the checks that matter are the same and a second copy
 * of them is a second place for the product's central claim to become false. In particular the envelope check
 * and the key check happen for a document nobody asked for exactly as they do for an answer: a file the
 * server can read is a file the server can read, whatever the checklist says about it.
 *
 * Returns null when it has already answered the request with a failure, which is this file's idiom — `fail`
 * writes the response, so a caller only has to return.
 */
async function acceptEnvelope({ db, request, response, blobDir, maxUploadBytes, maxRequestBytes, maxRequestFiles, requestId, requestItemId = null }) {
  const type = String(request.headers['content-type'] ?? '');
  if (!type.startsWith('application/octet-stream')) {
    return fail(response, 415, 'This page sends files as raw bytes, which needs JavaScript to be enabled.');
  }

  // **Before a byte is read.** The ceiling is checked ahead of the body for the same reason the per-file limit
  // is enforced by `readBody`: refusing after reading two gigabytes has already spent the memory the refusal was
  // meant to save. It also means a refused upload leaves nothing behind — no file on disk and no row.
  const spent = db
    .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM upload WHERE request_id = ?')
    .get(requestId);
  if (spent.files >= maxRequestFiles) {
    return fail(
      response,
      413,
      `This link has reached its limit of ${maxRequestFiles} files. Nothing was stored. Ask the practice to send a fresh link, or to raise the limit.`,
    );
  }

  // The size is only known after reading, so this is checked against what has already arrived plus the ceiling,
  // and enforced again below once the length is known. Two checks rather than one because they answer different
  // questions: this one refuses early, the other refuses exactly.
  if (spent.bytes >= maxRequestBytes) {
    return fail(
      response,
      413,
      `This link has reached its ${(maxRequestBytes / 1024 / 1024 / 1024).toFixed(1)} GB limit. Nothing was stored. Ask the practice to send a fresh link.`,
    );
  }

  // Before anything is read or written: the header helper, because the key check below needs it and a
  // rejected upload should leave nothing behind.
  const header = (name, fallback, limit) =>
    request.headers[name] ? decodeURIComponent(String(request.headers[name])).slice(0, limit) : fallback;

  const body = await readBody(request, maxUploadBytes);
  if (body.length === 0) return fail(response, 400, 'That file was empty.');

  // The exact check, now that the length is known. `spent` above could only refuse a link that had *already*
  // crossed the line; this one refuses the file that would cross it.
  if (spent.bytes + body.length > maxRequestBytes) {
    const left = Math.max(0, maxRequestBytes - spent.bytes);
    return fail(
      response,
      413,
      `That file would take this link past its limit. ${(left / 1024 / 1024).toFixed(1)} MB is left of ${(maxRequestBytes / 1024 / 1024 / 1024).toFixed(1)} GB. Nothing was stored.`,
    );
  }

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
      .get(claimedKey, requestId);
    if (!key) {
      return fail(response, 400, 'That upload named a key this practice does not have. Nothing was stored.');
    }
    keyId = key.id;
  }

  const uploadId = newId();
  const directory = join(blobDir, requestId);
  await mkdir(directory, { recursive: true });
  const storagePath = join(directory, `${uploadId}.bin`);
  await writeFile(storagePath, body);

  recordUpload(db, {
    id: uploadId,
    requestId,
    requestItemId,
    filename: header('x-file-name', 'upload.bin', 255),
    mime: header('x-file-type', 'application/octet-stream', 120),
    sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    storagePath,
    clientNote: header('x-note', null, 500),
    keyId,
    at: now(),
  });

  return { uploadId, bytes: body.length };
}

/**
 * A file the client sent that nobody asked for.
 *
 * This closes the product's last route out of itself. Before it, a client holding a link who also had the VAT
 * return, a covering letter or last year's return had one way to send it: email, in the clear, outside the
 * record, with none of the protection the page they were already looking at exists to provide. The practice
 * then held a document with nowhere to live.
 *
 * It answers no item, so it clears nothing and marks nothing received — the checklist is what the practice
 * asked for, and a client's own addition is not an answer to a question.
 */
async function receiveExtra({ db, request, response, params, blobDir, maxUploadBytes, maxRequestBytes, maxRequestFiles, mailer }) {
  const found = tokenLookup(db, params[0]);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const stored = await acceptEnvelope({
    db,
    request,
    response,
    blobDir,
    maxUploadBytes,
    maxRequestBytes,
    maxRequestFiles,
    requestId: found.request.id,
  });
  if (!stored) return;

  sendJson(response, 201, { ok: true, extra: true, bytes: stored.bytes, envelope: ENVELOPE_VERSION });

  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
}

/**
 * The client writing to the practice with no file attached.
 *
 * The two buttons beside each item cover "I do not have this" and "I will send it later". Everything else a
 * client might need to say — "I posted it", "the bank said five days", "my name changed" — had no route
 * except an email, which is the record this page exists to keep them out of.
 *
 * A form post rather than an upload: there is nothing to encrypt, and pretending otherwise would be worse
 * than useless. The practice's page shows the words and the history keeps them.
 */
async function clientMessage({ db, request, response, params, mailer }) {
  const found = tokenLookup(db, params[0]);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const fields = formFields(await readBody(request));
  const body = (field(fields, 'body') ?? '').trim();
  if (body.length === 0) {
    return fail(response, 400, 'There was nothing in that message. Type something and send it again.');
  }
  // Refused rather than trimmed: a message the client cannot see the end of is not the message they wrote.
  if (body.length > MAX_CLIENT_MESSAGE) {
    return fail(
      response,
      400,
      `That is longer than ${MAX_CLIENT_MESSAGE} characters, which is more than the practice can read in a list. Nothing was sent.`,
    );
  }

  recordClientMessage(db, { requestId: found.request.id, body });
  redirect(response, `/r/${params[0]}?said=1`);

  // After the client has their answer back, and never before it — the same rule the uploads follow.
  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
}

/**
 * The client's upload, sent by the page's own script as a raw body, as the answer to an item the practice
 * asked for. The checks and the storage are in `acceptEnvelope`; what is here is the part that is about
 * *items* — that the item exists, that it belongs to this request, and that the practice is still asking.
 *
 * The filename arrives in a header and is recorded as a *label* only. It is never used to
 * build a path, so a filename like `../../etc/passwd` cannot become one — the bytes are
 * stored under an id this process generated. That property is what makes the storage layer
 * safe to write without a sanitiser, and it needs no test to stay true as long as nobody
 * starts joining the filename into a path.
 */
async function receiveUpload({ db, request, response, params, blobDir, maxUploadBytes, maxRequestBytes, maxRequestFiles, mailer }) {
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

  const stored = await acceptEnvelope({
    db,
    request,
    response,
    blobDir,
    maxUploadBytes,
    maxRequestBytes,
    maxRequestFiles,
    requestId: found.request.id,
    requestItemId: item.id,
  });
  if (!stored) return;

  sendJson(response, 201, { ok: true, received: item.label, bytes: stored.bytes, envelope: ENVELOPE_VERSION });

  // After the client has their answer, and never before it. Awaiting this here would put the practice's mail
  // server in the path of somebody else's upload: a relay that has gone quiet would turn a client's successful
  // file into a spinner, and a relay that refuses would turn it into an error that is not their fault.
  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
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

function setupForm({ db, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const existing = practiceKeys(db, practiceId, practitioner.id);
  const first = existing.length === 0;
  return sendPage(response, 200, page({
    title: first ? 'Set up encryption' : 'Add a new key',
    practitioner,
    body: html`
      <div class="hero">
        <p class="eyebrow">${first ? 'Step one of one' : 'Keys'}</p>
        <h1>${first ? 'One passphrase, and then clients can send you files' : 'A new key, for files that arrive from now on'}</h1>
        <p class="lead">Tickmark makes a key pair in this browser. The public half is kept here; the private half
        never leaves your browser except wrapped under a passphrase, which is never sent either. That
        is what makes the promise real rather than polite: whoever runs this server — including you —
        can hold a client's documents without being able to read them.</p>
      </div>
      ${first
        ? html`<div class="danger">
              <p><strong>WARNING: Tickmark uses zero-knowledge encryption. If you lose this
              passphrase, your saved documents cannot be recovered by anyone.</strong></p>
              <p>Please save it immediately in a secure password manager (e.g., 1Password,
              Bitwarden).</p>
            </div>`
        : ''}
      ${first
        ? ''
        : html`<p class="warning"><strong>A new key does not re-encrypt anything.</strong> Files your
            clients have already sent stay encrypted to the key they arrived under, and you go on
            being able to open them. A new key changes what happens to the <em>next</em> file — so it
            is the right response to a key being exposed, and it is not an undo for a copy somebody
            has already taken.</p>`}
      <form id="setup" method="post" action="/setup" class="card narrow">
        <div class="field">
          <label for="passphrase">Passphrase</label>
          <input id="passphrase" name="passphrase" type="password" required autocomplete="new-password">
        </div>
        <div class="field">
          <label for="again">The same passphrase again</label>
          <input id="again" name="again" type="password" required autocomplete="new-password">
        </div>
        ${first
          ? html`<label for="saved-passphrase" class="check">
              <input id="saved-passphrase" type="checkbox">
              <span>I have saved this passphrase in a secure password manager (or somewhere else safe).</span>
            </label>`
          : ''}
        <button type="submit" ${first ? 'disabled' : ''}>Make the key</button>
        <div class="status note"></div>
      </form>
      <p class="note">Nothing can recover this passphrase and nothing can reset it.
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
function membersPage({ db, response, practitioner, practiceId, url, mailer }) {
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
  const saved = url.searchParams.get('saved');
  const roleChanged = url.searchParams.get('changed');
  // Whose role cannot be changed: the only owner. Computed once for the whole table rather than per row.
  const owners = ownersOf(db, practiceId);
  const soleOwner = (person) => owners.length === 1 && owners[0].id === person.id;

  return sendPage(response, 200, page({
    title: 'Members',
    practitioner,
    here: '/members',
    banner: justRemoved
      ? html`<p class="warning"><strong>${justRemoved} was removed.</strong> Their key copies are gone and
          their sessions have ended, so they cannot sign in again. Anything they already downloaded is
          still theirs — removal changes what happens next, not what has already happened.</p>`
      : roleChanged
        ? html`<p class="success"><strong>That member's role was changed.</strong> What each person may do is
            listed beside their name. Moving somebody to a role that does not hold the key destroys the
            copies they held — giving it back means making a new one, which needs a passphrase from them.</p>`
        : saved === 'notify'
        ? html`<p class="success">Saved. ${practice.notifyOnUpload
            ? html`You will be told when a client sends something.`
            : html`You will not be emailed about what clients send. The board still shows it, of course.`}</p>`
        : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>${practice.name}</h1>
          <p class="sub">${members.length === 1 ? 'One person' : `${members.length} people`} in this practice.
            The name is yours to change — it is the first thing a new member sees.</p>
        </div>
        <div class="do">
          <form method="post" action="/members/name" class="inline">
            <input name="name" value="${practice.name}" maxlength="${MAX_PRACTICE_NAME}"
              aria-label="Practice name" required>
            <select name="timezone" aria-label="Where the practice is">
              <option value="">UTC${practice.timezone ? '' : ' (current)'}</option>
              ${COMMON_ZONES.map((zone) => html`<option value="${zone}"${practice.timezone === zone ? ' selected' : ''}>${zone}</option>`)}
            </select>
            <input name="contact_email" type="email" value="${practice.contact_email ?? ''}"
              placeholder="clients@yourpractice.co.uk" aria-label="An address clients can write to">
            <input name="contact_phone" value="${practice.contact_phone ?? ''}"
              placeholder="Phone (optional)" aria-label="A phone number clients can ring">
            <button type="submit">Save</button>
          </form>
        </div>
      </div>
      <p class="note">The name is what a client sees on every letter and on the page they upload to. The zone is
      where the practice is, and it decides one thing: whether a request is overdue yet. Everything stored is
      in UTC; this is the calendar those dates are read on. The address and phone appear on the client's page
      — a client with a question about fees, or something they would rather not put in a message, is otherwise
      looking for an old email.</p>
      <form method="post" action="/members/notify" class="card">
        <label class="check">
          <input type="checkbox" name="notify" value="1"${practice.notifyOnUpload ? raw(' checked') : ''}>
          <span><strong>Email me when a client sends something</strong></span>
        </label>
        <p class="note">One message per request per day, at most, to whoever made the request — what arrived, what
        has not, and whether anything needs sending again. ${mailer
          ? ''
          : html`<strong>This installation has no mail server configured, so nothing can be sent until one is.</strong> `}
        The message names the documents, never the filenames: an email is a copy that leaves the building, and the
        request page shows the real names.</p>
        <div class="actions"><button type="submit">Save</button></div>
      </form>
      <div class="scroll"><table class="members">
        <colgroup><col style="width:34%"><col style="width:14%"><col style="width:34%"><col style="width:18%"></colgroup>
        <thead>
          <tr><th align="left">Email</th><th align="left">Joined</th><th align="left">Can open the newest files?</th><th align="left"></th></tr>
        </thead>
        <tbody>
          ${members.map((person) => html`<tr>
            <td><span class="cell-t">${person.email}</span>${person.id === practitioner.id ? html`<span class="cell-s">you</span>` : ''}
              ${soleOwner(person)
                ? html`<span class="cell-s">${ROLE_WORDS[roleName(person.role)]} — the only owner, so this cannot be changed. Make somebody else an owner first.</span>`
                : html`<form method="post" action="/members/${person.id}/role" class="inline">
                    <select name="role" aria-label="What ${person.email} may do">
                      ${ROLES.map((role) => html`<option value="${role}"${roleName(person.role) === role ? ' selected' : ''}>${ROLE_WORDS[role]}</option>`)}
                    </select>
                    <button type="submit">Set</button>
                  </form>`}
            </td>
            <td><span class="muted">${person.created_at.slice(0, 10)}</span></td>
            <td>${newest
              ? holders.has(person.id)
                ? badge('yes', TONES.done)
                : badge('no — they hold no copy of the newest key', TONES.wrong)
              : html`<span class="muted">this practice has no key yet</span>`}</td>
            <td>${person.id === practitioner.id
              ? html`<span class="muted">you cannot remove yourself</span>`
              : html`<a href="/members/${person.id}/remove">Remove</a>`}</td>
          </tr>`)}
        </tbody>
      </table></div>
      <p class="note">Removing somebody ends their access from then on. It does not take back a key they
        already have, and it does not change anything they have already downloaded — the page that asks
        says so in full before it does anything.</p>

      ${removed.length === 0
        ? ''
        : html`<h2>Removed</h2>
            <p class="note">No longer members. Their names stay in the records, because the requests they
              made and the files they uploaded say who did what. Someone still here can invite them back.</p>
            <div class="scroll"><table>
              <thead><tr><th align="left">Email</th><th align="left">Joined</th><th align="left">Removed</th></tr></thead>
              <tbody>
                ${removed.map((person) => html`<tr>
                  <td><span class="cell-t">${person.email}</span></td>
                  <td><span class="muted">${person.created_at.slice(0, 10)}</span></td>
                  <td><span class="muted">${person.removed_at.slice(0, 10)}</span></td>
                </tr>`)}
              </tbody>
            </table></div>`}

      ${!newest
        ? html`<section class="card">
            <h2>Invite someone</h2>
            <p class="note">This practice has no key, so there is nothing to invite anyone to.
              <a href="/setup">Make one first</a>.</p>
          </section>`
        : !mine
          ? html`<section class="card">
              <h2>Invite someone</h2>
              <p class="warning">You hold no copy of this practice's newest key, so you cannot invite
                anyone — an invitation carries a copy of <em>your</em> key, and handing over something you
                cannot read would be a strange thing to do. Someone who does hold a copy can invite you.</p>
            </section>`
          : html`<section class="card">
            <h2>Invite someone</h2>
            <p class="warning"><strong>Whoever opens the link gets the key.</strong> It is not addressed to
              a particular person, it works once, and it stops working after ${INVITE_DAYS} days. Send it
              the way you would send a password, not the way you would send a link.</p>
            <form id="invite-form" class="inline">
              <label for="invite-role">What will they do? <span class="note">you can change it later</span></label>
              <select id="invite-role" name="role">
                <option value="accountant" selected>Accountant — the client work, and can open what clients send</option>
                <option value="assistant">Assistant — can chase documents, cannot open them</option>
              </select>
              <div id="passphrase-row">
                <label for="passphrase">Your passphrase <span class="note">used in this browser, sent nowhere</span></label>
                <input id="passphrase" name="passphrase" type="password" autocomplete="current-password">
              </div>
              <button type="submit">Create an invitation</button>
            </form>
            <p class="status" id="invite-status"></p>
            <p id="invite-link" hidden></p>
            <script type="application/json" id="invite-key">${raw(JSON.stringify({ keyId: newest.id, wrapped: mine }))}</script>
            ${raw('<script type="module" src="/assets/members.js"></script>')}
          </section>`}

      ${invites.length > 0
        ? html`<section class="card">
            <h2>Invitations</h2>
            <div class="scroll"><table>
              <thead><tr><th align="left">Sent by</th><th align="left">When</th><th align="left">Outcome</th></tr></thead>
              <tbody>
                ${invites.map((row) => html`<tr>
                  <td><span class="cell-t">${row.created_by_email}</span></td>
                  <td><span class="muted">${row.created_at.slice(0, 10)}</span></td>
                  <td>${row.used_at
                    ? html`accepted by ${row.used_by_email} on ${row.used_at.slice(0, 10)}`
                    : row.expires_at <= new Date().toISOString()
                      ? html`${badge('expired, and was never accepted', TONES.done_for)}`
                      : html`${badge('not accepted yet', TONES.waiting)}`}</td>
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

  // **What an invitation grants when it does not say.** A keyed invitation is the old flow, which handed
  // over a key and therefore made a member who could do the client work — so that is what it still makes,
  // rather than the *owner* a null role reads as. The difference matters: null-as-owner is the honest
  // reading of a row that predates roles, and the wrong reading of a form that simply forgot to ask.
  const role = ROLES.includes(field(fields, 'role')) ? field(fields, 'role') : 'accountant';

  // **An assistant's invitation carries no key, and that is the whole point.** The key is sealed in the
  // inviter's browser, so "no key" is not something the server could do on its own — it is the browser being
  // told not to seal one, and the server refusing to record half of a keyed invitation.
  if (role === 'assistant') {
    if (sealedKey) {
      return sendJson(response, 400, { error: 'an assistant invitation does not carry a key' });
    }
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    createInvite(db, {
      practiceId,
      createdBy: practitioner.id,
      sealedKey: null,
      keyId: null,
      role,
      tokenHash: hashToken(token),
      expiresAt,
    });
    return sendJson(response, 201, { token, expiresAt, days: INVITE_DAYS, keyed: false });
  }

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
    role,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return sendJson(response, 201, { token, expiresAt, days: INVITE_DAYS, keyed: true });
}

/**
 * The page someone lands on from an invitation link.
 *
 * **Two shapes, because there are two kinds of invitation.** A keyed one hands over a copy of the practice's
 * key, and the browser does the opening: the secret that unseals the blob travels in the link's fragment,
 * which the server never receives. An assistant's invitation carries no key at all — there is nothing to open
 * and nothing to seal — so it asks for a password and nothing else, and it says plainly that they will not be
 * able to read what clients send. Asking for a passphrase that protects a key they are not being given would
 * be worse than useless: it would imply they were getting one.
 *
 * The secret is in the fragment for the keyed shape, which the server never receives — so that page cannot
 * know whether the link is valid in the way that matters. It can know whether the *token* is live, and it
 * hands the browser the sealed blob to try. If the fragment is missing or wrong, the browser finds out when
 * the blob refuses to open, which is the only place that can find out.
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

  // Whether this invitation carries a key is read from the invitation rather than from its role: the
  // database has a `CHECK` that the two go together, and the thing the page actually depends on is the blob.
  const keyed = found.invite.sealed_key !== null;

  return sendPage(response, 200, page({
    title: `Join ${found.invite.practice_name}`,
    body: html`
      <h1>Join ${found.invite.practice_name}</h1>
      ${keyed
        ? html`<p>You have been invited to a practice on this Tickmark. You will get your own login and your
            own passphrase, and you will be able to open the documents clients have already sent.</p>`
        : html`<p>You have been invited to help ${found.invite.practice_name} collect documents from their
            clients — asking for them, chasing them, and keeping track of what has arrived.</p>
            <p class="info"><strong>You will not be able to open the documents themselves.</strong> That is not
            a setting: what clients send is sealed to a key you are not being given, so nobody — not the
            practice, not whoever runs the server — can grant it to you later. It is also why this invitation
            asks for fewer things than the other kind.</p>`}
      ${error ? html`<p class="error">${error}</p>` : ''}
      <form method="post" action="/invite/${params[0]}" id="accept-form">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="username">
        <label for="password">Password <span class="note">for signing in</span></label>
        <input id="password" name="password" type="password" required minlength="${MIN_PASSWORD}"
          autocomplete="new-password">
        ${keyed
          ? html`<label for="passphrase">Passphrase <span class="note">protects the key; it is not stored anywhere</span></label>
              <input id="passphrase" name="passphrase" type="password" autocomplete="new-password">
              <label for="again">Passphrase again</label>
              <input id="again" name="again" type="password" autocomplete="new-password">`
          : ''}
        <input type="hidden" name="wrapped_private_key" id="wrapped_private_key">
        <button type="submit">Join</button>
      </form>
      <p class="status" id="accept-status"></p>
      ${keyed
        ? html`<p class="note">Your browser opens the invitation with a secret that came in the link itself.
            That secret is never sent to the server, which is why this page needs JavaScript.</p>`
        : html`<p class="note">Nothing on this page needs JavaScript — there is no key to open.</p>`}
      <script type="application/json" id="invite-blob">${raw(JSON.stringify({ sealed: found.invite.sealed_key }))}</script>
      ${keyed ? raw('<script type="module" src="/assets/invite.js"></script>') : ''}`,
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
  const keyed = found.invite.sealed_key !== null;

  if (keyed && (field(fields, 'passphrase') || field(fields, 'again'))) {
    // A filled passphrase field means the browser did not run: the form posts those fields only because
    // they exist, and the script clears them before submitting. Saying so is better than creating a
    // member whose key copy is empty. An assistant's invitation has no such fields, so this cannot fire
    // for one — which is why it is asked only of the shape that has them.
    return refuse('That did not arrive the way it should have. This page needs JavaScript, because the key is sealed in your browser.');
  }

  const problem = validateCredentials(email, password);
  if (problem) return refuse(problem);

  // The one shape check the server can make: a keyed invitation must arrive with a sealed copy, and a
  // keyless one must not be given one. `claimInvite` would ignore a key on a keyless invitation anyway,
  // and refusing it here says so at the door rather than silently discarding it.
  if (keyed && !/^pbkdf2\$sha-256\$/.test(wrapped ?? '')) {
    return refuse('That did not arrive with a sealed copy of the key. If this page is open in an old tab, reload it from the link.');
  }
  if (!keyed && wrapped) {
    return refuse('That invitation does not carry a key, so there is nothing to seal. Reload the page from the link and try again.');
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
/**
 * Change what a member may do.
 *
 * Refusals are sentences rather than codes, because the two ways this can be turned down are not the same
 * news: "there is nobody by that name" and "that is the only owner" want different things done about them.
 * The second is the one that matters — demoting the last owner would leave a practice with nobody who can
 * invite a replacement, and the only way back in would be a hand-edit of the database.
 */
async function changeRolePage({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const wanted = field(fields, 'role') ?? '';

  if (!ROLES.includes(wanted)) {
    return fail(
      response,
      400,
      `"${wanted}" is not one of the roles. It has to be one of: ${ROLES.join(', ')}.`,
      practitioner,
    );
  }

  const changed = setRole(db, practiceId, params[0], wanted);
  if (changed.state === 'no-such-member') {
    return fail(response, 404, 'There is nobody by that name in this practice.', practitioner);
  }
  if (changed.state === 'last-owner') {
    return fail(
      response,
      400,
      'That is the only owner. Make somebody else an owner first — otherwise there would be nobody left who can invite, remove, or change a member.',
      practitioner,
    );
  }

  return redirect(response, '/members?changed=1');
}

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

/** The practice's decision about being told when a client sends something. */
async function setNotifyPage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  setPracticeNotify(db, practiceId, field(fields, 'notify') === '1');
  return redirect(response, '/members?saved=notify');
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

  // **`field()` cannot tell "posted blank" from "not posted"** — it answers `fallback` for both. One handler
  // serves a form that carries a name, a zone and two contact fields, so a partial post would otherwise wipe
  // whatever it never mentioned. `hasOwn` is what distinguishes them, and that distinction is the whole
  // reason the timezone is not silently reset by every rename.
  const posted = (name) => Object.hasOwn(fields, name);

  // The zone is refused rather than silently ignored, because a practice that picks a zone and finds their
  // overdue dates unchanged has no way to tell whether it was saved. The form offers a list; this catches a
  // hand-posted value, and the fallback in `clock.js` stays the safety net it was meant to be.
  if (posted('timezone')) {
    const timezone = field(fields, 'timezone') ?? '';
    if (!knownZone(timezone)) {
      return fail(response, 400, `"${timezone}" is not a time zone this server knows. Pick one from the list.`, practitioner);
    }
  }

  // The contact details a client can see. `type="email"` in the form is a convenience, not a check — a
  // hand-posted value has to be refused here or the client's page gets a `mailto:` that does nothing. The
  // shape is deliberately loose, and it is the same one sign-up uses rather than a second opinion.
  if (posted('contact_email')) {
    const email = field(fields, 'contact_email') ?? '';
    if (email !== '' && !EMAIL_SHAPE.test(email)) {
      return fail(response, 400, `"${email}" does not look like an email address. Leave it empty if you would rather not show one.`, practitioner);
    }
  }

  renamePractice(db, practiceId, name);
  if (posted('timezone')) setPracticeTimezone(db, practiceId, field(fields, 'timezone') ?? '');
  if (posted('contact_email') || posted('contact_phone')) {
    setPracticeContact(db, practiceId, {
      email: posted('contact_email') ? field(fields, 'contact_email') : undefined,
      phone: posted('contact_phone') ? field(fields, 'contact_phone') : undefined,
    });
  }
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
    <td>${badge('retired', TONES.done_for)} ${(key.deletedAt ?? '').slice(0, 10)} — its copies were destroyed, so it opens nothing</td>
  </tr>`);

  const rows = live.map((key) => {
    const holds = counts.get(key.id) ?? 0;
    return html`<tr>
      <td>${key.createdAt.slice(0, 19).replace('T', ' ')}</td>
      <td>${key === current
        ? html`${badge(html`<strong>current</strong>`, TONES.done)} new files are encrypted to this one`
        : html`<span class="muted">older — opens the files sent while it was current</span>`}</td>
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
    here: '/keys',
    banner: live.length === 0
      ? html`<p class="warning">This practice has no key yet, so it cannot be sent files.
          <a href="/setup">Make one</a>.</p>`
      : justRetired
        ? html`<p class="success"><strong>Retired.</strong> Its wrapped copies have been destroyed, so it
            cannot open anything. The record of it stays below — and any copy of a file sealed to it that
            you kept or backed up cannot be opened any more.</p>`
        : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Keys</h1>
          <p class="sub">Every file a client sends is sealed to one of these, in the client's own
          browser. The server holds the wrapped copies and can open none of them.</p>
        </div>
        <div class="do">
          <a class="btn" href="/setup">Make a new key</a>
        </div>
      </div>
      ${live.length === 0
        ? html`<p class="info">There is no key yet. <a href="/setup">Make one</a> and clients can start
            sending.</p>`
        : html`<div class="scroll"><table class="keys">
            <colgroup><col style="width:15%"><col style="width:21%"><col style="width:9%"><col style="width:55%"></colgroup>
            <thead>
              <tr>
                <th align="left">Made</th>
                <th align="left">What it is for</th>
                <th align="left">Files</th>
                <th align="left">Passphrase</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table></div>`}
      ${unaccounted > 0
        ? html`<p class="note">${unaccounted} file${unaccounted === 1 ? '' : 's'} arrived before Tickmark
            recorded which key was used, so which key opens ${unaccounted === 1 ? 'it' : 'them'} is not written
            down anywhere. Nothing is lost — the key that opens a file is whichever one decrypts it — but it
            means those files are not counted in the column above, and <strong>moving files to a new key
            cannot touch them</strong>, because the pass works from that count.</p>`
        : ''}
      <section class="card">
        <h2>Retiring an old key</h2>
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
        <p class="note">Changing a passphrase does not change the key, so nothing has to be
        re-encrypted and no file becomes unopenable. Store the new one somewhere that is not this
        server: a copy of a key without its passphrase is a file nobody can open.</p>
      </section>
      ${retired.length > 0
        ? html`<section class="card">
            <h2>Retired keys</h2>
            <div class="scroll"><table>
              <thead><tr><th align="left">Made</th><th align="left">What became of it</th></tr></thead>
              <tbody>${retiredRows}</tbody>
            </table></div>
            <p class="note">Kept as a record rather than deleted: a key that vanished would take with it the
            only evidence of what it opened.</p>
          </section>`
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
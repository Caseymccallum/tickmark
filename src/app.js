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
import { createReadStream } from 'node:fs';
import { open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.js';
import {
  EMAIL_SHAPE,
  CHALLENGE_COOKIE,
  COOKIE_NAME,
  MIN_PASSWORD,
  challengeCookie,
  challengeFor,
  clearChallengeCookie,
  clearSessionCookie,
  clearTwoFactor,
  confirmTwoFactor,
  createSession,
  endChallenge,
  endAllSessionsExcept,
  endSession,
  endSessionById,
  sessionIdFor,
  sessionsOf,
  parseCookies,
  practitionerFor,
  recordAcceptedStep,
  sessionCookie,
  setPendingSecret,
  spendRecoveryCode,
  spendAttemptOn,
  startChallenge,
  twoFactorState,
  unusedRecoveryCodes,
  validateCredentials,
} from './auth.js';
import {
  codeStepFor,
  generateRecoveryCodes,
  generateSecret,
  inGroups,
  otpauthUri,
} from './totp.js';
import { RequestError, field, formFields, originOf, parseItems, readBody } from './http.js';
import { SECURITY_HEADERS, TONES, badge, empty, fail, html, page, raw, redirect, REQUEST_STATE_WORDS, requireSignIn, section, sendCsv, sendJson, sendPage, stateTone, tile } from './views.js';

import { now } from './db.js';
import { VERSION } from './version.js';
import { MailError, mailHtml, sendMail } from './mailer.js';
import { agoWords, dateIn, monthIn } from './clock.js';
import { createAttemptLimiter } from './ratelimit.js';
import { holdsKey, refusalFor, roleMeets } from './roles.js';
// The two drafts the send pages in this file still write: the opening ask, and the reminder. The notification that
// fires on its own, the arrival draft behind it and the shared sign-off all live in `src/notices.js` — `docs/audit.md`
// §3's first step.
import { openingDraft, reminderDraft } from './notices.js';
// The client's side: the page behind a link, and the five things a client can do on it. `docs/audit.md` §3's second
// step, and the module the product's central claim is closest to — see `src/client-portal.js`.
import { clientMessage, clientPage, clientSays, receiveExtra, receiveUpload } from './client-portal.js';
// The practice's key: making one, seeing them, moving files onto a new one, changing a passphrase. The third step of
// the split — `docs/audit.md` §3 — and the only part of the product that handles key material at all.
import { changePassphrase, keysPage, moveWithoutScript, pendingFor, reencryptFile, retireKey, saveKeys, setupForm } from './keys-views.js';
// The board and the request page: the part of this file a practice looks at all day. Step four of the split in
// docs/audit.md — see src/board-views.js for what is in it and what deliberately is not.
import { createRequestPage, listRequests, newRequestForm, requestsCsv, viewRequest } from './board-views.js';
// Who is in the practice, how somebody joins it, and what the practice is called - the fifth module, which the
// audit's four-step plan did not name. See src/members-views.js.
import { acceptInvite, changeRolePage, createInvitePage, invitePage, membersPage, removeMemberAction, removeMemberPage, renamePracticePage, revokeInviteAction, setNotifyPage } from './members-views.js';
import {
  MAX_TEMPLATE_NAME,
  addItems,
  addTemplateItems,
  clearItemAttention,
  clientFor,
  clientSummaries,
  clientsForBulkSend,
  clientsDueForAsking,
  closeRequest,
  createPractitioner,
  createPractice,
  createTemplate,
  deleteTemplate,
  removeTemplateItem,
  renameTemplate,
  filesForPractice,
  fileCountFor,
  templateFor,
  templateItemsOf,
  templatesOf,
  createRequest,
  findOrCreateClient,
  history,
  inTransaction,
  issueToken,
  logContact,
  markArrivalsChecked,
  outstandingForPractice,
  progressForPractice,
  outstandingOf,
  practiceFor,
  previousChecklistFor,
  requestsForClient,
  updateClient,
  itemsOf,
  practitionerByEmail,
  recordEvent,
  reopenRequest,
  requestFor,
  requestsFor,
  revokeToken,
  setItemAttention,
  setItemReviewed,
  setItemLabel,
  setItemWithdrawn,
  updateRequest,
  setCadence,
  setPractitionerEmail,
  setPractitionerPassword,
} from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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
 * How many documents the page draws at a time. The documents table is the one list here that grows
 * without bound — every upload is a row forever — so it is the one list that pages. A hundred is a
 * screenful of scanning; the CSV export gives the whole list for the spreadsheet case.
 */
const FILES_PER_PAGE = 100;
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
  // A person's own sign-in: the password, the address, and where they are signed in. Not gated by
  // role — this is about their account rather than the practice's records, the same reason the
  // two-factor pages above are not.
  ['GET', '/account/password', accountPasswordForm],
  ['POST', '/account/password', changeOwnPassword],
  ['GET', '/account/email', accountEmailForm],
  ['POST', '/account/email', changeOwnEmail],
  ['GET', '/account/sessions', accountSessionsPage],
  ['POST', '/account/sessions/end', endOneSessionPage],
  ['POST', '/account/sessions/end-others', endOtherSessionsPage],
  ['POST', '/signout', signOut],
  ['GET', '/setup', setupForm, 'owner'],
  ['POST', '/setup', saveKeys, 'owner'],
  ['GET', '/keys', keysPage, 'owner'],
  ['POST', /^\/keys\/([^/]+)\/passphrase$/, changePassphrase, 'owner'],
  ['GET', '/members', membersPage, 'owner'],
  ['POST', '/members/invite', createInvitePage, 'owner'],
  // Taking an invitation back before it was used — the escape hatch a leaked link needs. An
  // invitation hands over a copy of the practice's key, so "wait seven days for it to die" was never
  // an answer. Owner-gated with the rest of the members area.
  ['POST', /^\/members\/invite\/([^/]+)\/revoke$/, revokeInviteAction, 'owner'],
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
  // Every document, searchable by name. Not a filter on the board: the board answers "whose turn is it" and this
  // answers "where is that file" — different questions, with different useful orders.
  ['GET', '/files', filesPage, 'accountant'],
  ['GET', '/files.csv', filesCsv, 'accountant'],
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

/** Everything a handler is given, so that every handler has one signature. */
async function contextFor(db, request, response, url, params) {
  const practitioner = practitionerFor(db, request);
  // Resolved here, once, so that no handler has to remember to ask. A handler that needs the person
  // — for a name in the header, or for provenance — uses `practitioner`. One that needs the firm's
  // data uses `practiceId`.
  return { db, request, response, url, params, practitioner, practiceId: practitioner?.practiceId ?? null };
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
    ...SECURITY_HEADERS,
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
  // Sign-up is watched for a different reason than sign-in: nothing here is secret, but everything here is
  // *expensive* — a scrypt hash is 64 MiB of memory and ~100 ms, and every success makes rows. Two buckets,
  // the address and the caller, because one without the other leaves a door open.
  signUpLimiter = createAttemptLimiter(),
  // One client link is a bearer token, and the four write routes behind it accept whatever arrives. A link
  // holder who floods messages or uploads can fill the record and the disk budget; 30 writes a minute is far
  // above anything a person uploading a season's documents does and far below anything that hurts.
  clientLimiter = createAttemptLimiter({ limit: 30, windowMs: 60_000 }),
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
  // Called after a password or address changes, with `{ email, passwordHash }` or
  // `{ oldEmail, newEmail }`. A no-op by default: in a single-tenant install the practitioner row is
  // the only credential store. The SaaS entry injects the mirror that keeps the platform account in
  // step — same seam, same reason as `onLinkIssued`.
  onCredentialChanged = null,
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
          signUpLimiter,
          clientLimiter,
          onLinkIssued: scoped.onLinkIssued,
          onCredentialChanged,
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

async function signUp({ db, request, response, signUpLimiter }) {
  const fields = formFields(await readBody(request));
  const email = field(fields, 'email')?.toLowerCase() ?? null;
  const password = typeof fields.password === 'string' ? fields.password : '';

  // **Sign-up is rate limited too, and unlike sign-in nothing here is secret — the point is the cost.**
  // Every request spends a scrypt hash (64 MiB, ~100 ms) before it creates rows, so an unauthenticated
  // caller could otherwise spend the machine's CPU and fill the database without limit. Two buckets, and
  // *every* attempt counts — successful ones included, because an account creation is the cost, not only
  // a wrong guess: the address being signed up, and where the request came from. The second is what stops
  // one machine minting practices under sixty different emails. Both are separate from the sign-in
  // buckets so that a busy sign-up day cannot lock anybody out of signing in.
  const buckets = [`signup:${email ?? ''}`, `signup-ip:${request.socket?.remoteAddress ?? ''}`];
  const blockedFor = Math.max(0, ...buckets.map((key) => signUpLimiter?.blockedFor(key) ?? 0));
  if (blockedFor > 0) {
    const minutes = Math.ceil(blockedFor / 60000);
    return sendPage(response, 429, page({
      title: 'Too many attempts',
      body: credentialsForm({
        action: '/signup',
        title: 'Too many attempts',
        submit: 'Create it',
        error: `Too many sign-up attempts from here. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        email: email ?? '',
        hint: true,
      }),
    }));
  }
  for (const key of buckets) signUpLimiter?.failed(key);

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
function codeAuthorises(db, practitionerId, code, limiter = null) {
  const state = twoFactorState(db, practitionerId);
  if (state.state !== 'on') return true;
  // These two actions — turning two-factor off, and minting a new recovery sheet — are the ones a stolen
  // *session* would aim at, and neither had a guess budget. The sign-in path has had one since the audit
  // that named it: a six-digit code with unlimited attempts is a million guesses against a door that stays
  // open for as long as the session lasts. Same limiter, its own bucket (so a person fumbling a sign-in
  // code is not locked out of their own account page), and 'blocked' is returned apart from 'wrong'
  // because the two deserve different sentences.
  const key = `two-factor-manage:${practitionerId}`;
  if (limiter && limiter.blockedFor(key) > 0) return 'blocked';
  const step = codeStepFor(state.secret, code);
  if (step !== null && step !== state.lastStep) {
    recordAcceptedStep(db, practitionerId, step);
    limiter?.succeeded(key);
    return true;
  }
  if (spendRecoveryCode(db, practitionerId, code)) {
    limiter?.succeeded(key);
    return true;
  }
  limiter?.failed(key);
  return false;
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
        <h2>Your sign-in</h2>
        <p class="note">The password and the address you sign in with, and every session that is
        signed in as you right now. Changing the password signs out everything else — that is the
        point of changing it.</p>
        <div class="actions">
          <a class="btn" href="/account/password">Change your password</a>
          <a class="btn" href="/account/email">Change your email</a>
          <a class="btn" href="/account/sessions">Where you are signed in</a>
        </div>
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
async function twoFactorNewCodes({ db, request, response, practitioner, signInLimiter }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const allowed = codeAuthorises(db, practitioner.id, field(fields, 'code') ?? '', signInLimiter);
  if (allowed === 'blocked') {
    return fail(response, 429, 'Too many wrong codes for this account. Wait a few minutes and try again — the codes you have still work.', practitioner);
  }
  if (!allowed) {
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

async function twoFactorOff({ db, request, response, practitioner, signInLimiter }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const allowed = codeAuthorises(db, practitioner.id, field(fields, 'code') ?? '', signInLimiter);
  if (allowed === 'blocked') {
    return fail(response, 429, 'Too many wrong codes for this account, so nothing was changed. Wait a few minutes and try again.', practitioner);
  }
  if (!allowed) {
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
async function signInCode({ db, request, response, signInLimiter }) {
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

  // **The second half needs its own guard, and its absence was the most serious thing an audit of this code
  // found.** Two-factor exists to stop somebody who already *knows the password* — that is the entire threat
  // model — and a six-digit code with unlimited attempts is a million guesses against a door that stays open for
  // ten minutes. The password limiter does not cover this: it is consulted before the password is checked, and
  // here the password is long since accepted.
  //
  // Keyed by the practitioner rather than the challenge, so opening a fresh challenge by re-entering the password
  // does not hand an attacker a fresh allowance. And keyed separately from the password bucket, so a person
  // fat-fingering a code does not lock the password path they would use to start again.
  const key = `two-factor:${challenge.practitionerId}`;
  const blockedFor = signInLimiter?.blockedFor(key) ?? 0;
  if (blockedFor > 0) {
    const minutes = Math.ceil(blockedFor / 60000);
    return sendPage(response, 429, page({
      title: 'Too many codes tried',
      body: codeForm({
        error: `Too many wrong codes for that account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or sign in again with your password and a fresh code.`,
      }),
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
    // Two independent guards, because either alone would be a single point of failure: the limiter is injected
    // and a hosted deployment may swap it, and this counter lives on the challenge so it cannot be reset by
    // re-authenticating.
    signInLimiter?.failed(key);
    if (spendAttemptOn(db, challenge.id)) {
      // Out of patience for *this* challenge. Destroyed rather than merely refused, so the budget is not a thing
      // an attacker can sit inside. Signing in again costs the password, which they have — but it costs a fresh
      // challenge with a small budget, and the account-level limiter above keeps counting across all of them.
      endChallenge(db, challenge.id);
      return sendPage(response, 401, page({
        title: 'Too many wrong codes',
        body: codeForm({
          error: 'That was the last attempt for this sign-in, so it has been closed. Start again with your password and a current code.',
        }),
      }));
    }
    return sendPage(response, 401, page({
      title: 'That code was not right',
      body: codeForm({
        error: 'That code was not right. Codes change every thirty seconds, so try the one showing now — or use one of your recovery codes if the phone is not to hand.',
      }),
    }));
  }

  if (fresh) recordAcceptedStep(db, challenge.practitionerId, step);
  signInLimiter?.succeeded(key);
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
    const { messageId } = await sendMail(mailer, {
      to: client.email,
      subject: message.subject,
      body: message.body,
      html: mailHtml(message.body, practiceName),
    });
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
        <colgroup><col class="w26"><col class="w32"><col class="w42"></colgroup>
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
              <th class="w34">Name</th>
              <th class="w10">Documents</th>
              <th class="w30">Standing note</th>
              <th class="num w26">Use it</th>
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
              <thead><tr><th class="w78">Document</th><th class="num w22">Remove</th></tr></thead>
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
 * Every document, in one list, with a box to look for one.
 *
 * **The search looks at what the server has, and the page is honest about that.** Filenames, clients, request
 * titles, and the note a client left beside a file — never the contents, because the server has never seen a
 * document's contents. Somebody typing "2024 statement" and finding nothing needs to know whether that is
 * because they have no such file or because the search cannot read, and a page that stays quiet about it turns a
 * limitation into a suspicion.
 *
 * What it is for is the search a practice does in May: *which client sent the thing I am thinking of*, *what did
 * they call it*, *when did it arrive*. All three are metadata, and all three are here.
 */
function filesPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim();
  // One page of the newest, and a link for more — see `FILES_PER_PAGE`. One extra row is fetched to
  // know whether "more" is honest rather than hopeful.
  const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
  const files = filesForPractice(db, practiceId, { query, limit: FILES_PER_PAGE + 1, offset: from });
  const more = files.length > FILES_PER_PAGE;
  const shown = more ? files.slice(0, FILES_PER_PAGE) : files;
  const total = fileCountFor(db, practiceId);
  const practice = practiceFor(db, practiceId);

  const rows = shown.map((file) => html`<tr>
    <td>
      <span class="cell-t">${file.filename}</span>
      ${file.clientNote ? html`<span class="cell-s">they said: ${file.clientNote}</span>` : ''}
    </td>
    <td class="cell-t">${file.client}</td>
    <td>
      <a href="/requests/${file.requestId}">${file.title}</a>
      ${file.item
        ? html`<span class="cell-s">${file.item}</span>`
        : html`<span class="cell-s">sent without being asked</span>`}
    </td>
    <td class="note">${dateIn(practice?.timezone, new Date(file.uploadedAt))}</td>
    <td class="num note">${readableSize(file.sizeBytes)}</td>
    <td><a class="btn sm" href="/requests/${file.requestId}/files/${file.id}">Download</a></td>
  </tr>`);

  return sendPage(response, 200, page({
    title: 'Documents',
    practitioner,
    here: '/files',
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Documents</h1>
          <p class="sub">Everything clients have sent you, newest first. To ask for something, or to see what is
          still outstanding, the <a href="/requests">board</a> is the place for that.</p>
        </div>
        <div class="do">
          <a class="btn" href="/files.csv${query ? `?q=${encodeURIComponent(query)}` : ''}">Download as CSV</a>
        </div>
      </div>

      <form method="get" action="/files" class="card search-page">
        <input type="search" name="q" value="${query}" placeholder="A filename, a client, a request…"
          aria-label="Search documents" autofocus>
        <button type="submit">Search</button>
        ${query ? html`<a class="btn ghost sm" href="/files">Clear</a>` : ''}
        <p class="note"><strong>This searches the names, not the contents.</strong> The server has never seen
        inside a document — that is the whole point of the product — so it can find
        <code>statements-oct.pdf</code> and cannot find “the page with the overdraft on it”. Your own file names
        and the notes clients leave are what it has to work with.</p>
      </form>

      ${files.length === 0
        ? query
          ? empty(
              'Nothing matches that',
              html`No document, client or request matches “${query}”. Remember that this searches names rather than
              contents — try the client's name, or part of the filename.`,
              html`<a class="btn" href="/files">Show everything</a>`,
            )
          : empty(
              'No documents yet',
              'When a client sends something through a link, it appears here — and it stays searchable by name.',
              html`<a class="btn primary" href="/requests/new">Ask for something</a>`,
            )
        : html`
            <p class="note">${shown.length} ${shown.length === 1 ? 'document' : 'documents'}${query
              ? html` matching “${query}” of ${total} in total`
              : ''}.</p>
            <div class="scroll"><table class="wide">
              <colgroup>
                <col class="w30"><col class="w17"><col class="w23">
                <col class="w12"><col class="w8"><col class="w10">
              </colgroup>
              <thead><tr>
                <th align="left">File</th><th align="left">Client</th><th align="left">Request</th>
                <th align="left">Arrived</th><th align="right">Size</th><th align="left"></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table></div>
            ${more
              ? html`<p class="note">Showing ${from + 1}–${from + shown.length} of ${total}.
                  <a href="/files?q=${encodeURIComponent(query)}&amp;from=${from + FILES_PER_PAGE}">Show more</a>.</p>`
              : from > 0
                ? html`<p class="note">Showing ${from + 1}–${from + shown.length} of ${total}.
                    <a href="/files?q=${encodeURIComponent(query)}">Back to the newest</a>.</p>`
                : ''}`}`,
  }));
}

/** The same list as a spreadsheet, honouring the same search. */
function filesCsv({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim();
  const practice = practiceFor(db, practiceId);

  return sendCsv(response, 'tickmark-documents.csv', [
    ['File', 'Client', 'Request', 'Document asked for', 'Arrived', 'Size (bytes)', 'Client note'],
    ...filesForPractice(db, practiceId, { query }).map((file) => [
      file.filename,
      file.client,
      file.title,
      file.item ?? 'sent without being asked',
      dateIn(practice?.timezone, new Date(file.uploadedAt)),
      file.sizeBytes,
      file.clientNote ?? '',
    ]),
  ]);
}

/** Bytes in the units a person reads, for a table where "1048576" is not an answer. */
function readableSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  // The counts are built once and handed to both callers below. `clientsDueForAsking` works by filtering the client
  // list, so without this it asked for the very same counts a second time — the same pattern the board had.
  const progress = progressForPractice(db, practiceId);
  const everyone = clientSummaries(db, practiceId, progress);
  const needle = query.toLowerCase();
  const timezone = practiceFor(db, practiceId).timezone;
  // Who is due is computed for the *whole* practice, not for what is on screen: the tile counts the work, and a
  // count that changed when somebody typed in the search box would be a count nobody could act on.
  const due = clientsDueForAsking(db, practiceId, { timezone, progress, clients: everyone });
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

  let size;
  try {
    size = (await stat(row.storage_path)).size;
  } catch {
    // The row exists and the file does not: the disk has been changed underneath the record, which
    // is worth saying plainly rather than reporting as a missing upload.
    return fail(response, 500, 'The record of that file is here but the file itself is not. Check the blob directory.', practitioner);
  }

  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/octet-stream',
    'content-length': size,
    // The original filename, so the browser can offer it once the bytes are decrypted. It travels
    // in a header rather than in the path because it is a label the client chose.
    'x-file-name': encodeURIComponent(row.filename),
    'cache-control': 'no-store',
  });
  // Streamed rather than read into memory: one document is bounded by the upload ceiling, and a
  // practice working down a list of twenty saves should not cost the server a file's worth of heap
  // each time. The rows below record the look once the bytes are on their way.
  createReadStream(row.storage_path).pipe(response);

  // **Recorded after the bytes are on their way, never before.** Opening a document is the one thing this
  // product lets somebody do that is worth an audit trail — a firm promising confidentiality should be able to
  // answer "who has seen this client's bank statements?" — and the answer has to survive the file being read.
  // Writing it first would mean a failed read left a record of a look that never happened, which is worse than
  // no record at all.
  //
  // The person travels in `detail`, the way `notice.sent` does, because the event table records what happened to
  // a *request* rather than who did it: the schema has no column for the actor, and adding one would be a
  // migration for a fact that three callers need to say in a sentence.
  recordEvent(db, {
    requestId: found.id,
    kind: 'file.opened',
    detail: `${practitioner.email} — ${row.filename}`,
  });
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
 * `data-select-on-click` selecting the contents is the whole interaction: a practice with a mouse clicks once
 * and types Ctrl-C, which is one more step than a copy button and one fewer than a broken
 * clipboard API in a page served over plain HTTP. The behaviour is one nonced script in `src/views.js`,
 * because a strict CSP refuses inline `on…=` handlers — a nonce can bless a script, never an attribute.
 */
const copyableField = (name, text, rows) => html`
  <label for="${name}">${name}</label>
  <textarea id="${name}" rows="${rows}" readonly data-select-on-click>${text}</textarea>`;

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
    const messageId = await sendMail(mailer, {
      to: found.client_email,
      subject,
      body,
      html: mailHtml(body, practiceFor(db, practiceId)?.name ?? null),
    });
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
          <label for="message">Message <span class="note">what you see is what gets sent — as plain text, and as a styled copy of these same words</span></label>
          <textarea id="message" name="message" rows="18" data-select-on-click>${draft.body}</textarea>
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
    const { messageId } = await sendMail(mailer, {
      to: found.client_email,
      subject,
      body,
      html: mailHtml(body, practiceFor(db, practiceId)?.name ?? null),
    });

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
  // Every document still wanted, and every client's last contact, in two queries rather than two per request. The
  // three N+1s this replaces were the reason the chase page cost more than the board despite showing less.
  const wanted = outstandingForPractice(db, practiceId);
  const contacted = new Map();
  for (const row of db
    .prepare(
      `SELECT e.request_id AS request_id, MAX(e.at) AS at
         FROM event e JOIN request r ON r.id = e.request_id
        WHERE r.practice_id = ? AND e.kind IN ('reminder.sent', 'request.contacted')
        GROUP BY e.request_id`,
    )
    .all(practiceId)) {
    contacted.set(row.request_id, row.at);
  }

  return requestsFor(db, practiceId)
    .map((row) => ({
      ...row,
      outstanding: wanted.get(row.id) ?? [],
      lastContactAt: contacted.get(row.id) ?? null,
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
          <col class="w17"><col class="w24"><col class="w29">
          <col class="w18"><col class="w12">
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
      html: mailHtml(message.body, practiceName),
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
            <colgroup><col class="w22"><col class="w34"><col class="w44"></colgroup>
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
  //
  // `uncheck` is deliberately **not** in the guard: it withdraws the claim rather than making one, and an
  // assistant who noticed "nobody has looked at that yet" is doing coordination. (The old guard also named
  // a `'check-clear'` action, which has never existed in `ITEM_ACTIONS` — the kind of check that protects
  // nothing because nothing can ever match it. One name, one rule.)
  if (!holdsKey(practitioner.role) && action === 'check') {
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

// ---------------------------------------------------------------------------------
// A person's own sign-in: their password, their address, and where they are signed in
// ---------------------------------------------------------------------------------
//
// Before this section, the only way to change a password was `tools/reset-password.mjs` on the
// server's command line — fine for the operator, useless for a member who suspects their password
// is loose and cannot get to the machine. Three pages, all about *this person's* account rather
// than the practice's records, which is why none of them is role-gated.
//
// Two rules run through all of them:
//
// 1. **Changing anything here asks for the current password.** These pages are the prize a stolen
//    session is played for: without the check, a borrowed tab becomes a permanent account. And
//    guessing the current password is bounded by the same limiter as sign-in — a bucket of its own,
//    so a person changing a password cannot lock themselves out of signing in.
// 2. **A password change ends every other session.** The point of changing a password is that
//    whatever else was holding the old one stops working; a change that left a thief's session
//    alive would be a change that only helped the thief.

/** The bucket for guessing at the current password from one of these pages. */
const credentialBucket = (practitionerId) => `credential-guess:${practitionerId}`;

/** Say no when the guess budget is spent. Returns true when the caller may continue. */
function credentialGuessAllowed({ signInLimiter, practitioner, response }) {
  const blockedFor = signInLimiter?.blockedFor(credentialBucket(practitioner.id)) ?? 0;
  if (blockedFor > 0) {
    const minutes = Math.ceil(blockedFor / 60000);
    fail(response, 429, `Too many wrong passwords from here. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, practitioner);
    return false;
  }
  return true;
}

/** Check the current password against the record, counting the attempt either way. */
async function currentPasswordIsRight({ db, signInLimiter, practitioner, current }) {
  const record = practitionerByEmail(db, practitioner.email);
  const right = record ? await verifyPassword(current, record.password_hash) : false;
  if (right) signInLimiter?.succeeded(credentialBucket(practitioner.id));
  else signInLimiter?.failed(credentialBucket(practitioner.id));
  return right;
}

function accountPasswordForm({ response, practitioner, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const changed = url.searchParams.get('changed') === '1';
  return sendPage(response, 200, page({
    title: 'Change your password',
    practitioner,
    here: '/members',
    banner: changed
      ? html`<p class="success"><strong>Saved.</strong> Every other session was signed out — whatever
          was holding the old password stops working.</p>`
      : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/account/two-factor">Your account</a></p>
          <h1>Change your password</h1>
          <p class="sub">The password signs you in. It is not your passphrase — changing it cannot
          open or close a single document, and nothing that has been sent to this practice is
          affected.</p>
        </div>
      </div>
      <form method="post" action="/account/password" class="card narrow stack">
        <label for="current">Your current password</label>
        <input id="current" name="current" type="password" required autocomplete="current-password">
        <label for="fresh">A new password <span class="note">at least ${MIN_PASSWORD} characters</span></label>
        <input id="fresh" name="fresh" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password">
        <label for="again">The new one again</label>
        <input id="again" name="again" type="password" required autocomplete="new-password">
        <div class="row tight"><button type="submit">Change it</button></div>
      </form>
      <p class="note"><a href="/account/sessions">Where you are signed in</a> — worth a look while
      you are here.</p>`,
  }));
}

async function changeOwnPassword({ db, request, response, practitioner, signInLimiter, onCredentialChanged }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const current = typeof fields.current === 'string' ? fields.current : '';
  const fresh = typeof fields.fresh === 'string' ? fields.fresh : '';
  const again = typeof fields.again === 'string' ? fields.again : '';

  if (!credentialGuessAllowed({ signInLimiter, practitioner, response })) return;
  if (!(await currentPasswordIsRight({ db, signInLimiter, practitioner, current }))) {
    return fail(response, 400, 'That is not your current password, so nothing was changed.', practitioner);
  }

  const problem = fresh.length < MIN_PASSWORD
    ? `A password of at least ${MIN_PASSWORD} characters is required.`
    : fresh.length > 1024
      ? 'That password is too long.'
      : fresh !== again
        ? 'Those two are not the same.'
        : null;
  if (problem) return fail(response, 400, problem, practitioner);

  const passwordHash = await hashPassword(fresh);
  setPractitionerPassword(db, practitioner.id, passwordHash);

  // Everything else stops working — including the session a thief is holding. `keepToken` is this
  // browser's own cookie, so the person changing the password is the one who stays signed in.
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  endAllSessionsExcept(db, practitioner.id, token);

  // The hosted layer keeps its platform account in step (same seam as `onLinkIssued`); single-tenant
  // has nowhere else to update.
  onCredentialChanged?.({ email: practitioner.email, passwordHash });

  return redirect(response, '/account/password?changed=1');
}

function accountEmailForm({ response, practitioner, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const changed = url.searchParams.get('changed') === '1';
  return sendPage(response, 200, page({
    title: 'Change your email',
    practitioner,
    here: '/members',
    banner: changed ? html`<p class="success"><strong>Saved.</strong> Sign in with the new address from now on.</p>` : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/account/two-factor">Your account</a></p>
          <h1>Change your email</h1>
          <p class="sub">This is the address you sign in with, and where the practice's notifications
          about your requests are sent. Everyone here sees it on the members page.</p>
        </div>
      </div>
      <form method="post" action="/account/email" class="card narrow stack">
        <label for="current">Your current password</label>
        <input id="current" name="current" type="password" required autocomplete="current-password">
        <label for="email">A new email</label>
        <input id="email" name="email" type="email" required value="${practitioner.email}">
        <div class="row tight"><button type="submit">Change it</button></div>
      </form>`,
  }));
}

async function changeOwnEmail({ db, request, response, practitioner, signInLimiter, onCredentialChanged }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const current = typeof fields.current === 'string' ? fields.current : '';
  const wanted = field(fields, 'email')?.toLowerCase() ?? null;

  if (!credentialGuessAllowed({ signInLimiter, practitioner, response })) return;
  if (!(await currentPasswordIsRight({ db, signInLimiter, practitioner, current }))) {
    return fail(response, 400, 'That is not your current password, so nothing was changed.', practitioner);
  }

  const problem = !wanted
    ? 'An email address is required.'
    : wanted.length > 254
      ? 'That email address is too long.'
      : !EMAIL_SHAPE.test(wanted)
        ? 'That does not look like an email address.'
        : null;
  if (problem) return fail(response, 400, problem, practitioner);
  if (wanted === practitioner.email) return redirect(response, '/account/email?changed=1');

  // An address is how everybody finds everybody here, and the column is UNIQUE: two people sharing
  // one is refused rather than merged, the same rule as two clients with one name.
  const clash = practitionerByEmail(db, wanted);
  if (clash && clash.id !== practitioner.id) {
    return fail(response, 400, 'There is already an account for that email address in this practice.', practitioner);
  }

  const oldEmail = practitioner.email;
  setPractitionerEmail(db, practitioner.id, wanted);
  onCredentialChanged?.({ oldEmail, newEmail: wanted });
  return redirect(response, '/account/email?changed=1');
}

/** Where this person is signed in, and the two ways to stop. */
function accountSessionsPage({ db, request, response, practitioner, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME] ?? '';
  const currentId = sessionIdFor(db, token);
  const sessions = sessionsOf(db, practitioner.id);
  const ended = url.searchParams.get('ended');

  return sendPage(response, 200, page({
    title: 'Where you are signed in',
    practitioner,
    here: '/members',
    banner: ended
      ? html`<p class="success">${ended === '1'
          ? 'That session was signed out.'
          : `${ended} ${ended === '1' ? 'session was' : 'sessions were'} signed out.`}</p>`
      : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/account/two-factor">Your account</a></p>
          <h1>Where you are signed in</h1>
          <p class="sub">Every session that is signed in as ${practitioner.email} right now. A
          session here is a browser holding your cookie — signing one out ends it there.</p>
        </div>
        <div class="do">
          <form method="post" action="/account/sessions/end-others" class="inline">
            <button type="submit">Sign out everywhere else</button>
          </form>
        </div>
      </div>
      ${ended === '0'
        ? html`<p class="note">There was nothing else to sign out — this is the only session.</p>`
        : ''}
      <div class="scroll"><table>
        <thead><tr><th align="left">Signed in</th><th align="left">Expires</th><th align="left"></th></tr></thead>
        <tbody>
          ${sessions.map((row) => html`<tr>
            <td><span class="cell-t">${row.created_at.slice(0, 16).replace('T', ' ')}</span>
              ${row.id === currentId ? html` ${badge('this one', TONES.done)}` : ''}</td>
            <td><span class="muted">${row.expires_at.slice(0, 10)}</span></td>
            <td>${row.id === currentId
              ? html`<span class="muted">use Sign out in the header</span>`
              : html`<form method="post" action="/account/sessions/end" class="inline">
                  <input type="hidden" name="id" value="${row.id}">
                  <button type="submit" class="sm">Sign it out</button>
                </form>`}</td>
          </tr>`)}
        </tbody>
      </table></div>
      <p class="note">Signing out everywhere else is the button for a machine you no longer hold.
      Changing your <a href="/account/password">password</a> does it too, and is the one to reach for
      if you think somebody else has been using your account.</p>`,
  }));
}

async function endOneSessionPage({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const id = field(fields, 'id');
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME] ?? '';

  // Ending the session you are holding is what Sign out is for; this route is for the other ones, and
  // saying so beats signing somebody out from under a form they meant to aim at a row below.
  if (id && id === sessionIdFor(db, token)) {
    return fail(response, 400, 'That is this session. Use Sign out in the header for that.', practitioner);
  }
  if (!id || !endSessionById(db, practitioner.id, id)) {
    return fail(response, 404, 'That session is not one of yours, or it is already gone.', practitioner);
  }
  return redirect(response, '/account/sessions?ended=1');
}

async function endOtherSessionsPage({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME] ?? '';
  const ended = endAllSessionsExcept(db, practitioner.id, token);
  return redirect(response, `/account/sessions?ended=${ended}`);
}
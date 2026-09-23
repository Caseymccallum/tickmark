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
 * **This file is now only that.** Every page lives in a `*-views.js` module beside it — the imports below are the
 * whole of what the route table holds — so what is here is the dispatcher, the table, and the two things only this
 * file can do: serving the browser's scripts from an allowlist, and answering the health check. `docs/splitting.md`
 * records how that happened and the recipe that got it there; the split is finished.
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

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { practitionerFor } from './auth.js';
import { RequestError } from './http.js';
import { SECURITY_HEADERS, fail, requireSignIn, sendJson } from './views.js';

import { VERSION } from './version.js';
import { createAttemptLimiter } from './ratelimit.js';
import { refusalFor, roleMeets } from './roles.js';
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
// A person's own account: their password, their address, and where they are signed in - the last subject to leave
// this file. See src/account-views.js for the two rules every page in it obeys.
import { accountEmailForm, accountPasswordForm, accountSessionsPage, changeOwnEmail, changeOwnPassword, endOneSessionPage, endOtherSessionsPage } from './account-views.js';
// The chase list and every message it can send - the sixth module to leave this file. See src/chase-views.js.
import { CHASE_BUDGET_MS, chasePage, checkAllArrivalsPage, logContactPage, sendAllReminders, setCadencePage, testEmailForm, testEmailSend } from './chase-views.js';
// One request's own actions: its link, its letters and the documents on it - the seventh module to leave this file.
// See src/request-actions.js for the three things in it that are load-bearing.
import { addItemsPage, changeItemPage, closeRequestPage, draftOpening, draftReminder, editRequestForm, issueLink, reopenRequestPage, revokeLink, saveRequest, sendOpening, sendReminder, serveEnvelope } from './request-actions.js';
// The client records, and every document in one list - the tenth module to leave this file. See src/clients-views.js
// for the promise its documents search keeps, and the page that carries last year's checklist into this one.
import { clientsCsv, filesCsv, filesPage, listClients, saveClient, viewClient } from './clients-views.js';
// The templates and their lists, plus the page that closes several requests at once - the eleventh module to leave
// this file. See src/templates-views.js for the two things in it that are load-bearing.
import { addTemplateItemsPage, closeSeveral, closeSeveralPage, createTemplatePage, deleteTemplatePage, removeTemplateItemPage, saveAsTemplate, saveTemplate, templatePage, templatesPage } from './templates-views.js';
// Asking everyone at once: the preview, the run, the per-client opening and the report - the twelfth module to leave
// this file. See src/bulk-ask-views.js for the two rules its code is shaped by.
import { askEveryone, askEveryonePage } from './bulk-ask-views.js';
// The front door: home, signing up, signing in, the second factor and signing out - the thirteenth and last module to
// leave this file. See src/signin-views.js for the three things in it that are deliberate.
import { home, signIn, signInCode, signInCodePage, signInForm, signOut, signUp, signUpForm, twoFactorConfirm, twoFactorNewCodes, twoFactorOff, twoFactorPage, twoFactorStart } from './signin-views.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

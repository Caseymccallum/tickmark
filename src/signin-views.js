/**
 * The front door: home, signing up, signing in, the second factor, and signing out.
 *
 * The last section to leave `app.js`, and the one that had to be last: `createApp`, `contextFor` and `asset` sit just
 * above it and stay behind, because they are what `app.js` is now — the dispatcher and the route table. The thirteenth
 * module out.
 *
 * Three things here are deliberate, and all three are about what a page must not reveal or allow.
 *
 * 1. **A correct password is not always a sign-in.** With two-factor on, `signIn` stops at `startChallenge` and
 *    `signInCode` finishes the job — six digits through `codeAuthorises`, or a recovery code. That is the answer to the
 *    one attack this product cannot undo: an attacker holding the password adding an encryption key of their own, and
 *    every upload afterwards sealed to somebody outside the practice.
 * 2. **Timing and wording are part of the check.** An unknown address spends the same expensive hash as a wrong
 *    password (`spendTheSameTimeAsARealCheck`), one message covers both failures, and a removed member is told the
 *    truth only *after* the password is verified — telling anyone sooner would let them test who used to work at a
 *    firm. Sign-up's buckets count every attempt, successful ones included, because there the cost is the account
 *    being created rather than a wrong guess.
 * 3. **The limiters are kept apart** — sign-in by address, sign-up by address *and* caller — so that a busy sign-up
 *    day cannot lock anybody out of signing in, and one bucket cannot quietly become the other.
 */
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
  endAllSessions,
  endChallenge,
  endSession,
  parseCookies,
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
import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.js';
import { now } from './db.js';
import { field, formFields, originOf, readBody } from './http.js';
import { sendMail } from './mailer.js';
import { alreadyHaveAccountDraft, resetDraft, verifyDraft } from './notices.js';
import {
  claimPasswordReset,
  claimSignup,
  createPasswordReset,
  createSignupToken,
  passwordResetByToken,
  pendingSignupFor,
  practiceFor,
  practitionerByEmail,
  signupByToken,
} from './store.js';
import { codeStepFor, generateRecoveryCodes, generateSecret, inGroups, otpauthUri } from './totp.js';
import { TONES, badge, fail, html, page, redirect, requireSignIn, sendPage, tile } from './views.js';

// ---------------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------------

export function home({ response, practitioner }) {
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

function credentialsForm({ action, title, submit, error = null, email = '', hint = false, footer = null }) {
  return html`
    <div class="center">
      <div class="card">
        <h1>${title}</h1>
        ${error ? html`<p class="error">${error}</p>` : ''}
        <form method="post" action="${action}">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required value="${email}" autocomplete="username" spellcheck="false" autofocus>
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
        ${footer ?? ''}
      </div>
    </div>`;
}

export function signUpForm({ response }) {
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

export async function signUp({ db, request, response, mailer, signUpLimiter }) {
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

  // **The password is hashed before the address is looked up or anything is made, and the order is the
  // point.** A lookup that answers "taken" in a millisecond and "free" after a scrypt hash is a timing
  // oracle for the same question the page refuses to answer. Both paths spend the hash first, so both
  // take the same time — and the hash is the thing `finishByEmail` then waits on.
  const passwordHash = await hashPassword(password);
  return finishByEmail({ db, request, response, mailer, email, kind: 'verify', passwordHash, resend: { email, for: 'verify' } });
}

/** How long a sign-up link waits to be opened, and how long a reset link does. */
const SIGNUP_TOKEN_MINUTES = 24 * 60;
const RESET_TOKEN_MINUTES = 60;

/**
 * The one answer sign-up and password-reset give, for every address that is not obviously mistyped.
 *
 * `link` is shown only when there is no mail server to carry it — the trial fallback the product uses
 * for reminders too ("drafted, not sent"). With a mailer, the link is in the mailbox and nowhere else,
 * which is the whole of what makes this page safe to show for an address that may already have a
 * practice behind it. The two callers pass their own two sentences, because "nothing is created until
 * you do" is true of a sign-up and meaningless at the end of a reset.
 */
function checkYourEmail({ response, link, intro, note, resend = null, resent = false }) {
  return sendPage(response, 200, page({
    title: 'Check your email',
    body: html`<div class="center">
      <div class="card narrow">
        <h1>Check your email</h1>
        ${resent ? html`<p class="success">Sent again.</p>` : ''}
        <p>${intro}</p>
        ${link
          ? html`<p class="warning"><strong>No mail server is configured</strong>, so the link could not
              be sent. In a real install it is in that inbox and nowhere else; for this trial, here it
              is:</p>
              <p><a class="btn" href="${link}">Open the link</a></p>`
          : ''}
        <p class="note">${note}</p>
        ${resend
          ? html`<form method="post" action="/resend" class="inline">
              <input type="hidden" name="email" value="${resend.email}">
              <input type="hidden" name="for" value="${resend.for}">
              <button type="submit" class="sm">Send it again</button>
            </form>`
          : ''}
      </div>
    </div>`,
  }));
}

// --- issuing one of those links, and the one page that answers both -------------
//
// `finishByEmail` is the seam `signUp`, `forgot` and the resend action all go through, so the three
// cannot drift: one place mints the link, one place sends the letter, one place renders the answer.
// The only thing that varies is which of the two is being finished — and, for a re-sent sign-up, where
// the waiting password comes from (a form the first time, a pending row after that).

/** The two sentences each kind of link is answered with. */
function linkOutro(kind, email) {
  return kind === 'reset'
    ? {
        intro: html`If a practice uses <strong>${email}</strong>, a link to set a new password is on its
          way to it now.`,
        note: html`The link works once and expires in an hour. Nothing has been changed just now.`,
      }
    : {
        intro: html`We have sent a link to <strong>${email}</strong>. Open it to finish creating the
          practice — nothing is created until you do.`,
        note: html`The link works once and expires in a day. Nothing has been created just now, and if
          this was not you, nothing will be.`,
      };
}

/**
 * Mint a sign-up link for an address and send the letter it needs — chosen by what is true, but seen
 * only by whoever can read the address. Everyone at a keyboard is answered the same way.
 *
 * The token is minted for a *taken* address too, and deliberately: the reply to whoever is at the
 * keyboard, and the page shown when there is no mail server, must be identical whether the address is
 * new or not. If it is taken, the link is spent for nothing later and says so to whoever opened it —
 * which is only ever the mailbox's owner.
 */
function sendSignupLink(db, request, mailer, email, passwordHash) {
  const taken = Boolean(practitionerByEmail(db, email));
  const token = newToken();
  createSignupToken(db, {
    email,
    passwordHash,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SIGNUP_TOKEN_MINUTES * 60000).toISOString(),
  });
  const link = `${originOf(request)}/verify/${token}`;
  const message = taken
    ? alreadyHaveAccountDraft({ link: `${originOf(request)}/signin` })
    : verifyDraft({ link });
  if (mailer) {
    // A send that fails must not become a 500 that says "that address is taken": the answer is the
    // same whatever the relay did, and the person can ask for another link.
    sendMail(mailer, { to: email, subject: message.subject, body: message.body }).catch(() => {});
  }
  return { link };
}

/** Mint a reset link for an address and send it — only if there is a practice here to reset. */
function sendResetLink(db, request, mailer, email) {
  const record = email && email.length <= 254 ? practitionerByEmail(db, email) : null;
  if (!mailer || !record) return;
  const token = newToken();
  createPasswordReset(db, {
    practitionerId: record.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60000).toISOString(),
  });
  const message = resetDraft({ link: `${originOf(request)}/reset/${token}` });
  sendMail(mailer, { to: email, subject: message.subject, body: message.body }).catch(() => {});
}

/**
 * Issue the link, send the letter, and render the one answer — for a sign-up or a reset.
 *
 * `passwordHash` is the chosen password, and is the one thing a re-sent sign-up has to recover from a
 * pending row (see `pendingSignupFor`): the raw link is never stored, so a new one is minted carrying
 * the same waiting password. `resend`/`resent` keep the "Send it again" button on the page that follows.
 */
function finishByEmail({ db, request, response, mailer, email, kind, passwordHash = null, resend = null, resent = false }) {
  const { intro, note } = linkOutro(kind, email);
  const show = (link) => checkYourEmail({ response, link, intro, note, resend, resent });

  if (kind === 'reset') {
    // A reset link is never shown here — handing it to whoever asked would be a reset for everybody —
    // so with no mail server the answer names the operator's tool instead of showing anything at all.
    if (!mailer) return noMailResetPage(response);
    sendResetLink(db, request, mailer, email);
    return show(null);
  }

  const link = passwordHash ? sendSignupLink(db, request, mailer, email, passwordHash).link : null;
  return show(mailer ? null : link);
}

/** The no-mail-server answer to a lost password: what an operator can do, and no link to anybody. */
function noMailResetPage(response) {
  return sendPage(response, 200, page({
    title: 'Password reset needs a mail server',
    body: html`<div class="center"><div class="card narrow">
      <h1>No mail server here</h1>
      <p>This installation has no mail server configured, so a reset link cannot be sent. Whoever runs
      it can set a new password from the machine itself:</p>
      <pre>node tools/reset-password.mjs</pre>
      <p class="note">See the operations guide. <a href="/signin">Back to sign in</a></p>
    </div></div>`,
  }));
}

// ---------------------------------------------------------------------------------
// Finishing a sign-up, and getting back in
// ---------------------------------------------------------------------------------

/** The one page for every link that cannot be used — spent, expired, or never ours. */
function linkProblem({ response, state }) {
  const words = {
    used: ['That link was already used', 'This link already finished what it was for. Sign in instead.'],
    'just-claimed': ['That link was just used', 'Somebody opened it a moment ago. Sign in instead.'],
    expired: ['That link has expired', 'These links are short-lived on purpose. Ask for a new one.'],
    'email-taken': ['You already have a practice', 'This email address already has a Tickmark practice. Sign in instead.'],
    unknown: ['That link is not one of ours', 'It may have been broken across two lines by your mail client — copy it in full, or start again.'],
  };
  const [title, body] = words[state] ?? words.unknown;
  return sendPage(response, 200, page({
    title,
    body: html`<div class="center">
      <div class="card narrow">
        <h1>${title}</h1>
        <p>${body}</p>
        <div class="row tight"><a class="btn" href="/signin">Sign in</a> <a class="btn" href="/signup">Start again</a></div>
      </div>
    </div>`,
  }));
}

/**
 * The link's landing page: what is about to happen, and one button to let it.
 *
 * A page before the act rather than a `GET` that creates a practice on its own — the same shape the
 * invitation has, for the same reason: making an account is worth one deliberate click and no
 * surprises. The address is shown so a person can see what they are confirming before they confirm it.
 */
export function verifyPage({ db, response, params }) {
  const found = signupByToken(db, params[0]);
  if (found.state !== 'open') return linkProblem({ response, state: found.state });
  // Only the person who can read the address ever reaches this page, so saying "you already have one"
  // here is not the leak that sign-up avoids — it is the same thing they would be told if they tried to
  // sign in, told to the one person entitled to hear it.
  if (practitionerByEmail(db, found.signup.email)) return linkProblem({ response, state: 'email-taken' });
  return sendPage(response, 200, page({
    title: 'Create your practice',
    body: html`<div class="center">
      <div class="card narrow">
        <h1>Create your practice</h1>
        <p>This makes a Tickmark practice for <strong>${found.signup.email}</strong> and signs you in.</p>
        <form method="post" action="/verify/${params[0]}"><button type="submit">Create it</button></form>
        <p class="note">If this was not you, close this page — nothing has been made.</p>
      </div>
    </div>`,
  }));
}

/** The act the page above describes: make the practice, spend the link, sign the person in. */
export function verifyAccount({ db, response, params }) {
  const result = claimSignup(db, { token: params[0] });
  if (result.state === 'created') {
    const { token } = createSession(db, result.practitionerId);
    return redirect(response, '/requests', [sessionCookie(token)]);
  }
  return linkProblem({ response, state: result.state });
}

/** The form that asks which address lost its password. */
export function forgotForm({ response }) {
  return sendPage(response, 200, page({
    title: 'Forgot your password',
    body: html`<div class="center">
      <div class="card narrow">
        <h1>Forgot your password</h1>
        <p>Give the email address you sign in with. If a practice uses it here, we will send a link to set a
        new password — the link is what proves the mailbox is yours.</p>
        <form method="post" action="/forgot" class="stack">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autocomplete="username" autofocus>
          <button type="submit">Send the link</button>
        </form>
        <p class="note"><a href="/signin">Back to sign in</a></p>
      </div>
    </div>`,
  }));
}

/**
 * Ask for a reset link, and say the same thing whatever the address turns out to be.
 *
 * The answer is identical for an address with a practice and one without, for the same reason sign-up's
 * is: "check your email" is the only reply that does not tell the person at the keyboard who has an
 * account. The difference lives in the mailbox, which is the one place it is safe to live. And the link
 * is *never* shown here, even with no mail server — a reset link handed to whoever asked is a password
 * reset for everybody, so the no-mail answer points at the operator's own tool instead.
 */
export async function forgot({ db, request, response, mailer, signInLimiter }) {
  const fields = formFields(await readBody(request));
  const email = field(fields, 'email')?.toLowerCase() ?? null;

  // Cheap, but not free: a send is a way to bother somebody, and asking on repeat is a way to bother a
  // whole address book. Two buckets — the address, and who is asking.
  const buckets = [`forgot:${email ?? ''}`, `forgot-ip:${request.socket?.remoteAddress ?? ''}`];
  const blockedFor = Math.max(0, ...buckets.map((key) => signInLimiter?.blockedFor(key) ?? 0));
  if (blockedFor > 0) {
    const minutes = Math.ceil(blockedFor / 60000);
    return sendPage(response, 429, page({
      title: 'Too many attempts',
      body: html`<div class="center"><div class="card narrow"><h1>Too many attempts</h1>
        <p>Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.</p></div></div>`,
    }));
  }
  for (const key of buckets) signInLimiter?.failed(key);

  // Whether or not there is a practice here, and whether or not the relay accepts it, the answer is the
  // same: the person at the keyboard cannot tell which happened, which is the point.
  return finishByEmail({ db, request, response, mailer, email, kind: 'reset', resend: { email, for: 'reset' } });
}

/**
 * Send a link again, for whoever is waiting on one.
 *
 * A convenience and nothing more: it re-issues through the same `finishByEmail` the first ask did, so a
 * re-sent link is the same link in every way that matters. For a sign-up the waiting password is read
 * back out of the pending row (`pendingSignupFor`) — the raw link is never stored, so "again" mints a
 * new one carrying the same password. Non-enumerating, like the ask it repeats: the answer does not
 * depend on whether the address is here, and the button is on the page for everyone.
 */
export async function resend({ db, request, response, mailer, signInLimiter }) {
  const fields = formFields(await readBody(request));
  const email = field(fields, 'email')?.toLowerCase() ?? null;
  const kind = field(fields, 'for') === 'reset' ? 'reset' : 'verify';

  // A resend is the cheapest way to keep mail at somebody — cheap for the sender, not for them. Same
  // two buckets as the ask it repeats: the address, and who is asking.
  const buckets = [`resend:${email ?? ''}`, `resend-ip:${request.socket?.remoteAddress ?? ''}`];
  const blockedFor = Math.max(0, ...buckets.map((key) => signInLimiter?.blockedFor(key) ?? 0));
  if (blockedFor > 0) {
    const minutes = Math.ceil(blockedFor / 60000);
    return sendPage(response, 429, page({
      title: 'Too many attempts',
      body: html`<div class="center"><div class="card narrow"><h1>Too many attempts</h1>
        <p>Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.</p></div></div>`,
    }));
  }
  for (const key of buckets) signInLimiter?.failed(key);

  const passwordHash = kind === 'verify' ? (pendingSignupFor(db, email)?.password_hash ?? null) : null;
  return finishByEmail({ db, request, response, mailer, email, kind, passwordHash, resend: { email, for: kind }, resent: true });
}

/** The form where a new password is chosen, behind a link that proves the mailbox. */
export function resetForm({ db, response, params, error = null }) {
  const found = passwordResetByToken(db, params[0]);
  if (found.state !== 'open') return linkProblem({ response, state: found.state });
  return sendPage(response, 200, page({
    title: 'Set a new password',
    body: html`<div class="center">
      <div class="card narrow">
        <h1>Set a new password</h1>
        <p>For <strong>${found.reset.email}</strong>. Setting it signs out every other session.</p>
        ${error ? html`<p class="error">${error}</p>` : ''}
        <form method="post" action="/reset/${params[0]}" class="stack">
          <label for="password">A new password</label>
          <input id="password" name="password" type="password" required autocomplete="new-password" autofocus>
          <label for="again">Again</label>
          <input id="again" name="again" type="password" required autocomplete="new-password">
          <button type="submit">Set it</button>
        </form>
      </div>
    </div>`,
  }));
}

/** Spend the reset link, set the password, and end every session that was holding the old one. */
export async function reset({ db, request, response, params, onCredentialChanged }) {
  const token = params[0];
  const fields = formFields(await readBody(request));
  const fresh = typeof fields.password === 'string' ? fields.password : '';
  const again = typeof fields.again === 'string' ? fields.again : '';

  const found = passwordResetByToken(db, token);
  if (found.state !== 'open') return linkProblem({ response, state: found.state });

  const problem = fresh.length < MIN_PASSWORD
    ? `A password of at least ${MIN_PASSWORD} characters is required.`
    : fresh.length > 1024
      ? 'That password is too long.'
      : fresh !== again
        ? 'Those two are not the same.'
        : null;
  if (problem) return resetForm({ db, response, params, error: problem });

  const passwordHash = await hashPassword(fresh);
  const result = claimPasswordReset(db, { token, passwordHash });
  if (result.state !== 'reset') return linkProblem({ response, state: result.state });

  // The point of a reset: whatever was holding the old password stops working. Every session goes,
  // including any a thief is holding — a reset that left those alive would be a change that only helped
  // the thief. (This is the one place `endAllSessions` belongs: a person changing their own password
  // keeps the session they are in, but nobody is signed in here.)
  endAllSessions(db, result.practitionerId);
  onCredentialChanged?.({ email: result.email, passwordHash });

  return redirect(response, '/signin?reset=1');
}

export function signInForm({ response, url }) {
  const reset = url?.searchParams?.get('reset') === '1';
  sendPage(response, 200, page({
    title: 'Sign in',
    banner: reset ? html`<p class="success"><strong>Password changed.</strong> Sign in with the new one.</p>` : null,
    body: credentialsForm({
      action: '/signin',
      title: 'Sign in',
      submit: 'Sign in',
      footer: html`<p class="note"><a href="/forgot">Forgot your password?</a></p>`,
    }),
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
          maxlength="20" spellcheck="false" autocapitalize="none" class="code-input">
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
export function twoFactorPage({ db, response, practitioner, url }) {
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
        <p class="note">The password and the email address you sign in with, and every session that is
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
      spellcheck="false" autocapitalize="none" class="code-input">
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
      <input name="code" inputmode="numeric" maxlength="6" placeholder="code" aria-label="A code" spellcheck="false" autocapitalize="none" required>
      <button type="submit">New recovery codes</button>
    </form>
    <form method="post" action="/account/two-factor/off" class="inline">
      <input name="code" inputmode="numeric" maxlength="20" placeholder="code" spellcheck="false" autocapitalize="none"
        aria-label="A code or a recovery code" required>
      <button type="submit" class="danger">Turn it off</button>
    </form>
  </div>
  <p class="note">Both need a code — from the app, or a recovery code. That is what they are for.</p>`;

/** Generate a secret and hold it, unarmed, so the page can show it. */
export function twoFactorStart({ db, response, practitioner }) {
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
export async function twoFactorConfirm({ db, request, response, practitioner }) {
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
export async function twoFactorNewCodes({ db, request, response, practitioner, signInLimiter }) {
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

export async function twoFactorOff({ db, request, response, practitioner, signInLimiter }) {
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

export async function signIn({ db, request, response, signInLimiter }) {
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
        error: `Too many failed attempts for that email address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or use a different email address to sign in.`,
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
export async function signInCode({ db, request, response, signInLimiter }) {
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
export function signInCodePage({ request, response, db }) {
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

export function signOut({ db, request, response }) {
  const match = /tickmark_session=([^;]+)/.exec(request.headers.cookie ?? '');
  if (match) endSession(db, decodeURIComponent(match[1]));
  return redirect(response, '/', [clearSessionCookie()]);
}

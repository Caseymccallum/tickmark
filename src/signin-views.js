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
import { hashPassword, verifyPassword } from './crypto.js';
import { field, formFields, readBody } from './http.js';
import { createPractitioner, createPractice, inTransaction, practiceFor, practitionerByEmail } from './store.js';
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

function credentialsForm({ action, title, submit, error = null, email = '', hint = false }) {
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

export async function signUp({ db, request, response, signUpLimiter }) {
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

export function signInForm({ response }) {
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

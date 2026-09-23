/**
 * A person's own account: their password, their address, and where they are signed in.
 *
 * The section of `app.js` this was made from, and the last of its subjects to leave it. Three pages, all about *this
 * person* rather than about the practice's records — which is why none of them is role-gated: an assistant may change
 * their own password as freely as an owner may.
 *
 * Two rules run through all of them, and both come from asking what a stolen session is worth:
 *
 * 1. **Changing anything here asks for the current password.** These pages are the prize a stolen session is played
 *    for: without the check, a borrowed tab becomes a permanent account. Guessing the current password is bounded by
 *    the same limiter as sign-in, in a bucket of its own, so that a person changing their own password cannot lock
 *    themselves out of signing in.
 * 2. **A password change ends every other session.** The point of changing a password is that whatever else was
 *    holding the old one stops working; a change that left a thief's session alive would be a change that only helped
 *    the thief.
 *
 * `docs/security.md` states the posture these pages sit in, and what an operator can still do — which is recorded
 * there rather than implied here.
 */
import { COOKIE_NAME, EMAIL_SHAPE, MIN_PASSWORD, endAllSessionsExcept, endSessionById, parseCookies, sessionIdFor, sessionsOf } from './auth.js';
import { hashPassword, verifyPassword } from './crypto.js';
import { now } from './db.js';
import { field, formFields, readBody } from './http.js';
import { practitionerByEmail, setPractitionerEmail, setPractitionerPassword } from './store.js';
import { TONES, badge, fail, html, page, redirect, requireSignIn, sendPage } from './views.js';

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

export function accountPasswordForm({ response, practitioner, url }) {
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

export async function changeOwnPassword({ db, request, response, practitioner, signInLimiter, onCredentialChanged }) {
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

export function accountEmailForm({ response, practitioner, url }) {
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

export async function changeOwnEmail({ db, request, response, practitioner, signInLimiter, onCredentialChanged }) {
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
export function accountSessionsPage({ db, request, response, practitioner, url }) {
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

export async function endOneSessionPage({ db, request, response, practitioner }) {
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

export async function endOtherSessionsPage({ db, request, response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME] ?? '';
  const ended = endAllSessionsExcept(db, practitioner.id, token);
  return redirect(response, `/account/sessions?ended=${ended}`);
}

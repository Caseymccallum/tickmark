/**
 * Who is in the practice, how somebody joins it, and what the practice is called.
 *
 * **Not one of the four steps `docs/audit.md` §3 proposed** — those were the letters, the client's side, the key and
 * the board. This is the fifth, and it exists because of what the plan left out: once those four were gone, this and
 * the account pages were the last things in `app.js` that were about a *subject* rather than about routing.
 *
 * Two halves, both about the same question — who can do what:
 *
 * 1. **The members half** is the only place a person's access changes. An invitation is created, claimed and revoked,
 *    a role is changed, a member is removed, and the owners are told about each of those (`tellOwners` — the letter
 *    that exists because the attack this product's threat model describes looks like nothing in the interface).
 * 2. **The settings half** is what the practice says about itself: its name, its timezone, the address clients write
 *    back to, and whether arrivals are announced.
 *
 * The invitation is the delicate part. The key is sealed to a secret *in the browser* and travels in the part of the
 * link a browser never sends to a server, so the server holds a blob it cannot open and a token it can only hash.
 * These pages are therefore the two ends of a seal the server is deliberately not party to — `docs/members.md` is the
 * reasoning, and it is worth reading before changing anything here.
 */
import { EMAIL_SHAPE, MIN_PASSWORD, createSession, sessionCookie, validateCredentials } from './auth.js';
import { COMMON_ZONES, knownZone } from './clock.js';
import { hashPassword, hashToken, newToken } from './crypto.js';
import { now } from './db.js';
import { field, formFields, readBody } from './http.js';
import { tellOwners } from './notices.js';
import { ROLE_WORDS, ROLES, roleName } from './roles.js';
import {
  claimInvite,
  createInvite,
  inviteByToken,
  invitesOf,
  memberIn,
  membersOf,
  ownersOf,
  practiceFor,
  practiceKeys,
  practitionerByEmail,
  removeMember,
  removedMembersOf,
  renamePractice,
  revokeInvite,
  setPracticeContact,
  setPracticeNotify,
  setPracticeTimezone,
  setRole,
  wrappingHoldersOf,
} from './store.js';
import { TONES, badge, empty, fail, html, jsonTag, page, raw, redirect, requireSignIn, section, sendJson, sendPage } from './views.js';

/**
 * How long an invitation stays usable.
 *
 * Seven days: long enough to survive a weekend and somebody being away, short enough that a link sitting in a mailbox
 * in a year is not a key. It is one number, in one place, and the page says how long is left.
 */
const INVITE_DAYS = 7;

/**
 * How long a practice name may be.
 *
 * Not a database limit — `name` is TEXT and would take anything — but a display one: it appears in the page header, in
 * the table on the members page, and on the page a new member lands on. A hundred and twenty characters is more than
 * any firm needs and short enough to still be a heading.
 */
const MAX_PRACTICE_NAME = 120;

/**
 * Who is in this practice, how to ask someone to join, and what has been asked already.
 *
 * The form is JavaScript-driven because the sealing happens in the browser: the passphrase is typed
 * here, the key is unwrapped here, and the server receives a blob it cannot open. That is the same shape
 * as every other key operation in this product, and it is why the invitation is created by a fetch that
 * returns a token rather than by a form post that returns a page — the secret has to stay in the page
 * that generated it, and a navigation would throw it away.
 */
export function membersPage({ db, response, practitioner, practiceId, url, mailer }) {
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
  const revokedInvite = url.searchParams.get('revoked');
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
        : revokedInvite
        ? html`<p class="success"><strong>That invitation has been taken back.</strong> Whoever holds
            the link can no longer join with it — make a new one if it went to the wrong place.</p>`
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
        <colgroup><col class="w34"><col class="w14"><col class="w34"><col class="w18"></colgroup>
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
            ${jsonTag('invite-key', { keyId: newest.id, wrapped: mine })}
            ${raw('<script type="module" src="/assets/members.js"></script>')}
          </section>`}

      ${invites.length > 0
        ? html`<section class="card">
            <h2>Invitations</h2>
            <div class="scroll"><table>
              <thead><tr><th align="left">Sent by</th><th align="left">When</th><th align="left">Outcome</th><th align="left"></th></tr></thead>
              <tbody>
                ${invites.map((row) => html`<tr>
                  <td><span class="cell-t">${row.created_by_email}</span></td>
                  <td><span class="muted">${row.created_at.slice(0, 10)}</span></td>
                  <td>${row.used_at
                    ? html`accepted by ${row.used_by_email} on ${row.used_at.slice(0, 10)}`
                    : row.revoked_at
                      ? html`${badge('taken back', TONES.done_for)} ${row.revoked_at.slice(0, 10)}`
                      : row.expires_at <= new Date().toISOString()
                        ? html`${badge('expired, and was never accepted', TONES.done_for)}`
                        : html`${badge('not accepted yet', TONES.waiting)}`}</td>
                  <td>${!row.used_at && !row.revoked_at && row.expires_at > new Date().toISOString()
                    ? html`<form method="post" action="/members/invite/${row.id}/revoke" class="inline">
                        <button type="submit" class="sm">Take it back</button>
                      </form>`
                    : ''}</td>
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
export async function createInvitePage({ db, request, response, practitioner, practiceId }) {
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
export async function invitePage({ db, response, params, error = null }) {
  const found = inviteByToken(db, params[0]);

  if (found.state !== 'open') {
    const said = {
      unknown: 'There is no invitation at that address.',
      used: 'That invitation has been used. An invitation works once — ask for another one.',
      revoked: 'That invitation has been taken back by the practice. Ask whoever sent it for a new one.',
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
        <input id="email" name="email" type="email" required autocomplete="username" spellcheck="false">
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
      ${jsonTag('invite-blob', { sealed: found.invite.sealed_key })}
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
export async function acceptInvite({ db, request, response, params }) {
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

  if (claimed.state === 'just-claimed') {
    return refuse('That invitation was accepted somewhere else at the same moment, so it is used up. Ask for a new one.');
  }
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
export async function changeRolePage({ db, request, response, practitioner, practiceId, params, mailer }) {
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

  redirect(response, '/members?changed=1');
  // A role change moves the boundary between "can chase clients" and "can read what they sent", so it
  // is announced alongside the other two changes to who can read what.
  const member = memberIn(db, practiceId, params[0]);
  if (member) {
    await tellOwners(db, practiceId, mailer, {
      subject: `A member's role changed at ${practiceFor(db, practiceId)?.name ?? 'the practice'}`,
      lines: [`${member.email} is now ${ROLE_WORDS[roleName(wanted)]} (changed by ${practitioner.email}).`],
    });
  }
  return;
}

export function removeMemberPage({ db, response, practitioner, practiceId, params, url }) {
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

export async function removeMemberAction({ db, response, practitioner, practiceId, params, mailer }) {
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

  redirect(response, `/members?removed=${encodeURIComponent(result.email)}`);
  // Who is in the practice decides who can read what — the same reason a new key is announced. Sent
  // after the response and best effort; the members page already records the act either way.
  await tellOwners(db, practiceId, mailer, {
    subject: `A member was removed from ${practiceFor(db, practiceId)?.name ?? 'the practice'}`,
    lines: [
      `${result.email} was removed by ${practitioner.email}.`,
      '',
      'Their key copies are gone and their sessions ended. Anything they already downloaded stays theirs — removal is a statement about what happens next.',
    ],
  });
  return;
}

/** The practice's decision about being told when a client sends something. */
export async function setNotifyPage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  setPracticeNotify(db, practiceId, field(fields, 'notify') === '1');
  return redirect(response, '/members?saved=notify');
}

export async function renamePracticePage({ db, request, response, practitioner, practiceId }) {
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

/** Take an invitation back before it was used. Owner-gated, like everything under /members. */
export function revokeInviteAction({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  if (!revokeInvite(db, practiceId, params[0])) {
    return fail(
      response,
      400,
      'That invitation cannot be taken back: it was already used, already taken back, or it is not one of yours.',
      practitioner,
    );
  }
  return redirect(response, '/members?revoked=1');
}

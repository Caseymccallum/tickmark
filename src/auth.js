/**
 * Sessions: who is signed in, and how the browser says so.
 *
 * Sessions live in the database rather than in a signed cookie so that **signing out
 * actually revokes access**. A self-contained signed cookie cannot be un-signed without
 * keeping a list of secrets in the process, which a restart would lose — and "sign out"
 * that does not sign you out is the kind of small lie this codebase is trying not to
 * tell.
 *
 * The token is stored hashed, for the same reason a link token is: a stolen database
 * must not be a set of working sessions.
 */
import { timingSafeEqual } from 'node:crypto';

import { hashToken, newToken } from './crypto.js';
import { newId } from './db.js';
import { CHALLENGE_MINUTES, normaliseRecoveryCode } from './totp.js';

export const SESSION_DAYS = 14;
export const COOKIE_NAME = 'tickmark_session';
/**
 * How long a password has to be. Here rather than in the routing, because two things now need to agree on it:
 * the sign-up form and the command-line tool that replaces a password. A policy enforced in one place and
 * assumed in another is a policy that drifts.
 */
export const MIN_PASSWORD = 12;

/**
 * Cookies are `Secure` unless the operator says otherwise. A local trial over plain
 * HTTP is the only reason to disable it, and doing so must be an explicit act.
 */
export const secureCookies = () => process.env.TICKMARK_INSECURE_COOKIES !== '1';

export function createSession(db, practitionerId, at = new Date()) {
  const token = newToken();
  const expires = new Date(at.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare(
    'INSERT INTO session (id, practitioner_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(newId(), practitionerId, hashToken(token), expires.toISOString(), at.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

/**
 * The person behind a session token, and the practice they belong to, or null. Expired sessions are
 * removed on sight.
 *
 * `hasKey` is asked about the **practice**, not about the person: a key belongs to the firm, so
 * whether this person can be sent files is a question about the firm. The doc comment here used to say
 * "the practice behind a session token" while the row was a practitioner — true when one person was
 * the whole practice, and a sentence that would now be wrong.
 */
export function sessionFor(db, token, at = new Date()) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.expires_at, p.id AS practitioner_id, p.email, p.practice_id, p.removed_at, p.role,
              EXISTS (SELECT 1 FROM practice_key k WHERE k.practice_id = p.practice_id) AS has_key
         FROM session s JOIN practitioner p ON p.id = s.practitioner_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  // A second lock on the same door. Removing a member deletes their sessions, so a live session for a
  // removed member should not exist — and if one somehow did, using it must still fail. The row is not
  // deleted here either: it is the record of when that person stopped being a member.
  if (row.removed_at !== null) return null;
  if (row.expires_at <= at.toISOString()) {
    db.prepare('DELETE FROM session WHERE id = ?').run(row.id);
    return null;
  }
  // `hasKey` travels with the identity because a practice without a key cannot be sent files, and
  // every signed-in page needs to know that without asking the database again.
  //
  // `role` travels with it for the same reason and one more: it is what every permission check reads, and a
  // check that has to fetch it separately is a check somebody will forget to make. Null is carried through
  // rather than resolved here — what a null means is the model's business, not the session's, and
  // `src/roles.js` is where that is written down.
  return {
    id: row.practitioner_id,
    email: row.email,
    practiceId: row.practice_id,
    role: row.role,
    hasKey: row.has_key === 1,
  };
}

export function endSession(db, token) {
  if (typeof token !== 'string' || token.length === 0) return;
  db.prepare('DELETE FROM session WHERE token_hash = ?').run(hashToken(token));
}

/**
 * Every session belonging to one person, gone. Returns how many.
 *
 * `endAllSessions` used to live here described as "the sign out everywhere that a passphrase change
 * needs". It was called from nowhere and the description was wrong — a session is created by signing in
 * with a password, so changing a passphrase neither needs nor justifies ending one. It was removed as
 * dead code in stage B of `docs/members.md`, with a note saying that removing a member would want
 * exactly this and that it was three lines to bring back.
 *
 * It did, and this is it. `removeMember` is the caller: a member who has been removed must not keep
 * working in a tab they already have open, and a session that outlives the membership is a signed-in
 * stranger.
 */
export function endAllSessions(db, practitionerId) {
  return db.prepare('DELETE FROM session WHERE practitioner_id = ?').run(practitionerId).changes;
}

// ---------------------------------------------------------------------------------
// Two-factor: the second half of a sign-in
// ---------------------------------------------------------------------------------

export const CHALLENGE_COOKIE = 'tickmark_challenge';

/**
 * Where a sign-in waits while somebody finds their phone.
 *
 * Created **only after the password has already been checked**, which is what makes this table safe to reason
 * about: a row here means "somebody who knows this password", and nothing else. It grants no access, so a
 * stolen challenge is worth nothing on its own — the code is the other half of the same door.
 */
export function startChallenge(db, practitionerId, at = new Date()) {
  const token = newToken();
  const expires = new Date(at.getTime() + CHALLENGE_MINUTES * 60 * 1000);
  db.prepare(
    'INSERT INTO login_challenge (id, practitioner_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(newId(), practitionerId, hashToken(token), expires.toISOString(), at.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

/**
 * The person a half-finished sign-in belongs to, or null. Expired challenges are removed on sight, the same
 * way expired sessions are.
 */
export function challengeFor(db, token, at = new Date()) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = db
    .prepare('SELECT id, practitioner_id, expires_at FROM login_challenge WHERE token_hash = ?')
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at <= at.toISOString()) {
    db.prepare('DELETE FROM login_challenge WHERE id = ?').run(row.id);
    return null;
  }
  return { id: row.id, practitionerId: row.practitioner_id };
}

/**
 * Spend a challenge. Deleting the row rather than marking it is deliberate: a `session` row has to survive
 * to be revoked, but a challenge has nothing to remember. Its whole life is "a password was right and a code
 * has not been given yet", and once the code has been given that sentence is finished.
 */
export const endChallenge = (db, id) => db.prepare('DELETE FROM login_challenge WHERE id = ?').run(id).changes;

export function challengeCookie(token, secure = secureCookies()) {
  return [
    `${CHALLENGE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${CHALLENGE_MINUTES * 60}`,
  ]
    .concat(secure ? ['Secure'] : [])
    .join('; ');
}

export const clearChallengeCookie = (secure = secureCookies()) =>
  [`${CHALLENGE_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    .concat(secure ? ['Secure'] : [])
    .join('; ');

/**
 * Where this person's second factor stands.
 *
 * Three states rather than a boolean, because "started and never confirmed" is a real state that behaves
 * like *nothing is set up* — the sign-in page ignores it — and reporting it as "on" would be the kind of
 * claim that makes somebody believe they are protected when they are not.
 */
export function twoFactorState(db, practitionerId) {
  const row = db
    .prepare('SELECT totp_secret, totp_confirmed_at, totp_last_step FROM practitioner WHERE id = ?')
    .get(practitionerId);
  if (!row || !row.totp_secret) return { state: 'off' };
  if (!row.totp_confirmed_at) return { state: 'unconfirmed', secret: row.totp_secret };
  return { state: 'on', secret: row.totp_secret, lastStep: row.totp_last_step };
}

/** Save a secret without arming it. Inert until a code has been checked against it. */
export function setPendingSecret(db, practitionerId, secret) {
  db.prepare(
    'UPDATE practitioner SET totp_secret = ?, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?',
  ).run(secret, practitionerId);
}

/** Arm it, and write down the codes for the day the phone is gone. */
export function confirmTwoFactor(db, practitionerId, codes, at = new Date()) {
  db.prepare('UPDATE practitioner SET totp_confirmed_at = ? WHERE id = ?').run(at.toISOString(), practitionerId);
  db.prepare('DELETE FROM recovery_code WHERE practitioner_id = ? AND used_at IS NULL').run(practitionerId);
  const insert = db.prepare('INSERT INTO recovery_code (id, practitioner_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
  for (const code of codes) {
    insert.run(newId(), practitionerId, hashToken(normaliseRecoveryCode(code)), at.toISOString());
  }
}

/** Turn it off: the secret goes, and so do the codes that stood in for it. */
export function clearTwoFactor(db, practitionerId) {
  db.prepare(
    'UPDATE practitioner SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?',
  ).run(practitionerId);
  db.prepare('DELETE FROM recovery_code WHERE practitioner_id = ?').run(practitionerId);
}

/**
 * Remember which step a code was accepted for.
 *
 * Without this the same six digits work for the whole ninety-second window, so a code read off somebody's
 * screen over their shoulder stays usable *after* they have used it. A step already recorded is refused,
 * which is the difference between "a code" and "one use of a code".
 */
export const recordAcceptedStep = (db, practitionerId, step) =>
  db.prepare('UPDATE practitioner SET totp_last_step = ? WHERE id = ?').run(step, practitionerId);

/**
 * Spend a recovery code, if it is one and it has not been spent. Returns true once, ever, per code.
 *
 * Every unused code for this person is compared in constant time rather than looked up by digest: a lookup is
 * a single indexed read whose *timing* says whether a code exists, and this is a table of eight rows, so
 * doing it properly costs nothing.
 */
export function spendRecoveryCode(db, practitionerId, code, at = new Date()) {
  const normalised = normaliseRecoveryCode(code);
  if (normalised.length === 0) return false;
  const digest = Buffer.from(hashToken(normalised));
  const rows = db
    .prepare('SELECT id, code_hash FROM recovery_code WHERE practitioner_id = ? AND used_at IS NULL')
    .all(practitionerId);
  const match = rows.find((row) => timingSafeEqual(Buffer.from(row.code_hash), digest));
  if (!match) return false;
  return (
    db.prepare('UPDATE recovery_code SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at.toISOString(), match.id)
      .changes === 1
  );
}

/** How many are left, for the page that has to warn somebody before they run out. */
export const unusedRecoveryCodes = (db, practitionerId) =>
  db.prepare('SELECT COUNT(*) AS n FROM recovery_code WHERE practitioner_id = ? AND used_at IS NULL').get(practitionerId).n;

export function parseCookies(header) {
  const jar = {};
  if (typeof header !== 'string') return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0) jar[name] = decodeURIComponent(value);
  }
  return jar;
}

export function sessionCookie(token, secure = secureCookies()) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSessionCookie(secure = secureCookies()) {
  const attributes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** The signed-in practice for a request, or null. */
export function practitionerFor(db, request) {
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  return sessionFor(db, token);
}
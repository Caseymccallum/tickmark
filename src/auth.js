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
import { hashToken, newToken } from './crypto.js';
import { newId } from './db.js';

export const SESSION_DAYS = 14;
export const COOKIE_NAME = 'tickmark_session';

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

/** The practice behind a session token, or null. Expired sessions are removed on sight. */
export function sessionFor(db, token, at = new Date()) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.expires_at, p.id AS practitioner_id, p.email, p.public_key
         FROM session s JOIN practitioner p ON p.id = s.practitioner_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at <= at.toISOString()) {
    db.prepare('DELETE FROM session WHERE id = ?').run(row.id);
    return null;
  }
  // `hasKey` travels with the identity because a practice without a key cannot be sent files,
  // and every signed-in page needs to know that without asking the database again.
  return { id: row.practitioner_id, email: row.email, hasKey: row.public_key !== null };
}

export function endSession(db, token) {
  if (typeof token !== 'string' || token.length === 0) return;
  db.prepare('DELETE FROM session WHERE token_hash = ?').run(hashToken(token));
}

/** Every session for a practice — the "sign out everywhere" that a passphrase change needs. */
export function endAllSessions(db, practitionerId) {
  db.prepare('DELETE FROM session WHERE practitioner_id = ?').run(practitionerId);
}

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
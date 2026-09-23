/**
 * The cryptographic primitives the server needs, and nothing more.
 *
 * Three jobs: turn a password into something safe to store, make and digest the tokens
 * that stand in for a client's access, and compare secrets without leaking their
 * content through timing. Everything else the product needs is done by the *browser*,
 * because the files are encrypted before they ever reach this process.
 *
 * House rule, and the reason this file is separate: nothing here may be reimplemented
 * elsewhere. A second way to hash a password is a second way to get it wrong.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/**
 * Password hashing parameters. Chosen deliberately rather than copied:
 *
 * - `N = 2^16` (64 MiB of memory per guess) and `r = 8`. Below OWASP's scrypt
 *   recommendation of `N = 2^17`, and deliberately so: this runs on whatever small VPS
 *   a practice owns, once per sign-in, and 128 MiB per concurrent attempt is a way to
 *   let a stranger exhaust the machine's memory. `2^16` with `r = 8` is still ~64 MiB,
 *   which is 64 MiB more than an attacker can parallelise for free.
 * - The parameters are stored *with* the hash, so they can be raised later without
 *   invalidating existing accounts.
 */
export const SCRYPT = { N: 2 ** 16, r: 8, p: 1, keylen: 32 };
const MAX_MEM = 128 * 1024 * 1024;

/** Hash a password for storage: `scrypt$N=..,r=..,p=..$salt$hash`, all base64url. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('a password is required');
  }
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    `N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}`,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Check a password against a stored hash. Returns false rather than throwing for a
 * malformed record, because a corrupted row must not become a 500 that tells an
 * attacker the account exists.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const params = Object.fromEntries(
    parts[1].split(',').map((pair) => {
      const [key, value] = pair.split('=');
      return [key, Number(value)];
    }),
  );
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;

  // A stored record is untrusted input: it is data from a database that could have
  // been edited, and `N` from a hostile row is a request for gigabytes of memory.
  if (params.N > 2 ** 18 || params.r > 16 || params.p > 4) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[2], 'base64url');
    expected = Buffer.from(parts[3], 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await scrypt(password.normalize('NFC'), salt, expected.length, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM,
  });
  return timingSafeEqual(actual, expected);
}

/** A link token or a session token: 256 bits, URL-safe. */
export const newToken = () => randomBytes(32).toString('base64url');

/** What gets stored for a token. The token itself is never persisted. */
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
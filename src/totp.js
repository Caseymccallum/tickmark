/**
 * Two-factor authentication, from the standard rather than from a package.
 *
 * This is RFC 6238 (TOTP) over RFC 4226 (HOTP), which is what every authenticator app implements. It is
 * about a hundred lines of `node:crypto`, so there is nothing here worth a dependency — and a security
 * primitive this project can read, print and test against the specification's own vectors is worth more
 * than one it has to trust.
 *
 * ### Why this product, of all products, needs it
 *
 * The passphrase protects the *key*; the password protects the *account*, and until now it was the only
 * thing that did. An attacker with a practice's password cannot read files that were already sent — those
 * are sealed to a key they do not hold. But **uploads are sealed to the practice's public keys**, and a
 * signed-in stranger can add a key wrapping of their own. From that moment every document a client sends is
 * encrypted to somebody outside the practice, silently, with no file ever being decrypted and nothing in
 * any log to notice.
 *
 * That is the attack this closes, and it is why the reason is written here rather than in a changelog.
 *
 * ### The two decisions in the implementation
 *
 * **A window of ±1 step**, not zero. Authenticator apps and the server can disagree about the current
 * minute by a few seconds, and a client that is *always* one step early would otherwise be locked out
 * permanently with a code that looks correct on their phone. The window is one step, so a code is live for
 * at most ninety seconds — long enough to be usable, short enough that a shoulder-surfed code is not.
 *
 * **Comparison is constant-time.** A code is six digits, so a timing attack is a stretch, but a product that
 * guards one comparison carefully and waves another through is a product whose habits cannot be trusted.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32, which is what authenticator apps speak. No padding: our lengths are whole blocks. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const DIGITS = 6;
const STEP_SECONDS = 30;

/** How long a single-use sign-in attempt stays open. See `login_challenge`. */
export const CHALLENGE_MINUTES = 10;

export const CODE_DIGITS = DIGITS;
export const STEP = STEP_SECONDS;

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The reverse. Deliberately forgiving about what people paste — lower case, spaces, and the hyphens some
 * apps insert — because the alternative is a practice failing to set two-factor up because of a separator,
 * and then not having two-factor.
 */
export function base32Decode(text) {
  const cleaned = String(text ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length === 0) throw new Error('no secret');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of cleaned) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`"${character}" is not in the base32 alphabet`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new secret: 160 bits, which is what RFC 4226 recommends for HMAC-SHA1. */
export const generateSecret = () => base32Encode(randomBytes(20));

/** Which time step we are in. The counter is the number of steps since the Unix epoch. */
export const counterAt = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

/** The code for one step. Exported because the tests compare it against the specification's vectors. */
export function codeAt(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();

  // RFC 4226 §5.3, "dynamic truncation": the low nibble of the last byte picks where to read four bytes
  // from, and the top bit is masked off so the result is positive on every platform.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Whether a code is right, allowing one step either side of now.
 *
 * Returns which step matched rather than a boolean, because a caller that stores the last step used can
 * refuse to accept the same step twice — without which a code observed over somebody's shoulder stays
 * usable for the rest of its window even after it has already been used once.
 */
export function codeStepFor(secret, code, { at = Date.now(), window = 1 } = {}) {
  const wanted = String(code ?? '').replace(/\D/g, '');
  if (wanted.length !== DIGITS) return null;

  const current = counterAt(at);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    const expected = codeAt(secret, step);
    // Constant-time, and equal-length by construction: `codeAt` always produces six digits and the check
    // above refuses anything that is not six digits, so the two buffers are the same size.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(wanted))) return step;
  }
  return null;
}

export const verifyCode = (secret, code, options) => codeStepFor(secret, code, options) !== null;

/**
 * What an authenticator app scans or is told.
 *
 * The QR code is the part an app prefers and the part this product cannot draw: generating one needs
 * Reed–Solomon error correction and a rendering library, which is a dependency this project will not take
 * for a screen shown once. So the secret is shown in readable groups for typing, and this URI is offered
 * alongside it for anyone who would rather paste it into a code generator themselves. **Manual entry works
 * in every authenticator app**, which is what makes the omission honest rather than a gap.
 */
export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The secret in groups, because a person is going to type it. */
export const inGroups = (secret, size = 4) => (String(secret ?? '').match(new RegExp(`.{1,${size}}`, 'g')) ?? []).join(' ');

/**
 * Recovery codes.
 *
 * Without these, two-factor is a way to lose an account: phones are lost, replaced, and wiped, and a
 * practice locked out of its own client records by a good security feature is a practice that turns the
 * feature off. Ten characters from an unambiguous alphabet — no `0`/`O`, no `1`/`L`/`I` — because they get
 * read off paper and typed by somebody already having a bad day.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () =>
    Array.from(randomBytes(10), (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join(''),
  );
}

/** How a recovery code is written down and how it is compared: the same normalising, both ways. */
export const normaliseRecoveryCode = (code) => String(code ?? '').toUpperCase().replace(/[\s-]/g, '');

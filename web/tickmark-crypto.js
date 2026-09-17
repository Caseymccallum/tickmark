/**
 * The encryption: one implementation, used by the browser, by the operator's decryptor, and
 * by the tests.
 *
 * This is why this file is a module rather than an inline script. Web Crypto is the same API
 * in a browser and in Node, so the code that encrypts a client's document in their browser
 * is the code the test suite runs — not a second implementation written to agree with it.
 * Nothing here touches the DOM, the filesystem, a clock or the network, and nothing here has
 * a dependency.
 *
 * ## What it does
 *
 * A practice holds an ECDH P-256 key pair. The public half is public; the private half is
 * wrapped under a passphrase with PBKDF2-SHA-256 and AES-GCM before it is stored anywhere. A
 * client's browser generates an ephemeral key pair, derives a shared secret against the
 * practice's public key, and encrypts the file with AES-256-GCM. The server stores a header
 * and a ciphertext, and holds no key that can open either.
 *
 * ## The envelope
 *
 * ```
 * 0   4   magic "TKME"
 * 4   1   envelope version (1)
 * 5   1   curve (1 = P-256, uncompressed point)
 * 6   65  ephemeral public key
 * 71  12  AES-GCM initialisation vector
 * 83  ..  ciphertext, with the GCM authentication tag appended
 * ```
 *
 * The header is passed to AES-GCM as additional authenticated data, so changing one byte of
 * it — including swapping the ephemeral key for an attacker's — makes decryption fail rather
 * than succeed with the wrong key.
 */

const subtle = globalThis.crypto.subtle;
const random = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
const utf8 = (text) => new TextEncoder().encode(text);

export const MAGIC = new Uint8Array([0x54, 0x4b, 0x4d, 0x45]); // "TKME"
export const ENVELOPE_VERSION = 1;
export const CURVE_ID_P256 = 1;
export const CURVE_NAME = 'P-256';
export const PUBLIC_KEY_BYTES = 65;
export const IV_BYTES = 12;
export const HEADER_BYTES = MAGIC.length + 1 + 1 + PUBLIC_KEY_BYTES + IV_BYTES; // 83

/** Web Crypto offers PBKDF2 in a browser; there is no scrypt and no Argon2 in the platform. */
export const KDF = { hash: 'SHA-256', iterations: 600000, saltBytes: 16 };
/** A key record can be handed to someone, so the work it can demand is bounded. */
export const KDF_MAX_ITERATIONS = 4000000;

export const HKDF_INFO = 'tickmark/v1/file-encryption';
export const MIN_PASSPHRASE = 12;

// --- base64url, without Buffer, because this runs in a browser ---------------------------

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// --- the practice's key pair -------------------------------------------------------------

/**
 * Make a practice key pair, with the private half wrapped under a passphrase.
 *
 * The passphrase is never sent anywhere. If it were, the promise would be about a process
 * rather than a property of the file, and the whole claim would rest on the honesty of
 * whoever runs the server — which is what the claim denies.
 */
export async function generatePracticeKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.normalize('NFC').length < MIN_PASSPHRASE) {
    throw new Error(`a passphrase of at least ${MIN_PASSPHRASE} characters is required`);
  }

  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE_NAME }, true, ['deriveBits']);
  const publicKey = await subtle.exportKey('jwk', pair.publicKey);
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));

  const salt = random(KDF.saltBytes);
  const iv = random(IV_BYTES);
  const wrappingKey = await deriveWrappingKey(passphrase, salt);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, pkcs8));

  return {
    publicKey,
    wrappedPrivateKey: [
      'pbkdf2',
      'sha-256',
      KDF.iterations,
      toBase64Url(salt),
      toBase64Url(iv),
      toBase64Url(wrapped),
    ].join('$'),
  };
}

async function deriveWrappingKey(passphrase, salt, iterations = KDF.iterations) {
  const base = await subtle.importKey('raw', utf8(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF.hash },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Unwrap the practice's private key with the passphrase.
 *
 * A wrong passphrase throws, because AES-GCM's tag does not check out — and that is the
 * *only* way this file decides whether a passphrase is right. There is no stored token that
 * says "yes, that is the passphrase", because such a token is a free offline test for anyone
 * who has taken the database. The cost of a single guess is therefore the entire defence,
 * which is why the iteration count is high, is stored with the record, and is bounded so that
 * a record handed to someone cannot demand a minute of their CPU.
 */
export async function unwrapPracticeKey(wrappedPrivateKey, passphrase) {
  const parts = String(wrappedPrivateKey).split('$');
  if (parts.length !== 6 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha-256') {
    throw new Error('that is not a Tickmark key record');
  }
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > KDF_MAX_ITERATIONS) {
    throw new Error('the iteration count in that key record is not usable');
  }

  const salt = fromBase64Url(parts[3]);
  const iv = fromBase64Url(parts[4]);
  const wrapped = fromBase64Url(parts[5]);
  if (salt.length === 0 || iv.length !== IV_BYTES || wrapped.length === 0) {
    throw new Error('that key record is malformed');
  }

  const wrappingKey = await deriveWrappingKey(passphrase, salt, iterations);
  let pkcs8;
  try {
    pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, wrapped);
  } catch {
    throw new Error('that passphrase does not open this key');
  }

  return subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: CURVE_NAME }, false, ['deriveBits']);
}

// --- the file envelope -------------------------------------------------------------------

async function deriveFileKey(sharedBits, ephemeralPublicRaw) {
  const base = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // The ephemeral public key doubles as the HKDF salt, so the derived key is bound to the
      // envelope it will be used with and no extra bytes have to be stored to reproduce it.
      salt: ephemeralPublicRaw,
      info: utf8(HKDF_INFO),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt bytes to a practice's public key, and return the envelope the server will store. */
export async function encryptFile(publicKeyJwk, bytes) {
  const practicePublic = await subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDH', namedCurve: CURVE_NAME },
    false,
    [],
  );
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE_NAME }, true, ['deriveBits']);
  const ephemeralPublicRaw = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));

  const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: practicePublic }, ephemeral.privateKey, 256);
  const fileKey = await deriveFileKey(sharedBits, ephemeralPublicRaw);
  const iv = random(IV_BYTES);

  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = ENVELOPE_VERSION;
  header[5] = CURVE_ID_P256;
  header.set(ephemeralPublicRaw, 6);
  header.set(iv, 6 + PUBLIC_KEY_BYTES);

  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, fileKey, bytes),
  );

  const envelope = new Uint8Array(header.length + ciphertext.length);
  envelope.set(header, 0);
  envelope.set(ciphertext, header.length);
  return envelope;
}

/**
 * What a stored envelope says about itself.
 *
 * The server uses this and cannot open the result: it can tell that an upload is a Tickmark
 * envelope of a version it knows, which is enough to refuse a client's plaintext file
 * instead of storing one and calling it encrypted.
 */
export function readEnvelope(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (array.length < HEADER_BYTES + 1) return { ok: false, reason: 'too short to be an envelope' };
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (array[index] !== MAGIC[index]) return { ok: false, reason: 'not a Tickmark envelope' };
  }
  if (array[4] !== ENVELOPE_VERSION) return { ok: false, reason: `envelope version ${array[4]} is not supported` };
  if (array[5] !== CURVE_ID_P256) return { ok: false, reason: `curve ${array[5]} is not supported` };
  return { ok: true, version: array[4], curve: array[5], head: array.slice(0, HEADER_BYTES) };
}

/** Open an envelope with the practice's private key. Throws if anything about it has changed. */
export async function decryptEnvelope(privateKey, envelope) {
  const info = readEnvelope(envelope);
  if (!info.ok) throw new Error(info.reason);

  const array = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  const header = array.slice(0, HEADER_BYTES);
  const ephemeralPublicRaw = array.slice(6, 6 + PUBLIC_KEY_BYTES);
  const iv = array.slice(6 + PUBLIC_KEY_BYTES, HEADER_BYTES);
  const ciphertext = array.slice(HEADER_BYTES);

  const ephemeralPublic = await subtle.importKey(
    'raw',
    ephemeralPublicRaw,
    { name: 'ECDH', namedCurve: CURVE_NAME },
    false,
    [],
  );
  const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: ephemeralPublic }, privateKey, 256);
  const fileKey = await deriveFileKey(sharedBits, ephemeralPublicRaw);

  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, fileKey, ciphertext);
  return new Uint8Array(plaintext);
}
/**
 * The encryption, tested directly rather than through a browser.
 *
 * That is possible because Web Crypto is the same API in Node as it is in a page, which is
 * the whole reason `web/tickmark-crypto.js` is a module: the code a client's browser runs to
 * encrypt their document is the code under test here. A second implementation written to
 * agree with it would be a second thing to be wrong.
 *
 * What these tests guard, in order of how much they matter:
 *
 * 1. The plaintext does not survive in the envelope the server stores.
 * 2. Nothing about the envelope can be changed without detection — not the ciphertext, not
 *    the header, not the ephemeral key an attacker would want to substitute.
 * 3. The passphrase is the only way in, and the only way to tell it is right is the GCM tag.
 * 4. A key record handed to you cannot make your machine do unbounded work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADER_BYTES,
  KDF_MAX_ITERATIONS,
  MAGIC,
  MIN_PASSPHRASE,
  decryptEnvelope,
  encryptFile,
  generatePracticeKey,
  readEnvelope,
  unwrapPracticeKey,
} from '../web/tickmark-crypto.js';

const PASSPHRASE = 'a passphrase long enough';
const SECRET = 'Bank statement, Q1 2025. Closing balance: 12,345.67';
const bytes = (text) => new TextEncoder().encode(text);

/** A practice, ready to receive files. */
async function practice(passphrase = PASSPHRASE) {
  const key = await generatePracticeKey(passphrase);
  return { ...key, privateKey: await unwrapPracticeKey(key.wrappedPrivateKey, passphrase) };
}

test('a file encrypted to the practice key comes back out byte for byte', async () => {
  const { publicKey, privateKey } = await practice();
  const original = bytes(SECRET);

  const envelope = await encryptFile(publicKey, original);
  const recovered = await decryptEnvelope(privateKey, envelope);

  assert.deepEqual(Array.from(recovered), Array.from(original));
});

test('the envelope the server stores does not contain the file', async () => {
  const { publicKey } = await practice();
  const original = bytes(SECRET);

  const envelope = await encryptFile(publicKey, original);

  assert.ok(
    !Buffer.from(envelope).toString('latin1').includes('12,345.67'),
    'the plaintext must not survive anywhere in the envelope',
  );
  assert.deepEqual(Array.from(envelope.slice(0, 4)), Array.from(MAGIC), 'and it announces what it is');
  assert.equal(
    envelope.length,
    HEADER_BYTES + original.length + 16,
    'header, ciphertext, and the sixteen-byte authentication tag',
  );
});

test('changing one byte of the ciphertext is detected rather than decrypted wrongly', async () => {
  const { publicKey, privateKey } = await practice();
  const envelope = await encryptFile(publicKey, bytes(SECRET));

  for (const index of [HEADER_BYTES, envelope.length - 1]) {
    const tampered = Uint8Array.from(envelope);
    tampered[index] ^= 0x01;
    await assert.rejects(() => decryptEnvelope(privateKey, tampered));
  }
});

test('the header cannot be rewritten, so nobody can substitute their own ephemeral key', async () => {
  const { publicKey, privateKey } = await practice();
  const original = bytes(SECRET);
  const envelope = await encryptFile(publicKey, original);

  // The header is authenticated as additional data. Rewriting part of the ephemeral public
  // key must fail, or an attacker could re-key a file they cannot read.
  const rekeyed = Uint8Array.from(envelope);
  for (let index = 6; index < 38; index += 1) rekeyed[index] ^= 0xff;
  await assert.rejects(() => decryptEnvelope(privateKey, rekeyed), 'the header is authenticated');

  // And a change to the version byte is refused as a format, before any cryptography happens.
  const reversioned = Uint8Array.from(envelope);
  reversioned[4] = 9;
  assert.equal(readEnvelope(reversioned).ok, false);
});

test('the wrong passphrase does not open the key, and says so', async () => {
  const { wrappedPrivateKey } = await practice();
  await assert.rejects(
    () => unwrapPracticeKey(wrappedPrivateKey, 'not the passphrase at all'),
    /does not open this key/,
  );
});

test('another practice cannot open an envelope that was not encrypted to them', async () => {
  const mine = await practice();
  const theirs = await practice('their own passphrase here');

  const envelope = await encryptFile(mine.publicKey, bytes(SECRET));
  await assert.rejects(() => decryptEnvelope(theirs.privateKey, envelope));
});

test('the wrapped key holds neither the passphrase nor anything readable', async () => {
  const { wrappedPrivateKey } = await practice();

  assert.ok(!wrappedPrivateKey.includes(PASSPHRASE));
  assert.ok(!wrappedPrivateKey.includes(Buffer.from(PASSPHRASE).toString('base64url')));
  const parts = wrappedPrivateKey.split('$');
  assert.equal(parts.length, 6, 'a self-describing record: algorithm, hash, iterations, salt, iv, ciphertext');
  assert.equal(parts[0], 'pbkdf2');
  assert.equal(parts[2], '600000', 'the iteration count travels with the record, so it can be raised later');
  assert.ok(!wrappedPrivateKey.includes('BEGIN'), 'it is not a PEM that could be mistaken for a raw key');
});

test('the same file encrypted twice is different bytes, because the keys are ephemeral', async () => {
  const { publicKey, privateKey } = await practice();
  const original = bytes(SECRET);

  const first = await encryptFile(publicKey, original);
  const second = await encryptFile(publicKey, original);

  assert.notDeepEqual(Array.from(first), Array.from(second), 'a fresh ephemeral key and IV each time');
  assert.deepEqual(Array.from(await decryptEnvelope(privateKey, first)), Array.from(original));
  assert.deepEqual(Array.from(await decryptEnvelope(privateKey, second)), Array.from(original));
});

test('the server can tell an envelope from a plain file without being able to open either', async () => {
  const { publicKey } = await practice();

  assert.equal(readEnvelope(await encryptFile(publicKey, bytes(SECRET))).ok, true);
  assert.equal(readEnvelope(bytes(SECRET)).ok, false, 'a plaintext document is not an envelope');
  assert.match(readEnvelope(bytes(SECRET)).reason, /too short/, 'and the reason it gives is the true one');

  const longButNotOurs = new Uint8Array(HEADER_BYTES + 32).fill(0x41);
  assert.equal(readEnvelope(longButNotOurs).ok, false);
  assert.match(readEnvelope(longButNotOurs).reason, /not a Tickmark envelope/);

  assert.equal(readEnvelope(new Uint8Array(0)).ok, false);
  assert.equal(readEnvelope(new Uint8Array(HEADER_BYTES)).ok, false, 'a header with no ciphertext is not a file');
});

test('a key record handed to somebody cannot demand unbounded work from them', async () => {
  const tooExpensive = `pbkdf2$sha-256$${KDF_MAX_ITERATIONS + 1}$AAAA$AAAAAAAAAAAAAAAA$AAAA`;
  await assert.rejects(() => unwrapPracticeKey(tooExpensive, PASSPHRASE), /not usable/);

  await assert.rejects(() => unwrapPracticeKey('not a record at all', PASSPHRASE), /not a Tickmark key record/);
  await assert.rejects(() => unwrapPracticeKey('pbkdf2$sha-256$600000$$$', PASSPHRASE), /malformed/);
});

test('a passphrase below the floor is refused when the key is made', async () => {
  await assert.rejects(() => generatePracticeKey('too short'), new RegExp(`at least ${MIN_PASSPHRASE}`));
  await assert.rejects(() => generatePracticeKey(PASSPHRASE.slice(0, MIN_PASSPHRASE - 1)));
  await generatePracticeKey(PASSPHRASE.slice(0, MIN_PASSPHRASE));
});

test('a passphrase differing only in Unicode normalisation is the same passphrase', async () => {
  // "e" followed by a combining acute, versus the precomposed character: a practice typing
  // the passphrase on one machine and opening a file on another must not be locked out by a
  // difference they cannot see.
  const decomposed = 'caf\u0065\u0301 passphrase long';
  const precomposed = 'caf\u00e9 passphrase long';
  assert.notEqual(decomposed, precomposed, 'these really are different strings');

  const { publicKey, wrappedPrivateKey } = await generatePracticeKey(decomposed);
  const privateKey = await unwrapPracticeKey(wrappedPrivateKey, precomposed);
  const original = bytes(SECRET);
  assert.deepEqual(
    Array.from(await decryptEnvelope(privateKey, await encryptFile(publicKey, original))),
    Array.from(original),
  );
});
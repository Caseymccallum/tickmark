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
  newInviteSecret,
  openInviteBytes,
  privateKeyBytesForTransfer,
  readEnvelope,
  sealPrivateKey,
  unwrapPracticeKey,
  wrapBytesForInvite,
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

/**
 * The invitation, which is the one operation that has to move the practice's private key.
 *
 * The claim being tested is in the last test here: **a new member can open a document that was sent
 * before they joined.** Everything else about the flow is plumbing; that is the thing a two-partner firm
 * actually needs, and it is the reason the key belongs to the practice rather than to a person.
 */
test('an invitation carries the practice key, and only the secret opens it', async () => {
  const { wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const secret = newInviteSecret();

  const blob = await wrapBytesForInvite(await privateKeyBytesForTransfer(wrappedPrivateKey, PASSPHRASE), secret);
  assert.match(blob, /^invite\$sha-256\$/, 'and it says what it is, so it cannot be mistaken for a passphrase record');

  // The right secret opens it and gives back a usable record under a new passphrase.
  const opened = await openInviteBytes(blob, secret);
  assert.ok(opened.length > 0, 'the PKCS#8 bytes come back');
  const resealed = await sealPrivateKey(opened, 'the new member passphrase');
  assert.match(resealed, /^pbkdf2\$sha-256\$600000\$/, 'and they seal into the ordinary record shape');
  assert.ok(resealed !== wrappedPrivateKey, 'which is a different record from the one the practice holds');

  // A wrong secret is refused, and says the same thing whatever is wrong with the link.
  await assert.rejects(() => openInviteBytes(blob, newInviteSecret()), /does not open/);
  await assert.rejects(() => openInviteBytes(blob, `${secret}x`), /does not open/);
  await assert.rejects(() => openInviteBytes('pbkdf2$sha-256$600000$AA$AA$AA', secret), /not a Tickmark invitation/);
  await assert.rejects(() => openInviteBytes(blob, ''), /does not open/);

  // The blob is opaque: nothing about it reveals the key, and the secret is not recoverable from it.
  assert.ok(!blob.includes(secret), 'the secret is not in the blob');
  assert.ok(!blob.includes(wrappedPrivateKey), 'nor is the record the practice stored');
});

test('a member invited after a file was sent can still open that file', async () => {
  // The practice, with a file already sealed to its public key. This is the state a firm is in on the
  // day it hires someone: there is history, and the new member has to be able to read it.
  const { publicKey, wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const envelope = await encryptFile(publicKey, bytes(SECRET));

  // The invitation: the owner's browser unwraps the key with their passphrase and seals it under a
  // secret the server never sees.
  const secret = newInviteSecret();
  const blob = await wrapBytesForInvite(await privateKeyBytesForTransfer(wrappedPrivateKey, PASSPHRASE), secret);

  // The new member's browser: opens the blob with the secret from the fragment, then seals the same key
  // under their own passphrase. The server holds the blob and the result, and neither is readable to it.
  const theirRecord = await sealPrivateKey(await openInviteBytes(blob, secret), 'their own passphrase');

  // And the file that predates them opens.
  const theirKey = await unwrapPracticeKey(theirRecord, 'their own passphrase');
  assert.equal(new TextDecoder().decode(await decryptEnvelope(theirKey, envelope)), SECRET);

  // It is the same key, not a copy that happens to work: the practice's own passphrase still opens the
  // record it started with, so nothing was rotated by inviting someone.
  const original = await unwrapPracticeKey(wrappedPrivateKey, PASSPHRASE);
  assert.equal(new TextDecoder().decode(await decryptEnvelope(original, envelope)), SECRET);
});

test('the new member cannot open the practice key with the invitation secret alone', async () => {
  // Worth stating because it is the boundary: the secret opens the *invitation*, not the practice. Once
  // the new member has re-sealed the key under their own passphrase, the secret is spent.
  const { wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const secret = newInviteSecret();
  const blob = await wrapBytesForInvite(await privateKeyBytesForTransfer(wrappedPrivateKey, PASSPHRASE), secret);

  const theirRecord = await sealPrivateKey(await openInviteBytes(blob, secret), 'their own passphrase');
  await assert.rejects(
    () => unwrapPracticeKey(theirRecord, secret),
    'their record does not open with the invitation secret',
  );
  await assert.rejects(
    () => unwrapPracticeKey(theirRecord, PASSPHRASE),
    'nor with the original passphrase — the records are separate',
  );
});

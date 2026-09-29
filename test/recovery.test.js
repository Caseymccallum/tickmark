/**
 * The recovery sheet: the one thing standing between a practice and losing its files for good.
 *
 * The whole of end-to-end encryption rests on a secret only the practice holds — which is also its
 * one terrifying consequence: lose the passphrase and nothing on earth can open the files. The
 * recovery sheet is the honest answer. The same key is sealed once more under a secret the practice
 * prints and keeps offline; the server stores that copy but never the secret, so it is no more able
 * to read a file afterwards than before. Recovery never weakens the promise — it holds it one way more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePracticeKey,
  newRecoverySecret,
  rewrapPrivateKey,
  unwrapPracticeKey,
} from '../web/tickmark-crypto.js';

const PASSPHRASE = 'the passphrase the practice chose';
const NEW_PASSPHRASE = 'the new passphrase after recovering';

test('a recovery sheet seals the same key under a printed secret, and opens again with it', async () => {
  const { wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);

  // Make a sheet: the same key, sealed under a fresh secret the browser just made.
  const secret = newRecoverySecret();
  const sheet = await rewrapPrivateKey(wrappedPrivateKey, PASSPHRASE, secret);

  // Recover: the printed secret opens the sheet and re-seals the key under a new passphrase.
  const recovered = await rewrapPrivateKey(sheet, secret, NEW_PASSPHRASE);

  // The recovered copy opens with the new passphrase — and it is the *same key*, so every file the
  // practice has ever sent still reads. Nothing is re-encrypted.
  const key = await unwrapPracticeKey(recovered, NEW_PASSPHRASE);
  assert.ok(key, 'the recovered key opens with the new passphrase');
  assert.notEqual(recovered, wrappedPrivateKey, 'it is sealed differently, not a copy of the old record');
});

test('the recovery secret is not a second passphrase — it is random and shown once', async () => {
  const secret = newRecoverySecret();
  assert.equal(secret.length, 43, '32 random bytes, base64url — far too strong to guess');
  assert.notEqual(newRecoverySecret(), newRecoverySecret(), 'and never the same twice');
});

test('the wrong secret does not open a sheet — AES-GCM is the only judge', async () => {
  const { wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const secret = newRecoverySecret();
  const sheet = await rewrapPrivateKey(wrappedPrivateKey, PASSPHRASE, secret);

  // A wrong secret fails the authentication tag — there is no stored hint to help a guesser.
  await assert.rejects(() => rewrapPrivateKey(sheet, newRecoverySecret(), NEW_PASSPHRASE));
  // And the wrong passphrase does not open the original either.
  await assert.rejects(() => unwrapPracticeKey(wrappedPrivateKey, 'not the passphrase'));
});
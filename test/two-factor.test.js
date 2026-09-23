/**
 * Two-factor authentication, tested against the specification before it is tested against itself.
 *
 * The primitive is checked against **RFC 6238's own test vectors** — the appendix of the standard every
 * authenticator app implements — because a TOTP implementation that is wrong in a plausible-looking way
 * (off by a step, wrong byte order, no dynamic truncation) still produces six digits and still *looks*
 * correct. Only the published vectors can tell the difference between "it produces a code" and "it produces
 * the code Google Authenticator would".
 *
 * The flow on top of it is then checked for the things that actually lose people their accounts: a code that
 * works twice, a challenge that never expires, and a recovery-code sheet that cannot be spent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  base32Decode,
  base32Encode,
  codeAt,
  codeStepFor,
  generateRecoveryCodes,
  generateSecret,
  inGroups,
  normaliseRecoveryCode,
  otpauthUri,
  verifyCode,
} from '../src/totp.js';
import {
  challengeFor,
  clearTwoFactor,
  confirmTwoFactor,
  endChallenge,
  recordAcceptedStep,
  setPendingSecret,
  spendRecoveryCode,
  twoFactorState,
  unusedRecoveryCodes,
} from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { createPractice, createPractitioner } from '../src/store.js';

// RFC 6238, Appendix B: the ASCII secret "12345678901234567890", which is this in base32.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('the code is the one the specification says it is', () => {
  // Eight digits in the RFC; the standard's own note is that a six-digit code is the last six of the same
  // number, which is why these are compared as strings rather than recomputed.
  const vectors = [
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130'],
  ];

  for (const [seconds, eight, six] of vectors) {
    const counter = Math.floor(seconds / 30);
    assert.equal(
      codeAt(RFC_SECRET, counter),
      six,
      `T=${seconds} should be ${six} (the RFC's ${eight}, six digits)`,
    );
  }
});

test('base32 survives a round trip, and forgives how people paste', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes, 'every byte value survives');

  const secret = generateSecret();
  assert.equal(secret.length, 32, 'twenty bytes is thirty-two base32 characters');
  assert.equal(base32Decode(secret).length, 20, 'and it is a hundred and sixty bits');
  assert.deepEqual(base32Decode(secret.toLowerCase()), base32Decode(secret), 'case does not matter');
  assert.deepEqual(base32Decode(inGroups(secret)), base32Decode(secret), 'nor do the spaces we show it with');

  assert.throws(() => base32Decode('not-base32!'), /not in the base32 alphabet/, 'and nonsense is refused');
  assert.throws(() => base32Decode(''), /no secret/);
});

test('a code is accepted inside its window and refused outside it', () => {
  const secret = generateSecret();
  const now = 1_800_000_000_000; // a fixed instant, so this tests the window and not the clock
  const step = Math.floor(now / 1000 / 30);
  const correct = codeAt(secret, step);

  assert.notEqual(codeStepFor(secret, correct, { at: now }), null, 'the current code works');
  assert.equal(codeStepFor(secret, codeAt(secret, step + 1), { at: now }), step + 1, 'so does the next step');
  assert.equal(codeStepFor(secret, codeAt(secret, step - 1), { at: now }), step - 1, 'and the one before');
  assert.equal(codeStepFor(secret, codeAt(secret, step + 2), { at: now }), null, 'two steps ahead does not');
  assert.equal(codeStepFor(secret, codeAt(secret, step - 2), { at: now }), null, 'nor two behind');

  // Which step matched is returned rather than a boolean, because the caller needs to know what to refuse
  // next time.
  assert.equal(codeStepFor(secret, codeAt(secret, step + 1), { at: now }), step + 1);

  assert.equal(verifyCode(secret, '00000', { at: now }), false, 'five digits is not a code');
  assert.equal(verifyCode(secret, '', { at: now }), false, 'nor is nothing');
  assert.equal(verifyCode(secret, 'abcdef', { at: now }), false, 'nor letters');
  assert.equal(verifyCode('not-a-secret', correct, { at: now }), false, 'and a bad secret is not a match');
});

test('the otpauth URI is what an authenticator app expects', () => {
  const uri = otpauthUri({ secret: 'ABCDEFGH', account: 'sam@practice.example', issuer: 'Lodge & Co' });
  assert.match(uri, /^otpauth:\/\/totp\//, 'the scheme apps recognise');
  assert.match(uri, /secret=ABCDEFGH/, 'the secret');
  assert.match(uri, /issuer=Lodge\+%26\+Co/, 'the issuer, escaped');
  assert.match(uri, /digits=6/, 'six digits');
  assert.match(uri, /period=30/, 'thirty seconds');
  assert.match(uri, /Lodge%20%26%20Co%3Asam%40practice\.example/, 'and the label names both the firm and the person');
});

test('recovery codes are unambiguous, and read the same however they are typed', () => {
  const codes = generateRecoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8, 'all different');
  for (const code of codes) {
    assert.equal(code.length, 10, 'ten characters, which is typeable');
    assert.ok(!/[01ILO]/.test(code), `no characters that look like others: ${code}`);
  }
  assert.equal(normaliseRecoveryCode(' abc-de fg '), 'ABCDEFG', 'spaces, hyphens and case are all forgiven');
});

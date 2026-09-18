/**
 * The TLS paths, which were the one honest gap in the mail feature.
 *
 * `docs/mail.md` said the handshake was not exercised, because generating a certificate needs a tool
 * that was not on this machine. It is on this machine — Git for Windows ships `openssl` — so the gap is
 * closed. The fixtures in `test/fixtures/tls/` are a throwaway CA and two certificates signed by it,
 * committed precisely so this can be tested without a network.
 *
 * Three things are worth testing here and only one of them is the happy path:
 *
 * 1. A message really goes over TLS, and the login goes over TLS rather than before the upgrade.
 * 2. A certificate the client does not trust is refused — and **nothing is sent afterwards**. This is
 *    the assertion that matters most: a mail client that failed the handshake and then carried on in
 *    the clear would hand a password to whoever answered the port.
 * 3. A certificate for the wrong name is refused. That is not automatic the way it looks: the mailer
 *    sends no SNI when the relay is addressed by IP (Node refuses an IP as `servername`), so this test
 *    exists to prove the check still happens. It does — Node verifies against the address it dialled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { MailError, mailerFromEnvironment, sendMail } from '../src/mailer.js';
import { startRelay } from './smtp-relay.js';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'tls');
const ca = readFileSync(join(FIXTURES, 'ca.pem'), 'utf8');
const forLocalhost = {
  cert: readFileSync(join(FIXTURES, 'cert.pem')),
  key: readFileSync(join(FIXTURES, 'key.pem')),
};
const forAnotherName = {
  cert: readFileSync(join(FIXTURES, 'wrong-name-cert.pem')),
  key: readFileSync(join(FIXTURES, 'wrong-name-key.pem')),
};

const message = {
  to: 'accounts@northwind.example',
  subject: 'Still needed for your 2025 return',
  body: 'Hello Northwind,\n\nTwo documents are still outstanding.\n\nSam',
};

const configFor = (relay, extra = {}) => ({
  host: '127.0.0.1',
  port: relay.port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Northwind Practice <office@practice.example>',
  timeoutMs: 5000,
  ...extra,
});

const bodyOf = (raw) =>
  Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

test('smtps:// sends the message over TLS, and the certificate is checked', async (t) => {
  const relay = await startRelay(t, {
    tls: forLocalhost,
    ehlo: ['250-fake', '250 AUTH PLAIN'],
  });

  const result = await sendMail(
    configFor(relay, { implicitTls: true, ca, user: 'relay-user', pass: 'relay-password' }),
    message,
  );

  assert.match(result.messageId, /@practice\.example>$/, 'the message was accepted');
  assert.equal(relay.seen.messages.length, 1, 'and it arrived');
  assert.equal(bodyOf(relay.seen.message), message.body, 'with the body that was typed');
  assert.equal(relay.seen.auth, 'PLAIN');
  assert.deepEqual(relay.seen.credentials, ['\0relay-user\0relay-password'], 'the login went over the handshake');
  assert.deepEqual(relay.seen.conversation, [
    'EHLO practice.example',
    'AUTH PLAIN AHJlbGF5LXVzZXIAcmVsYXktcGFzc3dvcmQ=',
    'MAIL FROM:<office@practice.example>',
    'RCPT TO:<accounts@northwind.example>',
    'DATA',
    'QUIT',
  ], 'and the conversation is what SMTP asks for, inside the TLS session');
});

test('STARTTLS: the message and the login both go over the upgraded connection', async (t) => {
  const relay = await startRelay(t, {
    ehlo: ['250-fake', '250-STARTTLS', '250 AUTH PLAIN'],
    starttls: forLocalhost,
  });

  await sendMail(configFor(relay, { ca, user: 'relay-user', pass: 'relay-password' }), message);

  assert.equal(relay.seen.upgraded, true, 'a real handshake completed on that socket');
  assert.equal(relay.seen.messages.length, 1, 'the message arrived');
  assert.equal(bodyOf(relay.seen.message), message.body);

  // The point of STARTTLS is that nothing private is said before the upgrade. The greeting and the
  // request for it are the only plaintext lines allowed.
  assert.deepEqual(relay.seen.afterUpgrade, [
    'EHLO practice.example',
    'AUTH PLAIN AHJlbGF5LXVzZXIAcmVsYXktcGFzc3dvcmQ=',
    'MAIL FROM:<office@practice.example>',
    'RCPT TO:<accounts@northwind.example>',
    'DATA',
    'QUIT',
  ], 'everything from the second EHLO onwards arrived over TLS, including the login');
  assert.ok(
    !relay.seen.conversation.slice(0, 2).some((line) => line.startsWith('AUTH')),
    'and the password was not among the lines sent before the upgrade',
  );
});

test('STARTTLS with a certificate the client does not trust fails, and nothing follows in the clear', async (t) => {
  const relay = await startRelay(t, {
    ehlo: ['250-fake', '250-STARTTLS', '250 AUTH PLAIN'],
    starttls: forLocalhost,
  });

  await assert.rejects(
    () => sendMail(configFor(relay, { user: 'relay-user', pass: 'relay-password' }), message),
    (error) => error instanceof MailError && error.step === 'starttls',
  );

  assert.equal(relay.seen.upgraded, false, 'no handshake completed');
  assert.equal(relay.seen.messages.length, 0, 'and no message was sent');
  // The whole reason this test exists: a client that gave up on TLS must not carry on in plaintext.
  assert.ok(
    !relay.seen.conversation.some((line) => line.startsWith('AUTH') || line.startsWith('MAIL FROM')),
    'and it did not go on to offer a password or a message over the unencrypted connection',
  );
});

test('a certificate for the wrong name is refused even though no SNI is sent to an IP address', async (t) => {
  const relay = await startRelay(t, { tls: forAnotherName, ehlo: ['250-fake'] });

  await assert.rejects(
    () => sendMail(configFor(relay, { implicitTls: true, ca }), message),
    (error) => error instanceof MailError
      && error.step === 'connection'
      && /ALTNAME|does not match/i.test(error.message),
    'the address dialled is checked against the certificate, with no SNI to lean on',
  );

  assert.equal(relay.seen.messages.length, 0);
});

test('a relay is trusted only when its CA is given, and a CA file that cannot be read is a startup error', () => {
  const withCa = mailerFromEnvironment({
    TICKMARK_SMTP_URL: 'smtps://relay.example:465',
    TICKMARK_MAIL_FROM: 'a@b.example',
    TICKMARK_SMTP_CA_FILE: join(FIXTURES, 'ca.pem'),
  });
  assert.match(withCa.ca, /BEGIN CERTIFICATE/, 'the CA is loaded from the file');
  assert.equal(withCa.rejectUnauthorized, true, 'and verification is still on: trusting a CA is not trusting anything');
  assert.equal(withCa.describe(), 'relay.example:465 (TLS), with your own CA', 'the operator can see their CA is in use');

  const without = mailerFromEnvironment({
    TICKMARK_SMTP_URL: 'smtps://relay.example:465',
    TICKMARK_MAIL_FROM: 'a@b.example',
  });
  assert.equal(without.ca, undefined, 'with no CA file, the default trust store is used');
  assert.equal(without.describe(), 'relay.example:465 (TLS)', 'and the description says nothing extra');

  assert.throws(
    () => mailerFromEnvironment({
      TICKMARK_SMTP_URL: 'smtps://relay.example:465',
      TICKMARK_MAIL_FROM: 'a@b.example',
      TICKMARK_SMTP_CA_FILE: join(FIXTURES, 'not-a-file.pem'),
    }),
    (error) => error instanceof MailError && error.step === 'configuration' && /could not be read/.test(error.message),
    'a missing CA file is reported at startup with the path in it, rather than as a failed send later',
  );
});

test('a certificate the client does not trust is refused, and no password is sent', async (t) => {
  const relay = await startRelay(t, {
    tls: forLocalhost,
    ehlo: ['250-fake', '250 AUTH PLAIN'],
  });

  // No `ca`, so the default trust store is used — which does not contain the test CA.
  await assert.rejects(
    () => sendMail(configFor(relay, { implicitTls: true, user: 'relay-user', pass: 'relay-password' }), message),
    (error) => error instanceof MailError
      && error.step === 'connection'
      && /UNABLE_TO_VERIFY|self-signed|unable to verify/i.test(error.message),
    'the refusal names the step and carries the reason, which is the part an operator can act on',
  );

  assert.deepEqual(relay.seen.conversation, [], 'nothing was said to it, because the handshake never completed');
  assert.equal(relay.seen.auth, null, 'and nothing that could carry a password was ever attempted');
});
/**
 * The mail client, tested against a server that is written here.
 *
 * A fake SMTP server is a few dozen lines of `node:net`, and it buys something a mocked function
 * cannot: the *conversation* is asserted, in order, with the exact lines. "The reminder was sent" is a
 * claim about a dialogue, and the only way to check it is to have the dialogue and read it back.
 *
 * What is **not** covered here, and is said so rather than left to be discovered: the TLS paths.
 * Testing them needs a certificate, generating one needs a tool this machine does not have, and a
 * certificate from the internet is not going in a repository. The STARTTLS negotiation is tested as
 * far as it can be — the client asks, and a broken handshake is a clean failure — and the first real
 * relay will exercise the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import {
  MailError,
  buildMessage,
  dotStuff,
  encodeHeader,
  mailerFromEnvironment,
  parseSmtpUrl,
  sendMail,
} from '../src/mailer.js';

// One relay, shared with the TLS tests. Two copies of a protocol double are two chances for the double
// to be wrong in different ways — and then a red test is the harness's fault.
import { startRelay as fakeServer } from './smtp-relay.js';

/** A configuration pointing at a fake server, with no credentials unless asked for. */
const configFor = (fake, extra = {}) => ({
  host: '127.0.0.1',
  port: fake.port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Tickmark Practice <office@practice.example>',
  timeoutMs: 3000,
  ...extra,
});

/** The body of a received message, decoded back from base64. */
function bodyOf(message) {
  const [, encoded] = message.split('\r\n\r\n');
  return Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

test('a message is sent, and the whole conversation is what SMTP asks for', async (t) => {
  const fake = await fakeServer(t);
  const body = 'Hello Northwind Ltd,\n\nWe are still waiting on one document.\n\nThanks,';

  const result = await sendMail(configFor(fake), {
    to: 'accounts@northwind.example',
    subject: 'Still needed for 2025 return',
    body,
  });

  assert.equal(
    JSON.stringify(fake.seen.conversation),
    JSON.stringify([
      'EHLO practice.example',
      'MAIL FROM:<office@practice.example>',
      'RCPT TO:<accounts@northwind.example>',
      'DATA',
      'QUIT',
    ]),
    `in that order, with those addresses in angle brackets (${fake.seen.conversation.length} lines were sent)`,
  );

  assert.match(result.messageId, /^<[0-9a-f-]{36}@practice\.example>$/, 'the Message-ID carries the sender domain');
  assert.equal(result.recipient, 'accounts@northwind.example');

  const message = fake.seen.message;
  assert.match(message, /^From: Tickmark Practice <office@practice\.example>\r\n/);
  assert.match(message, /\r\nTo: accounts@northwind\.example\r\n/);
  assert.match(message, /\r\nSubject: Still needed for 2025 return\r\n/);
  assert.match(message, /\r\nMessage-ID: <[0-9a-f-]{36}@practice\.example>\r\n/);
  assert.match(message, /\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.match(message, /\r\nAuto-Submitted: auto-generated\r\n/, 'so a well-behaved autoresponder does not answer it');
  assert.equal(bodyOf(message), body, 'and the body comes back out exactly');

  // Every line feed has to be preceded by a carriage return: SMTP wants CRLF, and a bare LF is a way
  // to be silently mangled by a relay. (A blank line is \r\n\r\n, so the check is a lookbehind and not
  // a search for "\n something".)
  assert.ok(!/(?<!\r)\n/.test(message), 'no bare line feeds: SMTP wants CRLF everywhere');
});

test('a non-ASCII subject is encoded, and a body in any language survives', async (t) => {
  const fake = await fakeServer(t);
  const body = 'Bonjour,\n\nIl nous manque encore un document — le relevé de café.\n\nMerci,';

  await sendMail(configFor(fake), { to: 'a@b.example', subject: 'Relevé de compte — 2025', body });

  const message = fake.seen.message;
  const subject = /Subject: (.*)\r\n/.exec(message)[1];
  assert.match(subject, /^=\?UTF-8\?B\?/, 'the subject is an RFC 2047 encoded word');
  assert.equal(
    Buffer.from(subject.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'),
    'Relevé de compte — 2025',
    'and it decodes back to what was typed',
  );
  assert.equal(bodyOf(message), body, 'the body keeps its accents and its dashes');
});

test('credentials are sent when the server offers AUTH PLAIN', async (t) => {
  const fake = await fakeServer(t, { ehlo: ['250-fake', '250 AUTH PLAIN LOGIN'] });

  await sendMail(configFor(fake, { user: 'relay-user', pass: 'relay-password', rejectUnauthorized: false }), {
    to: 'a@b.example',
    subject: 'Chase',
    body: 'hello',
  });

  assert.equal(fake.seen.auth, 'PLAIN');
  assert.deepEqual(fake.seen.credentials, ['\0relay-user\0relay-password'], 'the SASL PLAIN token, built the way the RFC says');
});

test('credentials fall back to AUTH LOGIN when that is all the server offers', async (t) => {
  const fake = await fakeServer(t, { ehlo: ['250-fake', '250 AUTH LOGIN'] });

  await sendMail(configFor(fake, { user: 'relay-user', pass: 'relay-password', rejectUnauthorized: false }), {
    to: 'a@b.example',
    subject: 'Chase',
    body: 'hello',
  });

  assert.equal(fake.seen.auth, 'LOGIN');
  assert.deepEqual(fake.seen.credentials, ['relay-user', 'relay-password'], 'username then password, each base64');
});

test('a password is not sent to a server that offers no encryption', async (t) => {
  const fake = await fakeServer(t, { ehlo: ['250 fake'] });

  await assert.rejects(
    () => sendMail(configFor(fake, { user: 'relay-user', pass: 'relay-password' }), {
      to: 'a@b.example',
      subject: 'Chase',
      body: 'hello',
    }),
    (error) => error instanceof MailError && error.step === 'starttls' && /does not offer STARTTLS/.test(error.message),
  );

  assert.equal(fake.seen.auth, null, 'and nothing was offered to it');
  assert.ok(!fake.seen.conversation.some((line) => line.startsWith('AUTH')), 'no AUTH line was even sent');
});

test('the client asks for STARTTLS, and a broken handshake fails cleanly rather than hanging', async (t) => {
  const fake = await fakeServer(t, { ehlo: ['250-fake', '250-STARTTLS', '250 AUTH PLAIN'] });

  await assert.rejects(
    () => sendMail(configFor(fake, { user: 'u', pass: 'p' }), { to: 'a@b.example', subject: 'x', body: 'y' }),
    (error) => error instanceof MailError && error.step === 'starttls',
    'the failure names the step, so the operator knows what to fix',
  );

  assert.ok(fake.seen.conversation.includes('STARTTLS'), 'and it did ask, rather than giving up quietly');
});

test('a refusal names the step and quotes the server', async (t) => {
  const refusedRecipient = await fakeServer(t, { recipientReply: '550 5.1.1 no such user here' });
  await assert.rejects(
    () => sendMail(configFor(refusedRecipient), { to: 'nobody@northwind.example', subject: 'x', body: 'y' }),
    (error) => error.step === 'the recipient (nobody@northwind.example)' && /550 5\.1\.1/.test(error.message),
    'the sentence names who was refused and repeats what the server said',
  );

  const refusedAuth = await fakeServer(t, {
    ehlo: ['250-fake', '250 AUTH PLAIN'],
    authReply: '535 5.7.8 bad credentials',
  });
  await assert.rejects(
    () => sendMail(configFor(refusedAuth, { user: 'u', pass: 'wrong', rejectUnauthorized: false }), {
      to: 'a@b.example',
      subject: 'x',
      body: 'y',
    }),
    (error) => error.step === 'authentication' && /535/.test(error.message),
  );
});

test('a server that says nothing produces a timeout rather than a wait', async (t) => {
  const silent = createServer((socket) => {
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => silent.close(resolve)));

  const started = Date.now();
  await assert.rejects(
    () => sendMail(configFor({ port: silent.address().port }, { timeoutMs: 400 }), {
      to: 'a@b.example',
      subject: 'x',
      body: 'y',
    }),
    (error) => error.step === 'timeout',
  );
  assert.ok(Date.now() - started < 5000, 'and it gives up rather than waiting for the operator to notice');
});

test('an address that is not one is refused before anything is dialled', async (t) => {
  const fake = await fakeServer(t);

  await assert.rejects(
    () => sendMail(configFor(fake), { to: 'not an address', subject: 'x', body: 'y' }),
    (error) => error.step === 'configuration',
  );
  assert.deepEqual(fake.seen.conversation, [], 'nothing was sent to the server at all');
});

test('a line beginning with a dot is escaped, which is the one rule a body cannot be trusted with', () => {
  assert.equal(dotStuff('hello'), 'hello');
  assert.equal(dotStuff('.hidden'), '..hidden');
  assert.equal(dotStuff('first\r\n.second'), 'first\r\n..second');
  assert.equal(dotStuff('a\r\n..already'), 'a\r\n...already', 'and escaping is uniform, not clever');
});

test('the configuration is read from the environment, and a half-set pair is refused', () => {
  assert.equal(mailerFromEnvironment({}), null, 'no configuration is not an error: drafting still works');

  const plain = mailerFromEnvironment({
    TICKMARK_SMTP_URL: 'smtp://user%40example.com:p%40ss@relay.example:587',
    TICKMARK_MAIL_FROM: 'Office <office@practice.example>',
  });
  assert.equal(plain.host, 'relay.example');
  assert.equal(plain.port, 587);
  assert.equal(plain.implicitTls, false);
  assert.equal(plain.user, 'user@example.com', 'percent-encoded credentials are decoded');
  assert.equal(plain.pass, 'p@ss');
  assert.equal(plain.rejectUnauthorized, true, 'and a certificate is required unless told otherwise');
  assert.equal(plain.describe(), 'relay.example:587 (STARTTLS when offered)');
  assert.ok(!plain.describe().includes('p@ss'), 'the description never contains the password');

  const secure = mailerFromEnvironment({ TICKMARK_SMTP_URL: 'smtps://relay.example', TICKMARK_MAIL_FROM: 'a@b.example' });
  assert.equal(secure.port, 465, 'smtps:// defaults to the implicit-TLS port');
  assert.equal(secure.implicitTls, true);

  const insecure = mailerFromEnvironment({
    TICKMARK_SMTP_URL: 'smtp://relay.example',
    TICKMARK_MAIL_FROM: 'a@b.example',
    TICKMARK_SMTP_INSECURE: '1',
  });
  assert.equal(insecure.rejectUnauthorized, false, 'and accepting any certificate has to be asked for explicitly');

  assert.throws(() => parseSmtpUrl('not a url'), /not a URL/);
  assert.throws(() => parseSmtpUrl('http://relay.example'), /must be smtp:\/\/ or smtps:\/\//);
  assert.throws(() => parseSmtpUrl('smtp://relay.example:0'), /impossible port/, 'a port of zero is caught here');
  assert.throws(
    () => parseSmtpUrl('smtp://relay.example:99999'),
    /not a URL/,
    'a port above the maximum never reaches this code: the URL parser refuses it first, which is fine',
  );
  assert.throws(() => mailerFromEnvironment({ TICKMARK_SMTP_URL: 'smtp://relay.example' }), /TICKMARK_SMTP_URL is set but/);
  assert.throws(() => mailerFromEnvironment({ TICKMARK_MAIL_FROM: 'a@b.example' }), /TICKMARK_MAIL_FROM is set but/);
});

test('the message builder refuses nothing and invents nothing', () => {
  const message = buildMessage({
    from: 'Office <office@practice.example>',
    to: 'client@example.com',
    subject: 'Plain',
    body: 'line one\nline two',
    messageId: '<fixed@practice.example>',
  });
  assert.match(message, /^From: Office <office@practice\.example>\r\n/);
  assert.ok(message.endsWith('\r\n'), 'the message ends with a line break, so the terminator can follow it');
  assert.match(message, /\r\n\r\n/, 'headers, then a blank line, then the body');
  assert.equal(encodeHeader('Plain'), 'Plain', 'an ASCII header is left alone');
  assert.equal(
    encodeHeader('Ünicode'),
    `=?UTF-8?B?${Buffer.from('Ünicode', 'utf8').toString('base64')}?=`,
    'and a non-ASCII one is encoded rather than sent raw',
  );
  assert.equal(encodeHeader('a\r\nb'), 'a b', 'a header cannot be broken across lines by whatever was typed');
});

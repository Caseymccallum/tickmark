/**
 * The message a client actually sees: the practice's words as plain text, and the same words as a
 * letter.
 *
 * The rules these defend: the plain part is byte-for-byte what the practice typed — the styled copy
 * adds no words and takes none away, so "what you see is what gets sent" survives the styling — the
 * HTML renders rather than trusts (a `<script>` typed into a message is text in it), the link a
 * client needs is a button whose label is the URL, and the notes a practice sends to *itself* stay
 * plain: a status note does not need a letterhead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMessage, mailHtml } from '../src/mailer.js';
import { generatePracticeKey } from '../web/tickmark-crypto.js';
import { createLink, PASSPHRASE, plainBody, practiceWithRequest, withServer } from './helpers.js';
import { startRelay } from './smtp-relay.js';

/** The mailer shape `sendMail` speaks to, pointed at the fake relay. */
const mailerAt = (port) => ({
  host: '127.0.0.1',
  port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Lodis Accountancy <office@practice.example>',
  timeoutMs: 3000,
  describe: () => `127.0.0.1:${port}`,
});

/** One part of a multipart message, decoded. */
const partOf = (message, type) => {
  const pattern = new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`);
  return Buffer.from((pattern.exec(message)?.[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
};

/** Wait for a background send to land — handlers answer the browser before they talk to the relay. */
async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test('a styled message is plain text and a rendering of it, in that order', () => {
  const words =
    'Hello Northwind,\n\nOne document is still outstanding:\n\n  - Bank statements\n\nSend it here:\n' +
    'https://tickmark.example/r/abcdefghijklmnopqrstuvwx\n\nThanks,\n\nLodis Accountancy';
  const message = buildMessage({
    from: 'Lodis Accountancy <office@practice.example>',
    to: 'accounts@northwind.example',
    subject: 'Still needed',
    body: words,
    html: mailHtml(words, 'Lodis Accountancy'),
    messageId: '<x@practice.example>',
  });

  assert.match(message, /Content-Type: multipart\/alternative; boundary="/, 'one message, two dressings');
  assert.ok(message.indexOf('text/plain') < message.indexOf('text/html'), 'plain comes first: the order is the instruction');
  assert.equal(plainBody(message), words, 'the plain part is exactly the words, byte for byte');

  const letter = partOf(message, 'text/html');
  assert.match(letter, /Lodis Accountancy/, 'the letterhead names the practice');
  assert.match(letter, /<li [^>]*>Bank statements<\/li>/, 'the checklist is a list');
  assert.match(letter, /<a href="https:\/\/tickmark\.example\/r\/abcdefghijklmnopqrstuvwx"/, 'the link is a link');
});

test('the rendering never trusts the text', () => {
  const words = '<script>alert(1)</script>\n\nhttps://example.test/a?b=1&c=2';
  const letter = mailHtml(words, '<b>Practice</b>');
  assert.ok(!letter.includes('<script'), 'a typed tag is text, not markup');
  assert.ok(letter.includes('&lt;script&gt;'), 'and the words survive, escaped');
  assert.ok(!letter.includes('<b>Practice</b>'), 'the practice name is escaped too');
  assert.match(letter, /href="https:\/\/example\.test\/a\?b=1&amp;c=2"/, 'and an ampersand in a URL lands where HTML wants it');
  assert.ok(!/src=|<link|@import/.test(letter), 'nothing external: most clients block it and none is needed');
});

test('a URL on a line of its own is a button whose label is the URL', () => {
  const letter = mailHtml('Send it here:\n\nhttps://tickmark.example/r/abcdefghijklmnopqrstuvwx', 'Lodis Accountancy');
  assert.match(letter, /display:inline-block/, 'button-styled');
  assert.ok(letter.includes('>https://tickmark.example/r/abcdefghijklmnopqrstuvwx</a>'), 'and it says exactly where it goes');
});

test('a reminder through the product carries both parts, and the words are the ones on screen', async (t) => {
  const relay = await startRelay(t);
  await withServer(
    async ({ agent, db }) => {
      const { client, requestId } = await practiceWithRequest({ agent, db }, 'sam@practice.example');
      await client.post(`/requests/${requestId}/remind`, { days: '30' });

      // What the practice typed in the box — edited, so the assertion is about the *form* being the
      // source of truth rather than the draft that prefilled it.
      const typed = 'Hello Northwind,\n\nEDITED-WORDS are what goes out.\n\n  - Bank statements\n\nThanks,\n\nLodis';
      await client.post(`/requests/${requestId}/send-reminder`, { subject: 'Still needed', message: typed });

      const message = relay.seen.message;
      assert.match(message, /Content-Type: multipart\/alternative/, 'the reminder leaves as plain text and a letter');
      assert.equal(plainBody(message), typed, 'the plain part is what was in the box — byte for byte');

      const letter = partOf(message, 'text/html');
      assert.ok(letter.includes('EDITED-WORDS'), 'the letter carries the edited words');
      assert.match(letter, /Bank statements<\/li>/, 'the checklist renders as a list');
      assert.match(letter, /My practice/, 'and the practice name is the letterhead');
    },
    { mailer: mailerAt(relay.port) },
  );
});

test('the notes a practice sends itself stay plain', async (t) => {
  const relay = await startRelay(t);
  await withServer(
    async ({ agent, db }) => {
      const { client } = await practiceWithRequest({ agent, db }, 'sam@practice.example');
      // A rotation — the second key is one of the three changes the owners are told about unprompted.
      const second = await generatePracticeKey(PASSPHRASE);
      await client.post('/setup', {
        public_key: JSON.stringify(second.publicKey),
        wrapped_private_key: second.wrappedPrivateKey,
      });

      assert.ok(await waitFor(() => relay.seen.messages.length >= 1), 'the owners are told');
      const plain = relay.seen.messages.every((message) => !/Content-Type: multipart/.test(message));
      assert.equal(plain, true, 'a status note has no letterhead');
    },
    { mailer: mailerAt(relay.port) },
  );
});
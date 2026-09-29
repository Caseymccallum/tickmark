/**
 * The text sender: the request it makes, and the two things that stop it short.
 *
 * The interesting assertions are about what goes over the wire — the fields, the auth, the shape of the
 * failure when the gateway says no — so the double here is a real HTTP server on this machine, the same
 * idea as `smtp-relay.js`: a fake that speaks enough of the protocol to be lied to. A stub that just
 * returned "ok" would prove nothing about the request the product actually builds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { SmsError, normalisePhone, parseSmsUrl, sendSms, smsFromEnvironment, smsReminder } from '../src/sms.js';

/** A gateway that records what it was sent and replies with the given status and body. */
function fakeGateway(status = 200, body = '{"sid":"SM123"}') {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization ?? null,
        contentType: request.headers['content-type'],
        form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))),
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        seen,
        url: (credentials = '') => `http://${credentials ? `${credentials}@` : ''}127.0.0.1:${server.address().port}/Messages.json`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// --- configuration --------------------------------------------------------------------------------

test('the URL is split into an endpoint and its credentials, and never both in the request line', () => {
  const parsed = parseSmsUrl('https://user:p%40ss@gateway.example/2010/Messages.json?x=1');
  assert.equal(parsed.endpoint, 'https://gateway.example/2010/Messages.json?x=1', 'no credentials in the path');
  assert.equal(parsed.user, 'user');
  assert.equal(parsed.pass, 'p@ss', 'percent-decoded, as the mailer does it');
  assert.equal(parseSmsUrl('http://gateway.example/x').user, null, 'a gateway with no sign-in');
  assert.throws(() => parseSmsUrl('not a url'), SmsError);
  assert.throws(() => parseSmsUrl('ftp://gateway.example/x'), /http/);
});

test('a half-set configuration refuses at startup and says which half is missing', () => {
  assert.equal(smsFromEnvironment({}), null, 'nothing set, nothing to do — the reminder still goes by email');
  assert.throws(() => smsFromEnvironment({ TICKMARK_SMS_FROM: '+441234567890' }), /TICKMARK_SMS_URL is not/);
  assert.throws(() => smsFromEnvironment({ TICKMARK_SMS_URL: 'http://g/x' }), /TICKMARK_SMS_FROM is not/);

  const sms = smsFromEnvironment({ TICKMARK_SMS_URL: 'http://user:pass@127.0.0.1:1/x', TICKMARK_SMS_FROM: '+441234567890' });
  assert.equal(sms.from, '+441234567890');
  assert.equal(sms.user, 'user');
  assert.match(sms.describe(), /127\.0\.0\.1/);
  assert.ok(!/pass/.test(sms.describe()), 'and the password never appears where a page can show it');
});

test('a phone number is reduced to the digits a gateway will dial', () => {
  assert.equal(normalisePhone('+44 (020) 7946-0000'), '+4402079460000');
});

// --- the send -------------------------------------------------------------------------------------

test('a text goes out as one form-encoded POST, signed in', async () => {
  const gateway = await fakeGateway();
  try {
    const sms = smsFromEnvironment({ TICKMARK_SMS_URL: gateway.url('acct:tok'), TICKMARK_SMS_FROM: '+441234567890' });
    const sent = await sendSms(sms, { to: '+44 7700 900123', body: 'Northwind: still needed: Photo ID. https://x/r/abc' });

    assert.equal(sent.to, '+447700900123', 'normalised on the way out');
    assert.equal(sent.id, 'SM123', "the gateway's own id is kept");
    assert.equal(gateway.seen.length, 1);
    assert.equal(gateway.seen[0].method, 'POST');
    assert.equal(gateway.seen[0].path, '/Messages.json');
    assert.equal(gateway.seen[0].contentType, 'application/x-www-form-urlencoded');
    assert.deepEqual(gateway.seen[0].form, {
      To: '+447700900123',
      From: '+441234567890',
      Body: 'Northwind: still needed: Photo ID. https://x/r/abc',
    });
    assert.equal(gateway.seen[0].authorization, `Basic ${Buffer.from('acct:tok').toString('base64')}`, 'signed in, and the secret only in the header');
  } finally {
    await gateway.close();
  }
});

test('a refused send quotes the gateway back, and a bad number never reaches it', async () => {
  const gateway = await fakeGateway(401, 'Authenticate');
  try {
    const sms = smsFromEnvironment({ TICKMARK_SMS_URL: gateway.url(), TICKMARK_SMS_FROM: '+441234567890' });
    await assert.rejects(() => sendSms(sms, { to: '+447700900123', body: 'hello' }), (error) => {
      assert.ok(error instanceof SmsError);
      assert.match(error.message, /401 — Authenticate/, "the gateway's own reply, quoted back");
      return true;
    });
    assert.equal(gateway.seen.length, 1, 'it did reach the gateway');

    await assert.rejects(() => sendSms(sms, { to: 'not a number', body: 'hello' }), /not a phone number/);
    assert.equal(gateway.seen.length, 1, 'and a bad number is stopped before it spends a message');
    await assert.rejects(() => sendSms(sms, { to: '+447700900123', body: '   ' }), /says nothing/);
  } finally {
    await gateway.close();
  }
});

test('a deployment that takes the message itself stops the send', async () => {
  const gateway = await fakeGateway();
  try {
    const held = [];
    const sms = {
      endpoint: gateway.url(),
      from: '+441234567890',
      onOutgoing: (message) => {
        held.push(message);
        return false;
      },
    };
    const result = await sendSms(sms, { to: '+447700900123', body: 'held back' });
    assert.equal(result.suppressed, true);
    assert.equal(gateway.seen.length, 0, 'nothing reached the gateway');
    assert.equal(held[0].body, 'held back');
  } finally {
    await gateway.close();
  }
});

// --- the words ------------------------------------------------------------------------------------

test('the reminder is one line and a link, naming two documents and counting the rest', () => {
  const text = smsReminder({
    practiceName: 'Lodis Accountancy',
    title: '2025 return',
    missing: ['Photo ID', 'Bank statements', 'Signed engagement letter'],
    link: 'https://tickmark.example/r/abc',
  });
  assert.equal(
    text,
    'Lodis Accountancy: still needed: Photo ID, Bank statements and 1 more for 2025 return. https://tickmark.example/r/abc',
    'two named, the rest counted — never three messages chasing each other',
  );

  const one = smsReminder({ practiceName: 'Lodis', title: '2025 return', missing: ['Photo ID'], link: 'https://x/r/a' });
  assert.match(one, /still needed: Photo ID for 2025 return/);

  const nothing = smsReminder({ practiceName: 'Lodis', title: '2025 return', missing: [], link: 'https://x/r/a' });
  assert.match(nothing, /a reminder about 2025 return/, 'with nothing missing it is a nudge, not a list');
});
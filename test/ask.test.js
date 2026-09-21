/**
 * Asking for the documents, by email.
 *
 * The practice could already make a link and already send mail; the only way to *ask* was to copy a link out
 * of one page and paste it into another program. These tests drive the whole thing — the draft, the edit,
 * the send — against a fake relay, the way a practice does.
 *
 * Two things are load-bearing and both are asserted here rather than assumed: the link in the message is a
 * link that actually opens (it is issued for this send, because a link cannot be recovered by design), and
 * the record says the request was *sent*, which is a different sentence from a reminder being sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { practiceWithRequest, withServer } from './helpers.js';

/** A relay that accepts everything, and remembers it. */
async function relay(t) {
  const seen = { messages: [] };
  const server = createServer((socket) => {
    socket.write('220 relay here\r\n');
    let buffer = '';
    let inData = false;
    let lines = [];
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            seen.messages.push(lines.join('\r\n'));
            lines = [];
            socket.write('250 queued\r\n');
            continue;
          }
          lines.push(line);
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250 relay\r\n');
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('QUIT')) socket.write('250 ok\r\n');
        else if (upper.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: server.address().port };
}

const mailerAt = (port) => ({
  host: '127.0.0.1',
  port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Northwind Practice <office@practice.example>',
  timeoutMs: 3000,
  describe: () => `127.0.0.1:${port}`,
});

const bodyOf = (message) => Buffer.from(message.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

test('the request page offers to email it, and the draft carries the list and a link that opens', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    const page = await (await client.get(`/requests/${requestId}`)).text();
    assert.match(page, new RegExp(`/requests/${requestId}/send"`), 'the request offers to email itself');

    const drafted = await client.post(`/requests/${requestId}/send`, { days: '30' });
    const draft = await drafted.text();
    assert.equal(drafted.status, 200);
    assert.match(draft, /Ask Northwind Ltd for these/, 'it is an ask, not a chase');
    assert.ok(!/A reminder for/.test(draft), 'and it does not pretend to be a reminder');
    assert.match(draft, /Documents we need for 2025 return/, 'the subject says what it is');
    assert.match(draft, /Bank statements/, 'the list is in the message');
    assert.match(draft, /Signed engagement letter/);
    assert.match(draft, /no account or password needed/, 'and the client is told they need no account');

    // The link is real: the message is only worth sending if the address in it opens.
    const link = /https?:\/\/[^\s]+\/r\/[A-Za-z0-9_-]{20,}/.exec(draft)?.[0];
    assert.ok(link, 'the message carries an absolute link');
    const opened = await agent().get(link.replace(base, ''));
    assert.equal(opened.status, 200, 'and that link opens the client page');
  }, { mailer: mailerAt(fake.port) });
});

test('what is sent is what is in the fields, and the record says the request was sent', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/send`, { days: '30' });

    const sent = await client.post(`/requests/${requestId}/send-request`, {
      subject: 'Your 2025 paperwork',
      message: 'Hello Northwind,\n\nHere is everything we need.\n\nThanks,',
    });
    assert.equal(sent.status, 303, 'it lands back on the request');

    const location = String(sent.headers.get('location'));
    assert.match(location, /^\/requests\/[0-9a-f-]{36}\?emailed=/, 'with the message id in the address');

    assert.equal(fake.seen.messages.length, 1, 'one message reached the relay');
    const body = bodyOf(fake.seen.messages[0]);
    assert.match(body, /Here is everything we need/, 'the words they typed are what was sent');
    assert.ok(!/We need the following/.test(body), 'and the draft they replaced is not sent by accident');

    const [event] = db.prepare("SELECT kind, detail FROM event WHERE kind = 'request.sent'").all();
    assert.ok(event, 'the send is recorded');
    assert.match(event.detail, /accounts@northwind\.example/, 'saying where it went');

    const after = await (await client.get(`/requests/${requestId}?emailed=mid-1`)).text();
    assert.match(after, /Request sent\./, 'and the page confirms it rather than leaving them guessing');
    assert.ok(!/Reminder sent/.test(after), 'without calling the first ask a reminder');
  }, { mailer: mailerAt(fake.port) });
});

test('with no mail server, the page says what is missing and offers no button that would fail', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    const drafted = await client.post(`/requests/${requestId}/send`, { days: '30' });
    const page = await drafted.text();
    assert.equal(drafted.status, 200, 'the draft is still shown, so it can be copied out');
    assert.match(page, /Tickmark cannot send this by itself/);
    assert.match(page, /<button type="submit" disabled>Send it<\/button>/, 'and the button is disabled');

    const pressed = await client.post(`/requests/${requestId}/send-request`, { subject: 'x', message: 'y' });
    assert.equal(pressed.status, 400, 'pressing it anyway is refused');
    assert.match(await pressed.text(), /no mail server configured/);

    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'request.sent'").get().n,
      0,
      'and nothing claims to have been sent',
    );
  });
});

test('a client with no address is somebody the request cannot be emailed to, and it says so', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    db.prepare('UPDATE client SET email = NULL WHERE name = ?').run('Northwind Ltd');

    const drafted = await client.post(`/requests/${requestId}/send`, { days: '30' });
    assert.match(await drafted.text(), /no email address for Northwind Ltd/, 'the page names the problem');

    const pressed = await client.post(`/requests/${requestId}/send-request`, { subject: 'x', message: 'y' });
    assert.equal(pressed.status, 400);
    assert.equal(fake.seen.messages.length, 0, 'and nothing was sent or attempted');
  }, { mailer: mailerAt(fake.port) });
});

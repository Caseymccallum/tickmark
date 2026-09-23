/**
 * Sending a reminder, through the real server.
 *
 * These drive the app the way a practice does — the form, the send, the page they land on — against a
 * fake SMTP server. `test/mail.test.js` checks the conversation; this file checks that the conversation
 * happens when a person presses Send, with the words they typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { withServer, practiceWithRequest, plainBody } from './helpers.js';

/** A relay that accepts everything, and remembers it. */
async function relay(t, { recipientReply = '250 ok' } = {}) {
  const seen = { messages: [], envelope: [] };
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
        else if (upper.startsWith('RCPT TO')) socket.write(`${recipientReply}\r\n`);
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

/** The body of a message the relay received, decoded. */
const bodyOf = (message) => plainBody(message);
const headerOf = (message, name) => new RegExp(`\\r\\n${name}: (.*)\\r\\n`).exec(message)?.[1];

test('the reminder page offers to send when a mail server is configured, and names it', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const drafted = await client.post(`/requests/${requestId}/remind`, { days: '30' });
    const page = await drafted.text();

    assert.equal(drafted.status, 200);
    assert.match(page, /Sending from <strong>127\.0\.0\.1:\d+<\/strong> to\s*<strong>accounts@northwind\.example/, 'it says where from and where to');
    assert.match(page, /<button type="submit">Send it to accounts@northwind\.example<\/button>/, 'and the button says where it goes');
    assert.ok(!/does not send this/.test(page), 'the old "Tickmark does not send this" line is gone when it can send');

    // The fields are editable, which is what makes an edit a decision.
    assert.match(page, /<textarea id="subject" name="subject" rows="2">/, 'the subject is a field');
    assert.match(page, /<textarea id="message" name="message" rows="18"/, 'and so is the message');
  }, { mailer: mailerAt(fake.port) });
});

test('what is sent is what is in the fields, edits and all', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/remind`, { days: '30' });

    const sent = await client.post(`/requests/${requestId}/send-reminder`, {
      subject: 'A gentle nudge about your 2025 return',
      message: 'Hello Northwind,\n\nJust the engagement letter outstanding now — I have the rest.\n\nSam',
    });

    assert.equal(sent.status, 303);
    const location = sent.headers.get('location');
    assert.equal(new URL(location, 'http://localhost').pathname, `/requests/${requestId}`, 'it lands back on the request');
    assert.match(new URL(location, 'http://localhost').searchParams.get('sent'), /^<[0-9a-f-]{36}@practice\.example>$/, 'carrying the Message-ID, so it can be quoted if the client says it never arrived');

    assert.equal(fake.seen.messages.length, 1, 'exactly one message was sent');
    const message = fake.seen.messages[0];
    assert.equal(headerOf(message, 'Subject'), 'A gentle nudge about your 2025 return', 'the subject is the typed one');
    assert.equal(
      bodyOf(message),
      'Hello Northwind,\n\nJust the engagement letter outstanding now — I have the rest.\n\nSam',
      'and the body is the typed one, not the draft that was on the page',
    );
    assert.match(message, /\r\nTo: accounts@northwind\.example\r\n/);

    // And the practice is told, on the page they land on, with something to quote.
    const landed = await client.get(location);
    const landedPage = await landed.text();
    assert.match(landedPage, /Reminder sent\./, 'the page confirms it');
    assert.match(landedPage, /<code>&lt;[0-9a-f-]{36}@practice\.example&gt;<\/code>/, 'and quotes the identifier');

    const recorded = db
      .prepare("SELECT kind, detail FROM event WHERE request_id = ? AND kind LIKE 'reminder.%' ORDER BY at")
      .all(requestId);
    assert.equal(recorded.length, 2, 'the draft and the send are both in the history');
    assert.equal(recorded[1].kind, 'reminder.sent');
    assert.match(recorded[1].detail, /^to accounts@northwind\.example \(<[0-9a-f-]{36}@practice\.example>\)/, 'the record holds who it went to and the identifier');
    assert.match(recorded[1].detail, /with no link in it$/, 'and it says the message carried no link, because this one did not — the wording was this practice\'s choice');
  }, { mailer: mailerAt(fake.port) });
});
test('a refused recipient keeps what was typed and says what the server said', async (t) => {
  const fake = await relay(t, { recipientReply: '550 5.1.1 no such user' });
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/remind`, { days: '30' });

    const sent = await client.post(`/requests/${requestId}/send-reminder`, {
      subject: 'Nudge',
      message: 'Hello — still waiting on the engagement letter.\n\nSam',
    });

    assert.equal(sent.status, 400, 'a failed send is not a success page');
    const page = await sent.text();
    assert.match(page, /<strong>Not sent\.<\/strong>/, 'it says so plainly');
    assert.match(page, /550 5\.1\.1 no such user/, 'and repeats what the relay said, which is the actionable part');
    assert.match(page, /Nothing you typed is lost/, 'and it says what it does next');

    // The promise is kept: the typed words are back in the fields.
    assert.match(page, /<textarea id="subject" name="subject" rows="2">Nudge<\/textarea>/, 'the subject is still there');
    assert.match(page, /still waiting on the engagement letter/, 'and so is the message');
    assert.match(page, /<button type="submit">Send it to accounts@northwind\.example<\/button>/, 'so it can be tried again');

    const recorded = db
      .prepare("SELECT kind, detail FROM event WHERE request_id = ? AND kind LIKE 'reminder.%' ORDER BY at")
      .all(requestId);
    assert.equal(recorded.at(-1).kind, 'reminder.failed', 'the failure is recorded, so "did it go?" is answerable later');
    assert.match(recorded.at(-1).detail, /550 5\.1\.1/);
  }, { mailer: mailerAt(fake.port) });
});

test('a relay that cannot be reached fails as a sentence, not as a stack trace', async (t) => {
  // A port nothing is listening on: the connection is refused at once.
  const closed = createServer(() => {});
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/remind`, { days: '30' });

    const sent = await client.post(`/requests/${requestId}/send-reminder`, { subject: 'Nudge', message: 'Hello' });
    assert.equal(sent.status, 400);
    const page = await sent.text();
    assert.match(page, /<strong>Not sent\.<\/strong>/);
    assert.match(page, /connection:/, 'the step that failed is named');
  }, { mailer: mailerAt(deadPort) });
});

test('with no mail server, the page says so, offers no send button, and sending is refused', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const drafted = await client.post(`/requests/${requestId}/remind`, { days: '30' });
    const page = await drafted.text();

    assert.match(page, /no mail\s+server configured/, 'the page explains why it cannot send');
    assert.match(page, /TICKMARK_SMTP_URL/, 'and names the setting to look at');
    assert.match(page, /<button type="submit" disabled>Send it<\/button>/, 'the button is visibly disabled rather than failing when pressed');
    assert.match(page, /Tickmark does not send this\./, 'and the copy instruction is still there, because copying still works');

    // And the route refuses anyway: a disabled button is a courtesy, not a control.
    const attempted = await client.post(`/requests/${requestId}/send-reminder`, { subject: 'Nudge', message: 'Hello' });
    assert.equal(attempted.status, 400);
    assert.match(await attempted.text(), /no mail server configured/);
  });
});

test('a request with no email address for the client says where the problem is', async () => {
  const nowhere = {
    host: '127.0.0.1',
    port: 1,
    implicitTls: false,
    user: null,
    pass: null,
    rejectUnauthorized: true,
    from: 'a@b.example',
    timeoutMs: 500,
    describe: () => 'nowhere',
  };

  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const created = await client.post('/requests', {
      client: 'No Address Ltd',
      title: '2025 return',
      items: 'Bank statements',
    });
    const requestId = created.headers.get('location').split('/').pop();

    const drafted = await client.post(`/requests/${requestId}/remind`, { days: '30' });
    const page = await drafted.text();
    assert.match(page, /no email address for No Address Ltd/, 'it names who has no address');
    assert.match(page, /<button type="submit" disabled>Send it<\/button>/);

    const attempted = await client.post(`/requests/${requestId}/send-reminder`, { subject: 'Nudge', message: 'Hello' });
    assert.equal(attempted.status, 400);
    assert.match(await attempted.text(), /nowhere to send it/);
  }, { mailer: nowhere });
});

test('the send form refuses an empty subject or an empty message before dialling', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/remind`, { days: '30' });

    const noSubject = await client.post(`/requests/${requestId}/send-reminder`, { subject: '', message: 'Hello' });
    assert.equal(noSubject.status, 400);
    assert.match(await noSubject.text(), /A subject is needed/);

    const noBody = await client.post(`/requests/${requestId}/send-reminder`, { subject: 'Nudge', message: '   \n  ' });
    assert.equal(noBody.status, 400);
    assert.match(await noBody.text(), /The message was empty/);

    assert.equal(fake.seen.messages.length, 0, 'nothing was sent, and nothing was dialled');
  }, { mailer: mailerAt(fake.port) });
});

test('one practice cannot send a reminder for another practice\'s request', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const first = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const second = await practiceWithRequest({ agent, db }, 'ada@practice.example');

    const attempt = await second.client.post(`/requests/${first.requestId}/send-reminder`, {
      subject: 'Nudge',
      message: 'Hello',
    });

    assert.equal(attempt.status, 404, 'not found, which is what a stranger should learn');
    assert.equal(fake.seen.messages.length, 0, 'and nothing was sent');
  }, { mailer: mailerAt(fake.port) });
});

test('a reminder sent with no link in it says so, because it is one the client cannot act on', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/remind`, { days: '30' });

    const sent = await client.post(`/requests/${requestId}/send-reminder`, {
      subject: 'A nudge',
      message: 'Hello Northwind, just a nudge about your 2025 return.\n\nSam',
    });

    assert.equal(sent.status, 303, 'it is still sent: the words are the practice\'s decision');
    assert.equal(new URL(sent.headers.get('location'), 'http://localhost').searchParams.get('nolink'), '1');

    const landed = await client.get(sent.headers.get('location'));
    const page = await landed.text();
    assert.match(page, /There was no link in the message/, 'and the practice is told, on landing');
    assert.match(page, /the client cannot send anything\s+from it/, 'in words that say what it costs');

    const recorded = db
      .prepare("SELECT detail FROM event WHERE request_id = ? AND kind = 'reminder.sent' ORDER BY at")
      .all(requestId);
    assert.match(recorded.at(-1).detail, /with no link in it/, 'and the history says it too');
  }, { mailer: mailerAt(fake.port) });
});

test('a reminder sent with its link says nothing extra', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const drafted = await client.post(`/requests/${requestId}/remind`, { days: '30' });
    const draft = /<textarea id="message"[^>]*>([\s\S]*?)<\/textarea>/.exec(await drafted.text())[1];

    const sent = await client.post(`/requests/${requestId}/send-reminder`, { subject: 'Still needed', message: draft });

    assert.equal(new URL(sent.headers.get('location'), 'http://localhost').searchParams.get('nolink'), null);
    const landed = await client.get(sent.headers.get('location'));
    const page = await landed.text();
    assert.match(page, /Reminder sent\./);
    assert.ok(!/There was no link in the message/.test(page), 'no warning, because there is nothing to warn about');
    assert.match(page, /class="success"/, 'and it is a plain confirmation');
  }, { mailer: mailerAt(fake.port) });
});
  test('sending a reminder needs a session', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { requestId } = await practiceWithRequest({ agent, db });

    const anonymous = agent();
    const attempt = await anonymous.post(`/requests/${requestId}/send-reminder`, { subject: 'Nudge', message: 'Hello' });

    assert.equal(attempt.status, 303);
    assert.equal(attempt.headers.get('location'), '/signin');
    assert.equal(fake.seen.messages.length, 0);
  }, { mailer: mailerAt(fake.port) });
});

test('a relay that cannot be reached fails as a sentence, not as a stack trace', async (t) => {
  // A port nothing is listening on: the connection is refused at once.
  const closed = createServer(() => {});
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/remind`, { days: '30' });

    const sent = await client.post(`/requests/${requestId}/send-reminder`, { subject: 'Nudge', message: 'Hello' });
    assert.equal(sent.status, 400);
    const page = await sent.text();
    assert.match(page, /<strong>Not sent\.<\/strong>/);
    assert.match(page, /connection:/, 'the step that failed is named');
  }, { mailer: mailerAt(deadPort) });
});
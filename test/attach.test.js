/**
 * A document that rides the reminder.
 *
 * The one thing a practice could not do before: send a client a template, a letter or a spreadsheet along
 * with the ask. It is attached to the outgoing message and then gone — never written to the database or to
 * disk — so there is nothing at rest for anyone (this server included) to read, and the product's promise
 * that it cannot read what passes through it stays true in both directions.
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

test('a file rides the reminder, is attached, and is kept nowhere', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    // The form a browser sends with a file in it: multipart/form-data, built here the way the page does.
    const form = new FormData();
    form.set('subject', 'Your paperwork');
    form.set('message', 'Hello,\n\nHere is the template.\n\nThanks,');
    form.set('file', new Blob([Buffer.from('a template, in bytes')], { type: 'text/plain' }), 'template.txt');

    const sent = await fetch(`${base}/requests/${requestId}/send-reminder`, {
      method: 'POST',
      headers: { cookie: client.cookie },
      body: form,
      redirect: 'manual',
    });
    assert.equal(sent.status, 303, 'the reminder went out with the file');

    const wire = fake.seen.messages.at(-1);
    assert.match(wire, /Content-Type: multipart\/mixed/, 'the message carries a file');
    assert.match(wire, /Content-Disposition: attachment; filename="template.txt"/, 'named for what it is');

    // The bytes are in the attachment part, base64 like the body. Strip the line wrapping and the padding
    // (the encoding sheds both the same way) and look for what is left.
    const compact = wire.replace(/=\r\n/g, '').replace(/\r\n/g, '');
    const wanted = Buffer.from('a template, in bytes').toString('base64').replace(/=+$/, '');
    assert.ok(compact.includes(wanted), 'and its bytes travelled with it');

    // And nothing about it is kept: not in the upload table (which holds a client's sealed files), not on
    // disk. The file existed only long enough to be put on the wire.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upload').get().n, 0, 'not stored as an upload');

    // The record still says a file went with it, so the history — and its CSV — shows what was sent.
    const recorded = db.prepare("SELECT detail FROM event WHERE kind = 'reminder.sent'").get();
    assert.match(recorded.detail, /template\.txt/, 'and the record names the file that went with it');
  }, { mailer: mailerAt(fake.port) });
});

test('a reminder with no file is unchanged — the message is still plain, with no parts to spare', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    const form = new FormData();
    form.set('subject', 'Your paperwork');
    form.set('message', 'Hello,\n\nJust a note.\n\nThanks,');
    const sent = await fetch(`${base}/requests/${requestId}/send-reminder`, {
      method: 'POST',
      headers: { cookie: client.cookie },
      body: form,
      redirect: 'manual',
    });
    assert.equal(sent.status, 303);

    const wire = fake.seen.messages.at(-1);
    assert.ok(!/multipart\/mixed/.test(wire), 'no attachment, no multipart/mixed');
    assert.match(wire, /Content-Type: multipart\/alternative/, 'just the words in their two dressings');
  }, { mailer: mailerAt(fake.port) });
});
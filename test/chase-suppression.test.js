/**
 * Smart reminder suppression (docs: the chase asks about what has not arrived, and nothing else).
 *
 * A client who has uploaded every document is not outstanding — their files are sitting in the
 * practice's queue waiting for a human eye, and an automated email asking for them again is nagging
 * somebody who has already done their part. Only a missing document, or one the practice has
 * rejected ("needs attention"), puts a client back on the chase list.
 *
 * `outstandingOf` has always drawn the line exactly here; these tests exist so that the line
 * cannot move quietly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { withServer, practiceWithRequest, createLink, upload, plainBody } from './helpers.js';

/** A relay that accepts everything, and remembers it. Copied small from `send.test.js`. */
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

/** The body of a message the relay received, decoded. */
const bodyOf = (message) => plainBody(message);

/**
 * The messages the relay was asked to carry **to the client**.
 *
 * Filtered by recipient rather than counted wholesale, because the product sends two different kinds of email
 * through one relay: a reminder out to a client, and — since 2s — a note *inward* to the practice when a client
 * sends something. A test that counted every message would report the practice being told about an upload as a
 * client being chased, which is the opposite of what these tests are for.
 */
const toClient = (seen, address) =>
  seen.messages.filter((message) => new RegExp(`TO:.*${address.replace('.', '\\.')}`, 'i').test(message));


/** Receive a file for every document on the request, the way a diligent client would. */
async function uploadEverything({ base, practice, token }) {
  for (const itemId of practice.itemIds) {
    const { response } = await upload({
      base,
      token,
      itemId,
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('a document the client has sent'),
    });
    assert.ok(response.ok, `the upload for ${itemId} succeeds`);
  }
}

test('a client who has sent everything is not chased — their files wait for review, not them', async (t) => {
  const fake = await relay(t);
  await withServer(
    async ({ agent, base, db }) => {
      const practice = await practiceWithRequest({ agent, db });
      const { token } = await createLink(practice.client, practice.requestId);
      await uploadEverything({ base, practice, token });

      const board = await (await practice.client.get('/chase')).text();
      assert.match(board, /Nothing is outstanding for anyone\./, 'the chase page says there is nobody to write to');

      await practice.client.post('/chase', {});
      assert.equal(
        toClient(fake.seen, 'accounts@northwind.example').length,
        0,
        'and no email was written to a client who has done their part',
      );
    },
    { mailer: mailerAt(fake.port) },
  );
});

test('one rejected document puts the client back on the chase list, with the reason in the message', async (t) => {
  const fake = await relay(t);
  await withServer(
    async ({ agent, base, db }) => {
      const practice = await practiceWithRequest({ agent, db });
      const { token } = await createLink(practice.client, practice.requestId);
      await uploadEverything({ base, practice, token });

      const flagged = await practice.client.post(
        `/requests/${practice.requestId}/items/${practice.itemIds[0]}/attention`,
        { attention_note: 'Uploaded 2024 instead of 2025' },
      );
      assert.equal(flagged.status, 303);

      const board = await (await practice.client.get('/chase')).text();
      assert.match(board, /Northwind Ltd/, 'the rejected document puts the client back on the list');

      await practice.client.post('/chase', {});
      const chased = toClient(fake.seen, 'accounts@northwind.example');
      assert.equal(chased.length, 1, 'exactly one message, for exactly one rejected document');
      assert.match(bodyOf(chased[0]), /Uploaded 2024 instead of 2025/, 'and the reason travels with it');
    },
    { mailer: mailerAt(fake.port) },
  );
});

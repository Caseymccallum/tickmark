/**
 * A client's answer, treated as something that happened.
 *
 * Until Phase 2t, everything a client could do *except* send a file was invisible at the request level: an item
 * the client had explained they could not supply counted as outstanding, so the request read "waiting on the
 * client" — identical to a client who had said nothing at all. The item-level record had kept the distinction
 * from the beginning; the board and the notification had not.
 *
 * Two halves, and they are the two halves of the loop: the practice can *see* it (a state, a filter, a count) and
 * the practice is *told* (the same once-a-day notice an arrival gets).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { requestProgress } from '../src/store.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

/** A relay that accepts everything and remembers it. See `send.test.js` for the protocol detail. */
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

const decoded = (message) =>
  Buffer.from(
    message
      .split('\r\n\r\n')[1]
      .replace(/=\r\n/g, '')
      .replace(/\r\n/g, ''),
    'base64',
  ).toString('utf8');

/** What a client says, sent the way the client's page sends it. */
const says = (base, token, itemId, value) =>
  fetch(`${base}/r/${token}/items/${itemId}/says`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ says: value }).toString(),
    redirect: 'manual',
  });

/** Wait for the notice, which is deliberately sent after the client's own answer. See `notify.test.js`. */
async function told(fake, count = 1) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fake.seen.messages.length >= count) return fake.seen.messages;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`the practice was never told (${fake.seen.messages.length} of ${count} after 3s)`);
}

test('an answer is a state of its own, not the same screen as silence', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    assert.equal(requestProgress(db, practice.requestId).state, 'waiting', 'silence reads as waiting');

    await says(base, token, practice.itemIds[0], 'do-not-have');

    const progress = requestProgress(db, practice.requestId);
    assert.equal(progress.state, 'answered', 'and an answer does not');
    assert.equal(progress.clientSaid, 1);
    assert.equal(progress.outstanding, 3, 'the documents are all still outstanding — that is the practice\u2019s call');

    // The board says which it is, and offers a way to see only the ones needing a decision.
    const board = await (await practice.client.get('/requests')).text();
    assert.match(board, /the client answered/, 'the board names the state');
    assert.ok(!/waiting on the client/.test(board), 'and this request is not in the waiting column');
    assert.match(board, /with an answer to read/, 'with a count of them at the top');

    const filtered = await (await practice.client.get('/requests?state=answered')).text();
    assert.match(filtered, /Northwind Ltd/, 'and the filter finds it');

    // The request's own page leads with it rather than burying it under "waiting on the client".
    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();
    assert.match(page, /The client has answered/, 'the request page says so plainly');
    assert.match(page, /waiting on a decision/, 'and says what is being waited on');
    assert.match(page, /I do not have this/, 'and repeats what they said');
  });
});

test('answers sort ahead of waiting, because somebody owes them a decision', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    // A second request that is simply waiting, made after the first so that creation order cannot be what sorts
    // the board — the state has to be what does it.
    const other = await practice.client.post('/requests', {
      client: 'Lodis Ltd',
      client_email: 'ap@lodis.example',
      title: '2025 filing',
      items: 'Accounts',
    });
    assert.equal(other.status, 303);

    await says(base, token, practice.itemIds[0], 'send-later');

    const board = await (await practice.client.get('/requests')).text();
    const answeredAt = board.indexOf('the client answered');
    const waitingAt = board.indexOf('waiting on the client');
    assert.ok(answeredAt > -1 && waitingAt > -1, 'both states are on the board');
    assert.ok(answeredAt < waitingAt, 'the one needing a decision comes first');
  });
});

test('a client answering tells the practice, in the client\u2019s own words', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    const said = await says(base, token, practice.itemIds[0], 'do-not-have');
    assert.equal(said.status, 303, 'the client gets their answer back as usual');

    const messages = await told(fake, 1);
    assert.equal(messages.length, 1, 'and the practice is told once');
    assert.match(messages[0], /Subject: Northwind Ltd has answered about 2025 return/i,
      'the subject says which of the two things happened, derived from the facts rather than guessed at');
    const body = decoded(messages[0]);
    assert.match(body, /One document has an answer from Northwind Ltd/, 'the body says how many');
    assert.match(body, /Bank statements — "I do not have this"/,
      'and quotes the client rather than summarising: the sentence is the decision');
    assert.match(body, /waiting on a decision from you rather than on the client/, 'and says whose turn it is');
    assert.match(body, /Still outstanding/, 'and what else has not arrived');

    // Clearing an answer is news too: "actually, I will send it" means the practice should stop wondering.
    db.prepare("UPDATE event SET at = ? WHERE kind = 'notice.sent'").run('2025-12-01T09:00:00.000Z');
    await says(base, token, practice.itemIds[0], 'do-not-have');
    const cleared = await told(fake, 2);
    assert.match(decoded(cleared[1]), /Northwind Ltd has sent 0 of 3/,
      'and the second notice reports the position without the answer');
    assert.ok(!/has an answer from/.test(decoded(cleared[1])), 'because the answer is gone, not repeated');
  }, { mailer: mailerAt(fake.port) });
});

test('one notice a day covers both triggers — a file and an answer are the same request\u2019s news', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    // A client sends a file, and then answers a question about a different line. They have told the practice two
    // things; they do not need two emails for them, and neither does the practice.
    await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('a document'),
    });
    await told(fake, 1);

    await says(base, token, practice.itemIds[1], 'send-later');
    const before = fake.seen.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(fake.seen.messages.length, before, 'the same request on the same day stays quiet');
  }, { mailer: mailerAt(fake.port) });
});

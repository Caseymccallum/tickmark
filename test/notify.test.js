/**
 * Telling the practice when a client sends something.
 *
 * This is the other half of the loop. Every other email this product sends is triggered by the practice pressing
 * a button; this one is the only automatic message, so most of what is asserted here is about restraint: it must
 * not fire when it has nothing to say, must not fire six times for six files, must not claim work is ready when
 * it is not, and — the rule the whole ordering exists for — **must never be able to break a client's upload.**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

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

/**
 * Wait for the practice to have been told, then hand back the messages.
 *
 * This is not padding: the notification is deliberately sent **after** the client's response, so that a mail
 * server can never delay or fail somebody else's upload. The consequence — which is the point — is that a
 * client's upload completing does not mean the email has gone yet. A test that asserted the moment the upload
 * returned would be testing a race rather than the behaviour, and would fail on a slow machine for the wrong
 * reason.
 */
async function told(t, fake, count = 1) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fake.seen.messages.length >= count) return fake.seen.messages;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`the practice was never told (${fake.seen.messages.length} of ${count} messages after 3s)`);
}

/** Wait for a row to appear, for the same reason: the work happens after the client's answer. */
async function until(t, db, sql, count = 1) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (db.prepare(sql).get().n >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Give the server a moment to *not* do something.
 *
 * Proving silence needs a wait in the other direction: the notification happens after the response, so a check
 * made the instant the upload returns would pass whether or not the rule works. Long enough to have caught a
 * message that was going to be sent, short enough not to slow the suite.
 */
async function quiet(fake, ms = 600) {
  const before = fake.seen.messages.length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(
    fake.seen.messages.length,
    before,
    `nothing further was sent, and the wait gave it every chance (had ${before})`,
  );
}


/** One encrypted file, sent the way the client's browser sends it. */
const send = ({ base, practice, token, itemId, filename = 'scan.pdf' }) =>
  upload({ base, token, itemId, publicKey: practice.keys.publicKey, plaintext: Buffer.from('a document'), filename });

test('the practice is told what arrived, what has not, and where to look', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    await send({ base, practice, token, itemId: practice.itemIds[0], filename: 'private-scan-0031.pdf' });

    const messages = await told(t, fake, 1);
    assert.equal(messages.length, 1, 'one file, one message');
    const message = messages[0];
    assert.match(message, /To: sam@practice\.example/i, 'it goes to the person who asked the client');
    assert.match(message, /Subject: (.*)/i, 'and it has a subject');
    const body = decoded(message);
    assert.match(body, /Northwind Ltd has sent 1 of 3 documents for 2025 return/, 'saying how much has arrived');
    assert.match(body, /Still outstanding/, 'and that two are still owed');
    assert.match(body, /Signed engagement letter/, 'naming what is still owed');
    assert.match(body, /where it stood when this was sent/, 'admitting the count is a snapshot, because it is');
    assert.match(body, /\/requests\//, 'with a link back to the request');

    // The document's *label* is in the message and the file's name is not. The label is what the practice needs
    // in order to decide whether to go and look; the filename is theirs to read on the page.
    assert.ok(!body.includes('private-scan-0031.pdf'), 'the filename stays out of email');
  }, { mailer: mailerAt(fake.port) });
});

test('a client sending several files in one sitting is announced once', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    for (const itemId of practice.itemIds) {
      await send({ base, practice, token, itemId });
    }

    const messages = await told(t, fake, 1);
    assert.equal(messages.length, 1, 'three files in a row, one message — not one per file');
    const body = decoded(messages[0]);
    // Sent on the first file, so it describes the first file. That is the trade the once-a-day rule makes, and
    // the message says so rather than leaving a count that looks wrong by the time it is read.
    assert.match(body, /1 of 3 documents/, 'it says where things stood when it was written');
    assert.match(body, /where it stood when this was sent/, 'and that the request is the current position');
    assert.match(messages[0], /Subject: Northwind Ltd has sent something for 2025 return/i,
      'with a subject that stays true however much arrives afterwards');
    assert.ok(!/Everything asked for has arrived/.test(body), 'and no claim that the work is ready');
  }, { mailer: mailerAt(fake.port) });
});

test('when the whole list is already in, the message says so and says what to do', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    // Two of three arrive. Then, the next day, the last one does — the case where "everything has arrived" is
    // the honest thing to say, and the moment the research says a job is worth starting on.
    await send({ base, practice, token, itemId: practice.itemIds[0] });
    await send({ base, practice, token, itemId: practice.itemIds[1] });
    await told(t, fake, 1);
    db.prepare("UPDATE event SET at = ? WHERE kind = 'notice.sent'").run('2026-01-01T09:00:00.000Z');

    await send({ base, practice, token, itemId: practice.itemIds[2] });
    const messages = await told(t, fake, 2);

    assert.equal(messages.length, 2, 'the completion is announced separately, because it is different news');
    assert.match(messages[1], /Subject: Everything has arrived for 2025 return/i, 'the subject says it outright');
    const body = decoded(messages[1]);
    assert.match(body, /3 of 3 documents/, 'and the body gives the count');
    assert.match(body, /nothing more to wait for/, 'and tells the practice what to do next');
    assert.ok(!/Still outstanding/.test(body), 'and lists nothing as missing, because nothing is');
  }, { mailer: mailerAt(fake.port) });
});

test('a request with everything in but one document rejected does not claim to be complete', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    for (const itemId of practice.itemIds) await send({ base, practice, token, itemId });
    await practice.client.post(`/requests/${practice.requestId}/items/${practice.itemIds[0]}/attention`, {
      attention_note: 'Uploaded 2024 instead of 2025',
    });
    fake.seen.messages.length = 0;
    // The rate rule would otherwise stop this message; it is cleared so the *wording* rule is tested alone.
    db.prepare("DELETE FROM event WHERE kind IN ('notice.sent', 'notice.failed')").run();

    await send({ base, practice, token, itemId: practice.itemIds[0], filename: 'statements-2025.pdf' });

    const body = decoded((await told(t, fake, 1))[0]);
    assert.ok(!/Everything asked for has arrived/.test(body), 'it does not say the work is ready, because it is not');
    assert.match(body, /flagged as needing sending again/, 'it says a document was rejected');
    assert.match(body, /Uploaded 2024 instead of 2025/, 'and repeats the practice\u2019s own reason');
  }, { mailer: mailerAt(fake.port) });
});

test('the practice can turn it off, and then nothing is sent', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    const members = await (await practice.client.get('/members')).text();
    assert.match(members, /Email me when a client sends something/, 'the setting is on the practice\u2019s own page');
    assert.match(members, /name="notify" value="1"\s+checked/, 'and it is on by default');

    const saved = await practice.client.post('/members/notify', {});
    assert.equal(saved.status, 303, 'turning it off is saved');
    const after = await (await practice.client.get('/members?saved=notify')).text();
    assert.ok(!/name="notify" value="1"\s+checked/.test(after), 'and the box comes back unticked');
    assert.match(after, /You will not be emailed about what clients send/, 'with the change said out loud');

    await send({ base, practice, token, itemId: practice.itemIds[0] });
    await quiet(fake);
    assert.equal(fake.seen.messages.length, 0, 'and nothing is sent about a file that arrived');
  }, { mailer: mailerAt(fake.port) });
});

test('a mail server that refuses everything still accepts the client\u2019s file', async (t) => {
  // A relay that says no to every recipient. This is the rule the ordering exists for: the practice's mail
  // server must not be able to turn a client's successful upload into a failure, or into a wait.
  const refusing = createServer((socket) => {
    socket.write('220 relay here\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8').toUpperCase();
      if (text.startsWith('EHLO') || text.startsWith('HELO')) socket.write('250 relay\r\n');
      else if (text.startsWith('QUIT')) socket.write('221 bye\r\n');
      else if (text.startsWith('RCPT')) socket.write('550 no thanks\r\n');
      else socket.write('250 ok\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => refusing.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => refusing.close(resolve)));

  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    const { response } = await send({ base, practice, token, itemId: practice.itemIds[0] });
    assert.equal(response.status, 201, 'the client is told their file was accepted, because it was');

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM upload').get().n,
      1,
      'and it is stored — the notification is the practice\u2019s convenience, not the client\u2019s problem',
    );
    assert.equal(
      await until(t, db, "SELECT COUNT(*) AS n FROM event WHERE kind = 'notice.failed'"),
      true,
      'the failure is recorded rather than swallowed silently',
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'notice.sent'").get().n,
      0,
      'and no notice is claimed, so a later upload will try again rather than being suppressed',
    );

    // The practice can still see what the email could not tell them.
    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();
    assert.match(page, /1 of 3 received/, 'the board remains the source of truth');
  }, { mailer: mailerAt(refusing.address().port) });
});

test('a second sitting later the same day stays quiet, and a new day speaks again', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    await send({ base, practice, token, itemId: practice.itemIds[0] });
    const first = await told(t, fake, 1);
    assert.equal(first.length, 1, 'the first file of the day is announced');

    await send({ base, practice, token, itemId: practice.itemIds[1] });
    await quiet(fake);
    assert.equal(fake.seen.messages.length, 1, 'the second does not, because the same request already had its say');

    // Backdate the notice by a month, which is what a later day looks like to the rule. Nothing else about the
    // request changes.
    db.prepare("UPDATE event SET at = ? WHERE kind = 'notice.sent'").run('2025-12-01T09:00:00.000Z');
    await send({ base, practice, token, itemId: practice.itemIds[2] });
    const messages = await told(t, fake, 2);
    assert.equal(messages.length, 2, 'and on a later day the practice hears about it again');
    assert.match(decoded(messages[1]), /3 of 3 documents/, 'with the position as it now stands');
  }, { mailer: mailerAt(fake.port) });
});

test('a client writing a message tells the practice, and the subject does not pretend a file arrived', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    await agent().post(`/r/${token}/message`, {
      body: 'The statements are in the post — the bank said five working days.',
    });

    const [message] = await told(t, fake);
    // The subject is the one part of an email read without opening it, and it is derived from the facts rather
    // than passed in — so a message cannot arrive described as a document.
    assert.match(message, /Subject: .*has written about/, `the subject says what happened: ${message.split('\r\n')[0]}`);
    assert.ok(
      !/has sent something/.test(message),
      'and does not claim a document arrived, because none did',
    );

    const body = decoded(message);
    assert.match(body, /the bank said five working days/, 'the client’s own words are quoted in the body');
    assert.match(body, /0 of 3 documents/, 'and the position is stated as it is, not dressed up');
  }, { mailer: mailerAt(fake.port) });
});

test('a file nobody asked for is named to the practice, and is not counted as received', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    const { encryptFile } = await import('../web/tickmark-crypto.js');
    await fetch(`${base}/r/${token}/extra`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('vat-return.pdf') },
      body: await encryptFile(practice.keys.publicKey, Buffer.from('the VAT return')),
    });

    const [message] = await told(t, fake);
    const body = decoded(message);
    assert.match(body, /1 file was sent that nothing had asked for/, 'the practice is told what it is');
    assert.match(body, /0 of 3 documents/, 'and it is not counted as one of the three that were asked for');
    assert.ok(!/Everything has arrived/.test(body), 'so nothing claims the request is complete');
  }, { mailer: mailerAt(fake.port) });
});


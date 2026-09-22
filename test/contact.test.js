/**
 * Recording a contact that was not an email.
 *
 * Until this existed the only contact the product could represent was an email it had sent itself, so a practice
 * that chased by phone had two bad options: nag by email an hour after the call, or stop trusting the software's
 * idea of who needed chasing. The research is specific that this is where the time goes — half of practitioners
 * name "uncooperative clients" their first concern, and uncooperative clients are the ones who do not answer
 * email.
 *
 * Two halves again, and the first is the one that must never break: **it sends nothing.**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { history, requestProgress } from '../src/store.js';
import { createLink, practiceWithRequest, withServer } from './helpers.js';

/** A relay that accepts everything and remembers it, so a test can prove that nothing was sent. */
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

test('recording a call writes it in the record and sends the client nothing at all', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });

    const recorded = await practice.client.post(`/requests/${practice.requestId}/contact`, {
      note: 'Phoned — Sarah says the statements are with the bank',
    });
    assert.equal(recorded.status, 303, 'the note is accepted');
    assert.equal(recorded.headers.get('location'), `/requests/${practice.requestId}?contacted=1`, 'and confirmed');

    const [event] = history(db, practice.requestId).filter((row) => row.kind === 'request.contacted');
    assert.ok(event, 'it is in the record');
    assert.equal(event.detail, 'Phoned — Sarah says the statements are with the bank', 'in the practice\u2019s words');

    // The rule that matters most: this is a record, not a message. Nothing goes near the relay, and the client's
    // page learns nothing about it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fake.seen.messages.length, 0, 'no email is sent — not to the client, not to the practice');
    const { token } = await createLink(practice.client, practice.requestId);
    const clientPage = await (await agent().get(`/r/${token}`)).text();
    assert.ok(!/Phoned|Sarah/.test(clientPage), 'and the client is not told the practice rang them');

    // The page the practice lands on says what happened and what it means.
    const page = await (await practice.client.get(`/requests/${practice.requestId}?contacted=1`)).text();
    assert.match(page, /<strong>Recorded\.<\/strong>/, 'the confirmation is on the page they land on');
    assert.match(page, /Nothing was sent/, 'and says outright that nothing went out');
    assert.match(page, /counts against your chase cadence/, 'and what it did do');
  }, { mailer: mailerAt(fake.port) });
});

test('a contact with no words is refused, because the note is the record', async (t) => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });

    const blank = await practice.client.post(`/requests/${practice.requestId}/contact`, { note: '   ' });
    assert.equal(blank.status, 400, 'an empty note is refused');
    assert.match(await blank.text(), /Say what happened in a few words/, 'and says why');
    assert.equal(
      history(db, practice.requestId).filter((row) => row.kind === 'request.contacted').length,
      0,
      'nothing was written',
    );

    const long = await practice.client.post(`/requests/${practice.requestId}/contact`, { note: 'x'.repeat(201) });
    assert.equal(long.status, 400, 'and so is an essay');
  });
});

test('recording a contact keeps the chase off that client until the cadence lets it back', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });

    // A fourteen-day cadence, then a phone call. The call is a contact, so the batch run must hold them back —
    // which is the whole reason for recording it: a practice that rang a client this morning should not be able
    // to email them this afternoon by pressing one button.
    await practice.client.post('/chase/cadence', { days: '14' });
    await practice.client.post(`/requests/${practice.requestId}/contact`, { note: 'Phoned them about it' });

    const list = await (await practice.client.get('/chase')).text();
    assert.match(list, /in touch just now/, 'the list says when they were last in contact');
    assert.match(list, /held back — inside your cadence/, 'and that the cadence holds them back');
    assert.match(list, /Nothing would be sent at the moment/, 'so the run would send nothing at all');

    await practice.client.post('/chase', {});
    assert.equal(fake.seen.messages.length, 0, 'and pressing the button sends nothing');
  }, { mailer: mailerAt(fake.port) });
});

test('the clients list and its export call the column what it now means', async () => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    await practice.client.post(`/requests/${practice.requestId}/contact`, { note: 'Phoned them' });

    const page = await (await practice.client.get('/clients')).text();
    assert.match(page, /Last contact/, 'the column is "Last contact" rather than "Last written to"');
    assert.ok(!/Last written to/.test(page), 'and the old name is gone, because it would now be a lie');

    const csv = await (await practice.client.get('/clients.csv')).text();
    assert.match(csv, /Last contact/, 'the export says the same thing');
    const row = csv.split('\r\n').find((line) => line.startsWith('Northwind'));
    assert.match(row, /\d{4}-\d{2}-\d{2}/, 'and the phone call is the date in it');
  });
});

test('a contact is the practice\u2019s own record, so it needs a signed-in practice', async () => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });

    const anonymous = await agent().post(`/requests/${practice.requestId}/contact`, { note: 'Not mine to write' });
    assert.equal(anonymous.status, 303, 'a signed-out post is sent to sign in rather than refused rudely');
    assert.match(anonymous.headers.get('location') ?? '', /^\/signin/, 'which is the sign-in page');
    assert.equal(
      history(db, practice.requestId).filter((row) => row.kind === 'request.contacted').length,
      0,
      'and nothing is written by somebody who is not signed in',
    );
    assert.equal(requestProgress(db, practice.requestId).state, 'waiting', 'the request is where it was');
  });
});

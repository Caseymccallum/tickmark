/**
 * Who is asking.
 *
 * Every letter this product sends asks a stranger for their financial records, and every one of them used to
 * end `Thanks,` and nothing else — unsigned — while the portal they were sent to said "Tickmark" and never
 * said which firm wanted the documents. That is what a phishing email looks like, and the fix is not
 * cosmetic: the practice's own name belongs in front of the client, in the letter and on the page.
 *
 * The practice name is renameable (Members page), so the test that sends a real message renames it first and
 * checks the *current* name is what a client sees — a name captured at signup and never updated would be
 * worse than none at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { createLink, practiceWithRequest, withServer } from './helpers.js';
import { openingDraft, reminderDraft } from '../src/app.js';

test('a reminder is signed by the practice, and says nothing it was not told', () => {
  const named = reminderDraft({
    clientName: 'Northwind Ltd',
    title: '2025 return',
    dueAt: null,
    outstanding: ['Bank statements'],
    link: 'https://office.example/r/tok',
    practiceName: 'Lodis Accountancy',
  });
  assert.match(named.body, /Thanks,\s*\n\s*Lodis Accountancy/, 'the practice signs its own letter');
  assert.equal(named.body.trimEnd().endsWith('Lodis Accountancy'), true, 'and the name is the last thing read');

  const unnamed = reminderDraft({
    clientName: 'Northwind Ltd',
    title: '2025 return',
    dueAt: null,
    outstanding: ['Bank statements'],
    link: 'https://office.example/r/tok',
  });
  assert.ok(!/undefined|null/.test(unnamed.body), 'a caller with no name gets a clean sign-off, not "undefined"');
  assert.match(unnamed.body, /Thanks,$/m);
});

test('the first ask is signed too, and it quotes the practice note above the list', () => {
  const draft = openingDraft({
    clientName: 'Northwind Ltd',
    title: '2026 filing',
    dueAt: '2026-04-30',
    items: ['Accounts for the year', 'Corporation tax return'],
    note: 'Hi Sarah, here is the list for your 2026 filing.',
    link: 'https://office.example/r/tok',
    practiceName: 'Lodis Accountancy',
  });

  assert.match(draft.body, /^Hello Northwind Ltd,/);
  assert.match(draft.body, /Hi Sarah, here is the list for your 2026 filing\./, 'the practice\u2019s own words come first');
  assert.ok(
    draft.body.indexOf('Hi Sarah') < draft.body.indexOf('Accounts for the year'),
    'above the list, where the client will read them',
  );
  assert.match(draft.body, /Lodis Accountancy/, 'and it is signed');
});

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

test('what goes out is signed with the current name, and the client\u2019s page names the firm', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    // Renamed first: the name a client sees has to be the practice's current one.
    const renamed = await client.post('/members/name', { name: 'Lodis Accountancy' });
    assert.equal(renamed.status, 303);

    const drafted = await client.post(`/requests/${requestId}/remind`, { days: '30' });
    assert.match(await drafted.text(), /Lodis Accountancy/, 'the draft the practice edits is signed');

    const sent = await client.post(`/requests/${requestId}/send-reminder`, {
      subject: 'Your 2025 paperwork',
      message: 'Hello Northwind Ltd,\n\nJust the engagement letter now.\n\nThanks,\n\nLodis Accountancy',
    });
    assert.equal(sent.status, 303);
    const wire = Buffer.from(fake.seen.messages[0].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.match(wire, /Lodis Accountancy/, 'and what reached the relay is signed');

    // The portal the client is sent to names the sender too, in the tab and on the page.
    const { token } = await createLink(client, requestId);
    const page = await (await agent().get(`/r/${token}`)).text();
    assert.match(page, /<p class="eyebrow">Lodis Accountancy<\/p>/, 'the client\u2019s page says who is asking');
    assert.match(page, /<title>Lodis Accountancy — 2025 return · Tickmark<\/title>/, 'and so does the tab');
  }, { mailer: mailerAt(fake.port) });
});

test('a practice that has not renamed itself still sends something a client can place', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    assert.equal(
      db.prepare('SELECT name FROM practice').get().name,
      'My practice',
      'the placeholder name is what a brand-new practice has',
    );

    const drafted = await client.post(`/requests/${requestId}/send`, { days: '30' });
    assert.match(await drafted.text(), /My practice/, 'and it is used rather than the letter going out anonymous');

    const page = await (await agent().get(`/r/${(await createLink(client, requestId)).token}`)).text();
    assert.match(page, /<p class="eyebrow">My practice<\/p>/, 'the client sees the name they were emailed by');
  }, { mailer: mailerAt(fake.port) });
});

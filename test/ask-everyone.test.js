/**
 * Asking everyone at once.
 *
 * Three properties, and they are the three that make a bulk action worth trusting: every client gets **their
 * own** link rather than a shared one; a client who cannot be written to is named rather than silently dropped;
 * and a send that fails partway leaves requests that exist and can still be sent by hand.
 *
 * The relay is a real SMTP server speaking real SMTP, as in `send.test.js`, because part of what is being tested
 * is that fifty messages actually leave the building.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { createClient, itemsOf, requestsFor } from '../src/store.js';
import { PASSWORD, signUp, withServer, plainBody } from './helpers.js';

/**
 * A relay that accepts everyone it is asked to, except the addresses named in `refuse` — which get a real
 * "no such user" reply. Modelled on `send.test.js`'s relay; see it for the protocol detail.
 *
 * Refusing one address rather than all of them is the point: the failure this feature is arranged around is one
 * dead mailbox among fifty, not a relay that is down. A relay that is down is exercised by refusing everything.
 */
async function relay(t, { refuse = [] } = {}) {
  const seen = { messages: [], refused: [] };
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
        else if (upper.startsWith('RCPT TO')) {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? line;
          if (refuse.some((dead) => address.includes(dead))) {
            seen.refused.push(address);
            socket.write('550 5.1.1 no such user\r\n');
          } else {
            socket.write('250 ok\r\n');
          }
        } else if (upper === 'DATA') {
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

/** What a message's body actually says, decoded. */
const bodyOf = (message) => plainBody(message);

/** A practice with a key, a saved list, and as many clients as the test asks for. */
async function practiceWithList({ agent: make, db }, clients, items = 'Photo ID\nBank statements') {
  const client = make();
  await signUp(client, 'sam@practice.example', PASSWORD);

  const { generatePracticeKey } = await import('../web/tickmark-crypto.js');
  const { publicKey, wrappedPrivateKey } = await generatePracticeKey('a passphrase long enough');
  const keyed = await client.post('/setup', {
    public_key: JSON.stringify(publicKey),
    wrapped_private_key: wrappedPrivateKey,
  });
  assert.equal(keyed.status, 303, 'the fixture makes a key');

  const practiceId = db.prepare('SELECT id FROM practice').get().id;
  const createdBy = db.prepare('SELECT id FROM practitioner').get().id;
  for (const [name, email] of clients) {
    createClient(db, { practiceId, createdBy, name, email });
  }
  const created = await client.post('/templates', { name: 'Standard return', items, note: 'Please send these.' });
  assert.equal(created.status, 303, 'the fixture saves the list');

  return { client, practiceId, templateId: created.headers.get('location').split('/').pop() };
}

test('one action asks every client, and each gets a link of their own', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, practiceId, templateId } = await practiceWithList(
      { agent, db },
      [['Northwind Ltd', 'ap@northwind.example'], ['Lodis Ltd', 'ap@lodis.example']],
    );

    const report = await client.post('/ask-everyone', {
      template_id: templateId,
      title: '2026 tax return',
      due: '2026-04-30',
      days: '60',
      client_note: 'Here is the list for 2026.',
      everyone: '1',
    });
    assert.equal(report.status, 200, 'the run answers with a report rather than a redirect');
    assert.match(await report.text(), /2 clients asked/, 'and says how many were asked');

    assert.equal(fake.seen.messages.length, 2, 'two messages left the building — one per client, not one to both');
    const bodies = fake.seen.messages.map(bodyOf);
    assert.ok(bodies.every((body) => /Here is the list for 2026/.test(body)), 'carrying the practice\u2019s note');
    assert.ok(bodies.every((body) => /Photo ID/.test(body)), 'and the checklist');

    const links = bodies.map((body) => /\/r\/([A-Za-z0-9_-]{20,})/.exec(body)?.[1]);
    assert.ok(links[0] && links[1], 'both messages carry a link');
    assert.notEqual(links[0], links[1], 'and they are different links, because a link belongs to one request');

    const made = requestsFor(db, practiceId, { scope: 'open' });
    assert.equal(made.length, 2, 'a request per client');
    assert.equal(new Set(made.map((row) => row.client_name)).size, 2, 'against two different clients');
    for (const row of made) {
      assert.equal(itemsOf(db, row.id).length, 2, `${row.client_name} was asked for both documents`);
    }
    assert.equal(made[0].title, '2026 tax return', 'with the title the practice typed');
    assert.equal(made[0].due_at, '2026-04-30', 'and the deadline');

    // And one of those links works as a client's page, which is the whole point of having issued it.
    const seen = await agent().get(`/r/${links[0]}`);
    assert.equal(seen.status, 200, 'the link opens');
    const portal = await seen.text();
    assert.match(portal, /Here is the list for 2026\./, 'and shows the practice\u2019s note to the client');
    assert.match(portal, /Bank statements/, 'and their own list');
  }, { mailer: mailerAt(fake.port) });
});

test('a client with no email address is named, not asked and not quietly dropped', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, templateId } = await practiceWithList(
      { agent, db },
      [['Northwind Ltd', 'ap@northwind.example'], ['Paper Only Ltd', null]],
    );

    const page = await (await client.get('/ask-everyone')).text();
    assert.match(page, /1 of 2\s+clients can be emailed/, 'the page says who can be written to before anything happens');
    assert.match(page, /Paper Only Ltd[\s\S]{0,200}no email address — add one on their page first/, 'and why not');

    const report = await client.post('/ask-everyone', {
      template_id: templateId,
      title: '2026 tax return',
      everyone: '1',
    });
    assert.equal(report.status, 200);
    const shown = await report.text();
    assert.match(shown, /1 client asked/, 'only the reachable one is asked');
    assert.match(shown, /Paper Only Ltd/, 'and the one who could not be is named on the report');
    assert.equal(fake.seen.messages.length, 1, 'exactly one message went out');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request').get().n,
      1,
      'and no request was made for the client with nowhere to send it',
    );
  }, { mailer: mailerAt(fake.port) });
});

test('only the ticked clients are asked when the practice ticks names', async (t) => {
  const fake = await relay(t);
  await withServer(async ({ agent, db }) => {
    const { client, practiceId, templateId } = await practiceWithList(
      { agent, db },
      [['Northwind Ltd', 'ap@northwind.example'], ['Lodis Ltd', 'ap@lodis.example']],
    );
    const lodis = db.prepare('SELECT id FROM client WHERE name = ?').get('Lodis Ltd').id;

    const report = await client.post('/ask-everyone', {
      template_id: templateId,
      title: '2026 tax return',
      client_id: lodis,
    });
    assert.equal(report.status, 200);
    assert.equal(fake.seen.messages.length, 1, 'one message, for the one client ticked');

    const made = requestsFor(db, practiceId, { scope: 'open' });
    assert.equal(made.length, 1, 'and one request');
    assert.equal(made[0].client_name, 'Lodis Ltd', 'against the client who was ticked');
  }, { mailer: mailerAt(fake.port) });
});

test('a relay that refuses one recipient does not stop the others, and the failure is reported', async (t) => {
  // One dead mailbox, not a dead relay. This is the failure the whole design is arranged around: the other
  // fifty must go out regardless, and the practice must be told which one did not.
  const fake = await relay(t, { refuse: ['dead@northwind.example'] });
  await withServer(async ({ agent, db }) => {
    const { client, practiceId, templateId } = await practiceWithList(
      { agent, db },
      [['Northwind Ltd', 'dead@northwind.example'], ['Lodis Ltd', 'ap@lodis.example']],
    );

    const report = await client.post('/ask-everyone', {
      template_id: templateId,
      title: '2026 tax return',
      everyone: '1',
    });
    assert.equal(report.status, 200, 'the run finishes rather than throwing');
    const page = await report.text();
    assert.match(page, /2 clients asked/, 'both are accounted for');
    assert.match(page, /1 sent, 1 failed/, 'and the report counts them apart');
    assert.match(page, /5\.1\.1 no such user/, 'with the relay\u2019s own words for the one that failed');

    // Both requests exist — the failure is a delivery failure, not a creation failure, and that difference is
    // what lets the practice send the failed one by hand instead of rebuilding it.
    assert.equal(requestsFor(db, practiceId, { scope: 'open' }).length, 2, 'both requests were made');
    assert.equal(fake.seen.messages.length, 1, 'and one message got through');
    assert.equal(fake.seen.refused.length, 1, 'the other was refused by the relay, as the fixture intends');

    const failed = db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'reminder.failed'").get().n;
    assert.equal(failed, 1, 'the failure is recorded against the request it belongs to, not only on the page');

    // The request the email bounced off is still perfectly usable: its link exists, and the practice can send it
    // by hand from the page they already have.
    const stuck = requestsFor(db, practiceId, { scope: 'open' }).find((row) => row.client_name === 'Northwind Ltd');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM access_token WHERE request_id = ?').get(stuck.id).n,
      1,
      'a link was issued before the email was attempted, so nothing has to be rebuilt',
    );
  }, { mailer: mailerAt(fake.port) });
});

test('with no mail server configured, nothing is made and the page says why', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, templateId } = await practiceWithList({ agent, db }, [['Northwind Ltd', 'ap@northwind.example']]);

    const page = await (await client.get('/ask-everyone')).text();
    assert.match(page, /no mail server configured/, 'the page warns before anything is attempted');

    const refused = await client.post('/ask-everyone', {
      template_id: templateId,
      title: '2026 tax return',
      everyone: '1',
    });
    assert.equal(refused.status, 400, 'and the action is refused rather than half-done');
    assert.match(await refused.text(), /Nothing was made/, 'which it says outright');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request').get().n,
      0,
      'no request exists that nobody was told about',
    );
  });
});

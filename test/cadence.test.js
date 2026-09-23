/**
 * The chase cadence: how often the batch run may write to the same client.
 *
 * This is the last named gap in `docs/product-needs.md`, and the design decision inside it is the point of
 * the feature: **the number is the practice's, and there is no default.** Tickmark starts at 0, which means
 * no limit, because how often it is acceptable to chase a client is a firm's judgement about its own
 * clients. So what these tests hold is not "the threshold is 14 days" — nothing in the source says that —
 * but four smaller claims:
 *
 * 1. A practice can set it, and the setting survives.
 * 2. The run respects it **and says who it held back**, because a run that quietly skips people is
 *    indistinguishable from a run that wrote to them.
 * 3. Setting it back to 0 restores the old behaviour, so the feature cannot become a trap.
 * 4. The single-request reminder is **not** held back. That distinction is deliberate: on one request's
 *    page you are looking at that client, and the cadence exists for the button that writes to everybody.
 *
 * The relay is the shared fake from `test/smtp-relay.js`, and every message it receives is counted — which
 * is what makes "nothing was sent" a measurement rather than an absence of an error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from './smtp-relay.js';
import { setUpKey, signUp, withServer, plainBody } from './helpers.js';

const PAST = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

const mailerFor = (relay) => ({
  host: '127.0.0.1',
  port: relay.port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Office <office@practice.example>',
  timeoutMs: 3000,
  describe: () => `127.0.0.1:${relay.port} (the test relay)`,
});

/** A practice with a key and one client who owes two documents. */
async function practiceOwing(client) {
  const signedUp = await signUp(client, 'office@practice.example');
  assert.equal(signedUp.status, 303, 'the sign-up must land, or everything below is about nothing');
  await setUpKey(client);

  const created = await client.post('/requests', {
    client: 'Northwind Ltd',
    client_email: 'accounts@northwind.example',
    title: '2025 return',
    items: 'Bank statements\nPhoto ID',
    due: PAST,
  });
  assert.equal(created.status, 303, 'creating the request must land');
  return created.headers.get('location').split('/').pop();
}

/** Every message the relay actually accepted, parsed into what a test wants to assert on. */
function received(relay) {
  const recipients = relay.seen.conversation
    .filter((line) => /^RCPT TO:/i.test(line))
    .map((line) => /<([^>]+)>/.exec(line)[1]);

  return relay.seen.messages.map((raw, index) => {
    const [head] = raw.split('\r\n\r\n');
    const headers = {};
    for (const line of head.split('\r\n')) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
    }
    return {
      to: recipients[index] ?? null,
      subject: decodeHeader(headers.subject),
      body: plainBody(raw),
    };
  });
}

/** `=?UTF-8?B?...?=` back to text, so a subject can be asserted in words. */
function decodeHeader(value) {
  const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(String(value ?? ''));
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : String(value ?? '');
}

test('a practice sets a cadence, and the run respects it and names who it held back', async (t) => {
  const relay = await startRelay(t);
  await withServer(async ({ agent }) => {
    const client = agent();
    await practiceOwing(client);

    // Before anything is set: the form starts at 0, and the page says why 0 is the starting point rather
    // than a threshold chosen here.
    const before = await (await client.get('/chase')).text();
    assert.match(before, /name="days" type="number" min="0" max="365" value="0"/, 'the cadence starts at zero');
    assert.match(before, /0 means no limit, and that is where this starts/, 'and the page says so');
    assert.match(before, /It applies to this page only/, 'and that one request is never held back');
    assert.match(before, /With no cadence set, it has no memory of who it has already written to/, 'and warns about what that means');

    // Set it, through the form a practice would use.
    const saved = await client.post('/chase/cadence', { days: '14' });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/chase?saved=14', 'entered by a route a person can follow');

    const after = await (await client.get('/chase?saved=14')).text();
    assert.match(after, /Your cadence is now 14\s+days/, 'the change is confirmed');
    assert.match(after, /value="14"/, 'and the form shows it');
    assert.match(after, /Clients inside your cadence are named in the report rather than dropped quietly/,
      'and the page now says something different about the run');

    // The first run sends.
    const first = await client.post('/chase', {});
    assert.equal(first.status, 200);
    assert.match(await first.text(), /1 sent, 0 failed, 0 not attempted/);
    assert.equal(received(relay).length, 1, 'the relay got one message');
    assert.equal(received(relay)[0].to, 'accounts@northwind.example');
    assert.match(received(relay)[0].body, /\/r\/[A-Za-z0-9_-]{20,}/, 'and it carries a link');

    // The second run does not, and the client is named in both places rather than vanishing.
    const report = await (await client.post('/chase', {})).text();
    assert.match(report, /0 sent, 0 failed, 0 not attempted, 1 held back by your cadence/,
      'the summary counts the client it held back');
    assert.match(report, /Northwind Ltd/, 'and the table names them');
    assert.match(
      report,
      /held back by your cadence — in touch just now/,
      'with the reason and how long ago — "in touch" rather than "reminded", because since 2v the cadence counts a phone call too',
    );
    assert.equal(received(relay).length, 1, 'and nothing more reached the relay');

    const list = await (await client.get('/chase')).text();
    assert.match(list, /held back — inside your cadence/, 'the list marks them');
    assert.match(list, /Nothing would be sent at the moment/, 'and the banner says the run would send nothing');
    assert.match(list, /because every client who owes something was in touch inside your\s+14-day cadence/,
      'naming the reason');
    assert.match(list, /<button type="submit" disabled>Send<\/button>/, 'and the button is disabled, not misleading');
  }, { mailer: mailerFor(relay) });
});

test('setting the cadence back to zero restores sending, so the setting cannot become a trap', async (t) => {
  const relay = await startRelay(t);
  await withServer(async ({ agent }) => {
    const client = agent();
    await practiceOwing(client);
    await client.post('/chase/cadence', { days: '14' });

    await client.post('/chase', {});
    assert.equal(received(relay).length, 1);
    await client.post('/chase', {});
    assert.equal(received(relay).length, 1, 'held back, as the test above establishes');

    const cleared = await client.post('/chase/cadence', { days: '0' });
    assert.equal(cleared.status, 303);
    assert.equal(cleared.headers.get('location'), '/chase?saved=0');
    const page = await (await client.get('/chase?saved=0')).text();
    assert.match(page, /Your cadence is now 0\s+days — no limit/, 'zero reads as "no limit", not as a bug');

    await client.post('/chase', {});
    assert.equal(received(relay).length, 2, 'and the run writes again, which is what zero means');
  }, { mailer: mailerFor(relay) });
});

test('one request by hand is never held back, because there you are looking at that client', async (t) => {
  const relay = await startRelay(t);
  await withServer(async ({ agent }) => {
    const client = agent();
    const requestId = await practiceOwing(client);
    await client.post('/chase/cadence', { days: '14' });

    await client.post('/chase', {});
    assert.equal(received(relay).length, 1, 'the batch run sent once');

    // The batch would now send nothing. The single-request path is a different act: deliberate, about one
    // client, with the words on the screen in front of the person sending it.
    const single = await client.post(`/requests/${requestId}/send-reminder`, {
      subject: 'A nudge about your return',
      message: 'Just the bank statements now, please.\n\nThanks,',
    });
    assert.equal(single.status, 303, 'it is sent');
    assert.equal(received(relay).length, 2, 'and it reached the relay');
    assert.equal(received(relay)[1].to, 'accounts@northwind.example');
    assert.equal(received(relay)[1].subject, 'A nudge about your return');
    assert.match(received(relay)[1].body, /Just the bank statements now/);

    // The batch still holds back, so the two rules are independent rather than one overriding the other.
    await client.post('/chase', {});
    assert.equal(received(relay).length, 2, 'the batch still declines');
  }, { mailer: mailerFor(relay) });
});

test('no email address is reported as that, not as being held back by the cadence', async (t) => {
  const relay = await startRelay(t);
  await withServer(async ({ agent }) => {
    const client = agent();
    await practiceOwing(client);
    await client.post('/requests', {
      client: 'Silent Ltd',
      client_email: '',
      title: '2025 return',
      items: 'Photo ID',
      due: PAST,
    });
    await client.post('/chase/cadence', { days: '14' });

    await client.post('/chase', {}); // writes to the one with an address
    const report = await (await client.post('/chase', {})).text();

    assert.match(report, /Silent Ltd/, 'the client with no address is named');
    assert.match(report, /no email address on this client/, 'and the reason given is the address');
    assert.match(report, /Northwind Ltd/, 'and the held-back client is named too');
    assert.match(report, /held back by your cadence/, 'with its own, different reason');
    assert.ok(
      !/Silent Ltd[\s\S]{0,300}held back by your cadence/.test(report),
      'the two reasons are not swapped: having no address is the more fundamental one',
    );
    assert.equal(received(relay).length, 1, 'and only the one client with an address was ever written to');
  }, { mailer: mailerFor(relay) });
});

test('a cadence that is not a whole number of days is refused, and nothing changes', async (t) => {
  await withServer(async ({ agent, db }) => {
    const client = agent();
    await practiceOwing(client);
    await client.post('/chase/cadence', { days: '14' });

    for (const bad of ['-1', '3.5', 'soon', '366', '']) {
      const refused = await client.post('/chase/cadence', { days: bad });
      assert.equal(refused.status, 400, `${JSON.stringify(bad)} is refused`);
      assert.match(
        await refused.text(),
        /has to be a whole number of days between 0 and 365/,
        'with a sentence saying what is wanted',
      );
    }

    assert.equal(
      db.prepare('SELECT cadence_days FROM practice').get().cadence_days,
      14,
      'and the practice still has the cadence it set, rather than a refused value having landed',
    );
  });
});

test('a cadence belongs to one practice and does not reach another', async (t) => {
  const relay = await startRelay(t);
  await withServer(async ({ agent, db }) => {
    const mine = agent();
    await practiceOwing(mine);
    await mine.post('/chase/cadence', { days: '14' });
    await mine.post('/chase', {});
    assert.equal(received(relay).length, 1);

    const theirs = agent();
    assert.equal((await signUp(theirs, 'other@practice.example')).status, 303);
    await setUpKey(theirs);
    assert.equal(
      (await theirs.post('/requests', {
        client: 'Elsewhere Ltd',
        client_email: 'accounts@elsewhere.example',
        title: '2025 return',
        items: 'Bank statements',
        due: PAST,
      })).status,
      303,
    );

    const theirPage = await (await theirs.get('/chase')).text();
    assert.match(theirPage, /value="0"/, 'their cadence is untouched by mine');

    await theirs.post('/chase', {});
    assert.equal(
      received(relay).filter((message) => message.to === 'accounts@elsewhere.example').length,
      1,
      'and their run is not held back by a setting they never made',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM practice WHERE cadence_days = 14').get().n,
      1,
      'one practice has a cadence and the other does not',
    );
  }, { mailer: mailerFor(relay) });
});
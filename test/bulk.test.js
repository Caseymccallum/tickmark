/**
 * Chasing everybody at once.
 *
 * This is the feature the research says decides whether a practice can use the tool at all — "manual
 * tracking breaks down past fifty clients", and chasing is where the week goes. It is also the only
 * action in the product that writes to the outside world in bulk, so most of what is asserted here is
 * about the ways a bulk send goes wrong: one dead mailbox, a relay that refuses everything, a run that
 * cannot finish, and a client with no address at all.
 *
 * The relay is the shared one from `test/smtp-relay.js`, given a per-address refusal so that one client's
 * mailbox can fail while the rest succeed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startRelay } from './smtp-relay.js';
import { setUpKey, signUp, withServer, plainBody } from './helpers.js';

const PAST = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

/** A mailer pointed at the fake relay — the same shape `mailerFromEnvironment` produces. */
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

/**
 * A practice with a key and exactly two clients who owe something: one with an address, one without.
 *
 * Two, and no third. An earlier version of this fixture created a third request that one test closed and
 * the others chased — so the fixture meant different things in different tests and two of them failed for
 * a reason that had nothing to do with the code. A fixture that means one thing is the whole point.
 */
async function practiceOwingTwice(client) {
  const signedUp = await signUp(client, 'office@practice.example');
  assert.equal(signedUp.status, 303, 'the sign-up must land, or everything below is about nothing');
  await setUpKey(client);

  const make = async (name, email, title, items, due = null) => {
    const created = await client.post('/requests', {
      client: name,
      client_email: email ?? '',
      title,
      items,
      due: due ?? '',
    });
    assert.equal(created.status, 303, `creating the request for ${name} must land`);
    return created.headers.get('location').split('/').pop();
  };

  return {
    owesWithAddress: await make('Northwind Ltd', 'accounts@northwind.example', '2025 return', 'Bank statements\nPhoto ID', PAST),
    owesNoAddress: await make('Silent Ltd', null, '2025 return', 'Photo ID'),
  };
}

test('the list before the button names everyone, and says who cannot be reached', async (t) => {
  const relay = await startRelay(t);
  await withServer(async ({ base, db, agent }) => {
    const client = agent();
    const ids = await practiceOwingTwice(client);

    // A closed request still has items that never arrived, so it is exactly the case worth checking:
    // closing means "stop asking", and that has to include this button.
    const closed = await client.post('/requests', {
      client: 'Finished Ltd',
      client_email: 'done@finished.example',
      title: '2025 return',
      items: 'Photo ID',
      due: '',
    });
    await client.post(`/requests/${closed.headers.get('location').split('/').pop()}/close`);

    const page = await (await client.get('/chase')).text();

    assert.match(page, /Northwind Ltd/, 'a client who owes something is listed');
    assert.match(page, /Silent Ltd/, 'and so is one with no address, rather than being quietly dropped');
    assert.ok(!/Finished Ltd/.test(page), 'a closed request is not on the chase list');

    assert.match(page, /no email address on this client/, 'the missing address is stated, not guessed at');
    assert.match(page, /This sends <strong>1<\/strong>/, 'the banner counts what can actually be sent');
    assert.match(page, /1 client is\s+left out for want of an email address/, 'and counts what cannot');
    assert.match(page, /Send 1\s+reminder/, 'the button says how many');
    assert.match(page, /never in touch/, 'and the list says nobody has been contacted yet');
    assert.match(page, /127\.0\.0\.1:\d+ \(the test relay\)/, 'the relay is named, so the practice knows what will send');
  }, { mailer: mailerFor(relay) });
});

test('the run sends one message per client, each with its own working link', async (t) => {
  const relay = await startRelay(t);
  await withServer(async ({ base, db, agent }) => {
    const client = agent();
    const ids = await practiceOwingTwice(client);

    const report = await (await client.post('/chase', {})).text();

    assert.equal(relay.seen.messages.length, 1, 'one message, for the one client that can be reached');
    assert.match(report, /1 sent, 0 failed, 0 not attempted, 1 with no email address/);
    assert.match(report, /no email address on this client/, 'and the report keeps saying who was left out');

    const body = plainBody(relay.seen.messages[0]);
    assert.match(body, /Northwind Ltd/, 'the message is the ordinary reminder for that client');
    assert.match(body, /Bank statements/);
    assert.match(body, /Photo ID/);

    const link = /(http:\/\/\S+\/r\/[A-Za-z0-9_-]{20,})/.exec(body)?.[1];
    assert.ok(link, 'the message carries a link, because a reminder without one is a message they cannot act on');

    // The link works, and it is this client's page — not somebody else's.
    const opened = await fetch(link);
    assert.equal(opened.status, 200, 'the link in the message opens');
    const page = await opened.text();
    assert.match(page, /Northwind Ltd/);
    assert.ok(!/Silent Ltd/.test(page), 'and it is that client\'s page and no other');

    const event = db.prepare("SELECT detail FROM event WHERE request_id = ? AND kind = 'reminder.sent'").get(ids.owesWithAddress);
    assert.ok(event, 'the send is recorded against the request it belongs to');
    assert.match(event.detail, /accounts@northwind\.example/);
  }, { mailer: mailerFor(relay) });
});

test('one dead mailbox does not stop the run, and the report says which failed', async (t) => {
  const relay = await startRelay(t, {
    recipientReply: (address) => (address === 'dead@nowhere.example' ? '550 5.1.1 no such user' : '250 ok'),
  });

  await withServer(async ({ db, agent }) => {
    const client = agent();
    const ids = await practiceOwingTwice(client);

    // A second client who can be reached, so there is a success either side of the failure.
    const second = await client.post('/requests', {
      client: 'Reachable Ltd',
      client_email: 'alive@somewhere.example',
      title: '2025 return',
      items: 'Photo ID',
      due: '',
    });
    assert.equal(second.status, 303);
    const reachableId = second.headers.get('location').split('/').pop();

    const report = await (await client.post('/chase', {})).text();

    assert.equal(relay.seen.messages.length, 2, 'the failure did not stop the other client being written to');
    assert.match(report, /2 sent, 0 failed/, 'from the report\'s point of view both succeeded');

    // Now make the first client's mailbox the dead one and run again.
    db.prepare('UPDATE client SET email = ? WHERE id = (SELECT client_id FROM request WHERE id = ?)')
      .run('dead@nowhere.example', reachableId);
    db.prepare('UPDATE client SET email = ? WHERE id = (SELECT client_id FROM request WHERE id = ?)')
      .run('alive@somewhere.example', ids.owesWithAddress);

    const again = await (await client.post('/chase', {})).text();
    assert.match(again, /1 sent, 1 failed/, 'one success and one refusal are both counted');
    assert.match(again, /not sent/, 'the failure is named on the page');
    assert.match(again, /550 5\.1\.1/, "with the server's own words, so the practice knows what to fix");
    assert.match(again, /message was/, 'and a failure is not buried in a total');

    const failed = db.prepare("SELECT detail FROM event WHERE request_id = ? AND kind = 'reminder.failed'").get(reachableId);
    assert.ok(failed, 'the failure is recorded against the request it belongs to');
    assert.match(failed.detail, /550/);
  }, { mailer: mailerFor(relay) });
});
test('a run that takes too long stops and says where it got to', async (t) => {
  // Each send takes 600ms and the budget is 200ms, so exactly one message goes out and the second is left
  // alone. The margin between those two numbers is the point: an earlier version of this test used 250ms
  // against 300ms and passed on one Node version while failing on another, because the first send took
  // slightly longer than the budget on a slower machine. A timing test needs a gap nothing can eat.
  const relay = await startRelay(t, { delayMs: 600 });

  await withServer(async ({ agent }) => {
    const client = agent();
    await practiceOwingTwice(client);
    await client.post('/requests', {
      client: 'Reachable Ltd',
      client_email: 'alive@somewhere.example',
      title: '2025 return',
      items: 'Photo ID',
      due: '',
    });

    const report = await (await client.post('/chase', {})).text();

    assert.equal(relay.seen.messages.length, 1, 'the run stopped rather than working through the list');
    assert.match(report, /1 sent, 0 failed, 1 not attempted/);
    assert.match(report, /The run stopped before it finished/, 'and the page says so, rather than looking complete');
    assert.match(report, /not attempted — the run was out of time/);
    assert.match(report, /still on\s+<a href="\/chase">the chase list<\/a>/, 'the rest are pointed at, not dropped');
  }, { mailer: mailerFor(relay), chaseBudgetMs: 200 });
});

test('with no mail server configured, the page says so and the button does nothing', async (t) => {
  await withServer(async ({ db, agent }) => {
    const client = agent();
    await practiceOwingTwice(client);

    const page = await (await client.get('/chase')).text();
    assert.match(page, /Tickmark has no mail server configured, so nothing can be sent/);
    assert.match(page, /<button type="submit" disabled>Send \(no mail server\)<\/button>/, 'the control is visibly not usable');

    const pressed = await client.post('/chase', {});
    assert.equal(pressed.status, 400, 'and pressing it anyway is refused rather than silently doing nothing');
    assert.match(await pressed.text(), /no mail server configured/);

    const events = db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind LIKE 'reminder.%'").get().n;
    assert.equal(events, 0, 'nothing was recorded as sent or failed, because nothing was attempted');
  });
});

test('the board links to the chase list, and back', async (t) => {
  await withServer(async ({ agent }) => {
    const client = agent();
    const empty = await (await client.get('/requests')).text();
    assert.ok(!/chase everyone outstanding/.test(empty), 'an empty board does not offer the button');

    await practiceOwingTwice(client);

    const full = await (await client.get('/requests')).text();
    assert.match(full, /<a href="\/chase">chase everyone outstanding<\/a>/);

    const page = await (await client.get('/chase')).text();
    assert.match(page, /<a href="\/requests">Back to the board<\/a>/, 'and back the other way');
  });
});

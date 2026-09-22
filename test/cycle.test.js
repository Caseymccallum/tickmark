/**
 * The year coming round.
 *
 * The research calls the annual repeat the biggest cost in a practice's year, and "recurrence" is the one
 * capability on its list this product still does not have. This is the half of it a scheduler would have been
 * standing in for: the practice being *told who is due*, read out of data the product already holds. Nothing
 * here sends anything.
 *
 * The anniversary is the whole rule, so these tests move the *data* rather than the clock — a request's
 * `created_at` is backdated into a month of the test's choosing, which is exactly what the rule reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clientsDueForAsking, closeRequest, createClient } from '../src/store.js';
import { signUp, withServer } from './helpers.js';

/** This month, and the one before it — the rule is "this month", whenever the suite runs. */
const thisMonth = () => new Date().toISOString().slice(0, 7);
const previousMonth = () => {
  const [year, month] = thisMonth().split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};

/**
 * A signed-in practice with clients whose last ask was whenever the test says.
 *
 * The clients are made through the real form — a request each — and then backdated, because the rule reads
 * `request.created_at`, and a fixture that wrote rows directly would prove less than the flow does.
 */
async function withHistory(run, spec = []) {
  return withServer(async ({ agent, db }) => {
    const client = agent();
    assert.equal((await signUp(client, 'sam@practice.example')).status, 303, 'the fixture signs up');

    const { generatePracticeKey } = await import('../web/tickmark-crypto.js');
    const { publicKey, wrappedPrivateKey } = await generatePracticeKey('a passphrase long enough');
    await client.post('/setup', { public_key: JSON.stringify(publicKey), wrapped_private_key: wrappedPrivateKey });

    const practiceId = db.prepare('SELECT id FROM practice').get().id;
    const createdBy = db.prepare('SELECT id FROM practitioner').get().id;

    // A saved list, because /ask-everyone has nothing to send without one — the page offers to make a template
    // rather than a form, which is exactly what it should do and is not what the seasonal flow is about.
    const list = await client.post('/templates', { name: 'Annual accounts', items: 'Accounts\nBank statements' });
    assert.equal(list.status, 303, 'the fixture saves a list to ask with');

    for (const [name, when, options = {}] of spec) {
      createClient(db, {
        practiceId,
        createdBy,
        name,
        email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.test`,
      });
      const made = await client.post('/requests', { client: name, title: 'annual accounts', items: 'Accounts' });
      const requestId = made.headers.get('location').split('/').pop();
      db.prepare('UPDATE request SET created_at = ? WHERE id = ?').run(when, requestId);
      if (options.open === false) closeRequest(db, practiceId, requestId, when);
    }

    await run({ client, db, practiceId });
  });
}

test('a client is due when their last ask was this month of an earlier year and nothing is open', async () => {
  const month = thisMonth();
  const year = Number(month.slice(0, 4));
  const day = month.slice(5);

  await withHistory(async ({ db, practiceId }) => {
    const due = clientsDueForAsking(db, practiceId).map((row) => row.name);
    assert.deepEqual(due, ['Also Due Ltd', 'Due Ltd'], 'the two asked in this month of an earlier year, and nobody else');
    assert.ok(!due.includes('Asked Last Month Ltd'), 'a different month is a different anniversary');
    assert.ok(!due.includes('Asked This Year Ltd'), 'and this year is not an earlier year');
    assert.ok(!due.includes('Still Open Ltd'), 'being asked already answers whether to ask again');
  }, [
    ['Due Ltd', `${year - 1}-${day}-05T09:00:00.000Z`, { open: false }],
    ['Also Due Ltd', `${year - 2}-${day}-20T09:00:00.000Z`, { open: false }],
    ['Asked Last Month Ltd', `${year - 1}-${previousMonth().slice(5)}-10T09:00:00.000Z`, { open: false }],
    ['Asked This Year Ltd', `${year}-${day}-02T09:00:00.000Z`, { open: false }],
    ['Still Open Ltd', `${year - 1}-${day}-11T09:00:00.000Z`],
  ]);
});

test('asking a client takes them off the list, which is what makes it a to-do list', async () => {
  const month = thisMonth();
  const year = Number(month.slice(0, 4));
  const day = month.slice(5);

  await withHistory(async ({ client, db, practiceId }) => {
    assert.deepEqual(clientsDueForAsking(db, practiceId).map((row) => row.name), ['Due Ltd'], 'due to start with');

    // The practice asks them again — the ordinary new-request form, with no special path for a repeat client.
    const again = await client.post('/requests', { client: 'Due Ltd', title: 'annual accounts 2', items: 'Accounts' });
    assert.equal(again.status, 303, 'the second ask is accepted');
    assert.equal(
      clientsDueForAsking(db, practiceId).length,
      0,
      'and the list is empty afterwards, because an open request is the answer to "should they be asked"',
    );
  }, [['Due Ltd', `${year - 1}-${day}-05T09:00:00.000Z`, { open: false }]]);
});

test('the board tells the practice the year has come round, because that is the page they open', async () => {
  const month = thisMonth();
  const year = Number(month.slice(0, 4));
  const day = month.slice(5);

  await withHistory(async ({ client }) => {
    // The gap this closes: `clientsDueForAsking` was accurate and lived only on the clients page, so a practice
    // who works from the board every morning would never be told. No scheduler, no email — the software notices
    // when it is used, on the screen the practice actually starts from.
    const board = await (await client.get('/requests')).text();
    assert.match(board, /due to be asked/, 'the board says so');
    assert.match(board, /1\s+client is/, 'and counts exactly one, in the singular');
    assert.match(board, /href="\/ask-everyone\?due=1"/, 'linking straight to the ask, already ticked');
    assert.match(board, /nothing is sent until you press it/, 'and saying plainly that nothing sends itself');

    // Shown on the home state only. A notice that follows somebody into a filtered list stops being a notice.
    //
    // Each of these negative assertions is paired with a positive one, and that is not decoration: an assertion
    // that a page *does not* contain something passes on a 500 as happily as on a correct page. The first
    // version of this test did exactly that — the filtered board was throwing, and "not while a filter is on"
    // was green because the error page has no season notice on it either.
    const filtered = await client.get('/requests?state=waiting');
    assert.equal(filtered.status, 200, 'the filtered board renders at all');
    const filteredPage = await filtered.text();
    assert.match(filteredPage, /Nothing is in that state|waiting on clients/, 'and is the board, not an error');
    assert.ok(!/due to be asked/.test(filteredPage), 'not while a filter is on');

    const searched = await client.get('/requests?q=northwind');
    assert.equal(searched.status, 200, 'the searched board renders at all');
    const searchedPage = await searched.text();
    assert.match(searchedPage, /1 request|Nothing matches/, 'and is the board, not an error');
    assert.ok(!/due to be asked/.test(searchedPage), 'and not while searching');

    const closed = await client.get('/requests?closed=1');
    assert.equal(closed.status, 200, 'the closed tab renders at all');
    const closedPage = await closed.text();
    assert.match(closedPage, /Closed is a status, not a deletion/, 'and is the closed board, not an error');
    assert.ok(!/due to be asked/.test(closedPage), 'and never on the closed tab, which is about the past');
  }, [['Due Ltd', `${year - 1}-${day}-05T09:00:00.000Z`, { open: false }]]);
});

test('the board says nothing when nobody is due', async () => {
  // Silence is the correct state for most of the year, and a notice that appeared anyway would be the noise
  // this product's chase rules exist to avoid.
  const month = thisMonth();
  const year = Number(month.slice(0, 4));

  await withHistory(async ({ client }) => {
    // The empty case has its own name because it is the one that broke first: an empty array is *truthy*, so
    // the first version of this notice rendered as "0 clients are due to be asked" on every board all year.
    // A notice that is wrong most of the time is worse than no notice, which is the whole reason this test is
    // separate from the one above.
    const board = await (await client.get('/requests')).text();
    assert.ok(!/due to be asked/.test(board), 'nothing to say, so nothing is said');
  }, [['Not Yet Ltd', `${year - 1}-${previousMonth().slice(5)}-05T09:00:00.000Z`, { open: false }]]);
});

test('the clients page counts who is due, filters to them, and says the rule out loud', async () => {
  const month = thisMonth();
  const year = Number(month.slice(0, 4));
  const day = month.slice(5);

  await withHistory(async ({ client, db }) => {
    const page = await (await client.get('/clients')).text();
    assert.match(page, /due to be asked/, 'the tile names the work');
    assert.match(page, /href="\/clients\?due=1"/, 'and links to the list of them');

    const filtered = await (await client.get('/clients?due=1')).text();
    assert.match(filtered, /The year coming round/, 'the filtered page explains the rule');
    assert.match(filtered, /Due Ltd/, 'and lists the client');
    assert.ok(!/Not Yet Ltd/.test(filtered), 'and only the ones who are due');
    assert.match(filtered, /last asked \d{4}-\d{2}-\d{2}/, 'naming the date of that ask');
    assert.match(filtered, /Ask them all again/, 'with the seasonal action right there');

    // The action carries them into the bulk ask, ticked.
    const idOf = (name) => db.prepare('SELECT id FROM client WHERE name = ?').get(name).id;
    const bulk = await (await client.get('/ask-everyone?due=1')).text();
    assert.match(bulk, /ticked because the year has come round/, 'the bulk page says why they are ticked');
    assert.match(bulk, new RegExp(`value="${idOf('Due Ltd')}" checked`), 'and the due client is ticked');
    assert.ok(
      !new RegExp(`value="${idOf('Not Yet Ltd')}" checked`).test(bulk),
      'while a client who is not due is not',
    );

    // Without the flag nobody is ticked, so the seasonal shortcut cannot leak into the ordinary one.
    const plain = await (await client.get('/ask-everyone')).text();
    assert.ok(!/value="[0-9a-f-]{36}" checked/.test(plain), 'the ordinary bulk page ticks nobody');
  }, [
    ['Due Ltd', `${year - 1}-${day}-05T09:00:00.000Z`, { open: false }],
    ['Not Yet Ltd', `${year - 1}-${previousMonth().slice(5)}-05T09:00:00.000Z`, { open: false }],
  ]);
});

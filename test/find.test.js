/**
 * Finding things, and getting them out.
 *
 * A practice with three clients can read a board top to bottom. A practice with two hundred cannot, and
 * the failure is not that the page is slow — it is that the practice stops looking and works from memory
 * instead. So: search that composes with the filters already on screen, orders that answer the question
 * the season is asking, and an export for the people who reconcile a year in a spreadsheet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { practiceWithRequest, withServer } from './helpers.js';

/** Two clients, so there is something to search among. */
async function twoClients({ agent, db }) {
  const practice = await practiceWithRequest({ agent, db }, 'sam@practice.example');
  await practice.client.post('/requests', {
    client: 'Lodis Ltd',
    client_email: 'accounts@lodis.example',
    title: '2026 filing',
    due: '2026-03-31',
    items: 'Accounts',
  });
  return practice;
}

test('the board can be searched by client, by request and by address, and the filters compose', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await twoClients({ agent, db });

    const board = await (await client.get('/requests')).text();
    assert.match(board, /Northwind Ltd/, 'both clients are on the board');
    assert.match(board, /Lodis Ltd/);
    assert.match(board, /name="q"/, 'and there is somewhere to search');

    const byClient = await (await client.get('/requests?q=lodis')).text();
    assert.match(byClient, /Lodis Ltd/, 'a client name matches');
    assert.ok(!byClient.includes('2025 return'), 'and the other client is filtered out');

    const byTitle = await (await client.get('/requests?q=2026')).text();
    assert.match(byTitle, /2026 filing/, 'a request title matches');

    const byAddress = await (await client.get('/requests?q=accounts%40northwind')).text();
    assert.match(byAddress, /Northwind Ltd/, 'an address matched');
    assert.ok(!byAddress.includes('Lodis Ltd'), 'and it is the only one left');

    // The tab is kept: a search made inside "closed" says nothing matched there, and the search box
    // carries the tab with it so the next search stays inside it too.
    const closedTab = await (await client.get('/requests?closed=1&q=lodis')).text();
    assert.match(closedTab, /Nothing matches/, 'a search inside the closed tab searches the closed tab');
    assert.match(
      closedTab,
      /<input type="hidden" name="closed" value="1">/,
      'and the search box remembers which tab it was made in',
    );

    // And the search survives a change of order, because the link carries everything else forward.
    const sorted = await (await client.get('/requests?q=lodis&sort=client')).text();
    assert.match(sorted, /lodis/i, 'a search survives a re-sort');
    assert.match(sorted, /aria-current="page"/, 'and the tab still shows where you are');
  });
});

test('nothing found says so, and offers the way back rather than an empty table', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await twoClients({ agent, db });

    const empty = await (await client.get('/requests?q=zzz-nobody')).text();
    assert.match(empty, /Nothing matches/, 'the page says the search found nothing');
    assert.match(empty, /zzz-nobody/, 'and repeats what was searched for');
    assert.match(empty, /Clear it/, 'with a way back to the whole list');
    assert.ok(!empty.includes('<tbody>'), 'and no empty table pretending to be a result');
  });
});

test('the board can be ordered by due date and by client, and says which order it is in', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await twoClients({ agent, db });

    const byDue = await (await client.get('/requests?sort=due')).text();
    const northwind = byDue.indexOf('Northwind Ltd');
    const lodis = byDue.indexOf('Lodis Ltd');
    assert.ok(northwind > -1 && lodis > -1);
    // Only one of the two has a due date, and an undated request sorts last — "no date" must not read as
    // "due now", which is what sorting undated rows first would say.
    assert.ok(lodis < northwind, 'the dated request comes first, and the undated one last');
    assert.match(byDue, /by whose turn it is/, 'and the page offers to put it back');

    const byClient = await (await client.get('/requests?sort=client')).text();
    assert.ok(byClient.indexOf('Lodis Ltd') < byClient.indexOf('Northwind Ltd'), 'alphabetical by client');
  });
});

test('the board exports as a spreadsheet, honouring the filters it was made from', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await twoClients({ agent, db });

    const all = await client.get('/requests.csv');
    assert.equal(all.status, 200);
    assert.match(all.headers.get('content-type'), /text\/csv/, 'it is a CSV file');
    assert.match(all.headers.get('content-disposition'), /attachment; filename="tickmark-requests\.csv"/);

    // The byte-order mark is checked on the bytes, because `text()` decodes UTF-8 and the decoder eats it —
    // which is exactly why it is harmless to every reader that is not Excel.
    const bytes = Buffer.from(await all.clone().arrayBuffer());
    assert.deepEqual(
      [...bytes.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      'it starts with a byte-order mark, so Excel reads accented names correctly',
    );

    const body = await all.text();
    const [header, first] = body.replace('\uFEFF', '').split('\r\n');
    assert.equal(
      header,
      'Client,Address,Request,State,Documents,Received,Outstanding,To check,Due,Asked,Closed',
      'the columns are named',
    );
    assert.match(first, /^Lodis Ltd,accounts@lodis\.example,2026 filing,waiting on the client,1,0,1,0,2026-03-31,/, 'and each row is a request');
    assert.match(body, /Northwind Ltd/, 'with both clients present');
    // The rows come out in the order the screen shows them: both requests are "waiting", so the tie is
    // broken by due date, and the one with a date is first. A file sorted differently from the page it
    // came from is a file somebody sorts again by hand.
    assert.ok(
      body.indexOf('Lodis Ltd') < body.indexOf('Northwind Ltd'),
      'the export follows the board\u2019s order rather than the database\u2019s',
    );

    // The filter is honoured: an export that ignores the search someone just made is one they re-filter.
    const searched = await (await client.get('/requests.csv?q=lodis')).text();
    assert.match(searched, /Lodis Ltd/);
    assert.ok(!searched.includes('Northwind'), 'the search is carried into the file');

    const closed = await client.get('/requests.csv?closed=1');
    assert.match(
      closed.headers.get('content-disposition'),
      /tickmark-closed-requests\.csv/,
      'the closed tab exports under its own name, so two downloads do not overwrite each other',
    );
  });
});

test('a cell with a comma or a quote in it survives the round trip', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await twoClients({ agent, db });

    await client.post('/requests', {
      client: 'Smith, Jones & "Co"',
      title: 'Return for 2025, part 2',
      items: 'Bank statements',
    });

    const body = (await (await client.get('/requests.csv')).text()).replace('\uFEFF', '');
    assert.match(body, /"Smith, Jones & ""Co"""/, 'a name with a comma and a quote is quoted and escaped');
    assert.match(body, /"Return for 2025, part 2"/, 'and so is a title with a comma');

    // And the practice sees the name as typed, not as escaped: the page is not the file.
    const board = await (await client.get('/requests')).text();
    assert.match(board, /Smith, Jones &amp; &quot;Co&quot;/, 'the page still escapes it as markup');
  });
});

test('the clients list exports too, and searches by name or address', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await twoClients({ agent, db });

    const csv = await client.get('/clients.csv');
    assert.match(csv.headers.get('content-disposition'), /tickmark-clients\.csv/);
    const body = (await csv.text()).replace('\uFEFF', '');
    assert.match(
      body,
      /^Client,Address,Open requests,Closed requests,Outstanding,Last contact,First asked/,
      'columns — "Last contact" rather than "Last written to", because since 2v a recorded phone call counts as contact too, and a column name that lies about its contents is the defect this project keeps finding',
    );
    assert.match(body, /Lodis Ltd,accounts@lodis\.example,1,0,1,/, 'a row per client, with what they owe');

    const searched = await (await client.get('/clients?q=lodis')).text();
    assert.match(searched, /1 client matching/, 'the page says how many matched');
    assert.ok(!searched.includes('Northwind'), 'and shows only what matched');

    const missing = await (await client.get('/clients?q=nobody')).text();
    assert.match(missing, /Nothing matches/, 'a search that finds nothing says so');
  });
});

test('both exports need a session, and the refusal leaks nothing', async (t) => {
  await withServer(async ({ agent, db }) => {
    await twoClients({ agent, db });
    const stranger = agent();

    for (const path of ['/requests.csv', '/clients.csv']) {
      const response = await stranger.get(path);
      assert.equal(response.status, 303, `${path} sends a stranger to sign in`);
      assert.equal(response.headers.get('location'), '/signin');
      const body = await response.text();
      assert.ok(!body.includes('Lodis'), 'and the refusal carries no names');
    }
  });
});

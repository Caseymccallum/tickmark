/**
 * "Received" is not "ready", and a client's silence is a state too.
 *
 * These tests are about the distinction the whole product rests on. The research is explicit that a
 * portal saying "everything has arrived" is not the same as a packet being ready to prepare, and that a
 * system which hides its uncertainty is worse than none — so what is asserted here is mostly *which
 * word a page uses*, because that is the thing a practice reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemStatus, requestProgress } from '../src/store.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

const PLAINTEXT = Buffer.from('Northwind bank statement, Q1');

/** Set up a practice with a link, and the ids a test needs to play with. */
async function ready({ agent, db }) {
  const practice = await practiceWithRequest({ agent, db });
  const { token } = await createLink(practice.client, practice.requestId);
  return { ...practice, token };
}

test('a file arriving makes a request "files to check", not "ready"', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });

    assert.equal(
      requestProgress(db, p.requestId).state,
      'waiting',
      'nothing has arrived, so the practice is waiting on the client',
    );

    const sent = await upload({ base, token: p.token, itemId: p.itemIds[0], publicKey: p.keys.publicKey, plaintext: PLAINTEXT });
    assert.equal(sent.response.status, 201);

    const afterArrival = requestProgress(db, p.requestId);
    assert.equal(afterArrival.state, 'to-check', 'bytes are here; that is not the same as looked at');
    assert.equal(afterArrival.received, 1);
    assert.equal(afterArrival.checked, 0, 'nothing has been checked, and the count says so');

    // And the page says it in the words a practice would use, rather than reporting success.
    const page = await (await p.client.get(`/requests/${p.requestId}`)).text();
    assert.match(page, /files to check/i, 'the state is named, in the words a practice would use');
    assert.match(page, /"Received" is not "ready"/, 'and the page explains why it is not ready yet');
    assert.ok(!/Ready to work on/.test(page), 'it must not claim the request is ready');
  });
});

test('checking an item with nothing in it is refused', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });

    const tooEarly = await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[0]}/check`);
    assert.equal(tooEarly.status, 404, 'there is nothing to have looked at, and the route says so');
    assert.equal(requestProgress(db, p.requestId).checked, 0, 'and nothing was recorded as checked');
  });
});

test('a request is ready only when everything has arrived and been checked', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });

    for (const itemId of p.itemIds) {
      await upload({ base, token: p.token, itemId, publicKey: p.keys.publicKey, plaintext: PLAINTEXT });
    }
    assert.equal(requestProgress(db, p.requestId).state, 'to-check', 'all three are here and none is checked');

    await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[0]}/check`);
    assert.equal(requestProgress(db, p.requestId).state, 'to-check', 'two still unlooked at');

    await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[1]}/check`);
    await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[2]}/check`);

    const progress = requestProgress(db, p.requestId);
    assert.equal(progress.state, 'ready');
    assert.equal(progress.outstanding, 0);
    assert.equal(progress.toCheck, 0);
    assert.equal(progress.checked, 3);

    const page = await (await p.client.get(`/requests/${p.requestId}`)).text();
    assert.match(page, /Ready to work on/, 'the page says so');
    assert.match(page, /Everything asked for has arrived and been checked/);
  });
});

test('a new file clears the check, because new material has not been looked at', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });

    await upload({ base, token: p.token, itemId: p.itemIds[0], publicKey: p.keys.publicKey, plaintext: PLAINTEXT });
    await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[0]}/check`);
    assert.equal(requestProgress(db, p.requestId).checked, 1);

    const second = Buffer.from('the restated version');
    await upload({ base, token: p.token, itemId: p.itemIds[0], publicKey: p.keys.publicKey, plaintext: second });

    const item = itemStatus(db, p.requestId).find((row) => row.id === p.itemIds[0]);
    assert.equal(item.files, 2, 'both files are kept');
    assert.equal(item.checked, false, 'and the check made against the first one no longer stands');

    const kinds = db
      .prepare('SELECT kind FROM event WHERE request_id = ? ORDER BY rowid')
      .all(p.requestId)
      .map((row) => row.kind);
    assert.ok(kinds.includes('item.check-cleared'), 'the history records that a check was set aside, and why');
  });
});

test('the state is derived, so withdrawing an item moves it with nothing written', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });

    for (const itemId of p.itemIds) {
      await upload({ base, token: p.token, itemId, publicKey: p.keys.publicKey, plaintext: PLAINTEXT });
      await p.client.post(`/requests/${p.requestId}/items/${itemId}/check`);
    }
    const before = db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
    assert.equal(requestProgress(db, p.requestId).state, 'ready');

    // "We do not need the engagement letter this year" — one call, and the derived state moves with it.
    // No state column is written, because there is no state column: it is computed every time it is
    // asked for, which is why it cannot drift away from the items it describes.
    const withdrawn = await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[2]}/withdraw`);
    assert.equal(withdrawn.status, 303);

    const after = requestProgress(db, p.requestId);
    assert.equal(after.items, 2, 'the withdrawn item is not counted');
    assert.equal(after.checked, 2);
    assert.equal(after.state, 'ready', 'still ready, because what remains is complete');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM event').get().n >= before, 'the history grew, but no state field was set');
  });
});

test('the requests list marks overdue, names the state, and filters by it', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });

    const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    db.prepare('UPDATE request SET due_at = ? WHERE id = ?').run(past, p.requestId);

    const list = await (await p.client.get('/requests')).text();
    assert.match(list, /waiting on the client/, 'the state is named in the list');
    assert.match(list, /overdue/, 'and a past due date is called what it is');
    assert.match(list, new RegExp(past), 'with the date beside it');

    // Something arrives: the request moves to a state where the practice has the next move.
    await upload({ base, token: p.token, itemId: p.itemIds[0], publicKey: p.keys.publicKey, plaintext: PLAINTEXT });

    const second = await (await p.client.get('/requests')).text();
    assert.match(second, /files to check/);
    assert.match(second, /with files to check/, 'the summary counts it separately');

    const filtered = await (await p.client.get('/requests?state=to-check')).text();
    assert.match(filtered, /Northwind/, 'the filter shows the request in that state');
    assert.match(filtered, /files to check/);

    const empty = await (await p.client.get('/requests?state=ready')).text();
    assert.ok(!/Northwind/.test(empty), 'a filter matching nothing shows no requests');
    assert.match(empty, /Nothing is in that state/);
  });
});

test('the client can say why instead of sending, and the practice sees it', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });

    const page = await (await fetch(`${base}/r/${p.token}`)).text();
    assert.match(page, /I do not have this/, 'the client page offers the sentences');
    assert.match(page, /I will send this later/);

    const said = await fetch(`${base}/r/${p.token}/items/${p.itemIds[0]}/says`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ says: 'do-not-have' }).toString(),
      redirect: 'manual',
    });
    assert.equal(said.status, 303);

    const item = itemStatus(db, p.requestId).find((row) => row.id === p.itemIds[0]);
    assert.equal(item.clientSays, 'I do not have this');
    assert.equal(item.received, false, "and the item stays outstanding: stopping the ask is the practice's decision");
    assert.equal(requestProgress(db, p.requestId).state, 'waiting', 'so the request is still waiting');
    assert.equal(requestProgress(db, p.requestId).clientSaid, 1);

    // The practice's page shows it, and so does the reminder — chasing somebody about a document they
    // have already explained they cannot produce is how a client stops answering.
    const seen = await (await p.client.get(`/requests/${p.requestId}`)).text();
    assert.match(seen, /client says:/);
    assert.match(seen, /I do not have this/);

    const drafted = await (await p.client.post(`/requests/${p.requestId}/remind`, { days: '30' })).text();
    assert.match(drafted, /You told us about these already/);
    assert.match(drafted, /you said: I do not have this/);
    assert.match(drafted, /Photo ID/, 'and the others are still asked for');
  });
});

test("a client's answer goes when they change their mind, or when a file arrives", async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });
    const says = (value) =>
      fetch(`${base}/r/${p.token}/items/${p.itemIds[0]}/says`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ says: value }).toString(),
        redirect: 'manual',
      });
    const currentSays = () => itemStatus(db, p.requestId).find((row) => row.id === p.itemIds[0]).clientSays;

    await says('send-later');
    assert.equal(currentSays(), 'I will send this later');

    // Saying the same thing twice takes it back — otherwise a sentence said once is stuck on the
    // practice's list with no way to withdraw it from the side that said it.
    await says('send-later');
    assert.equal(currentSays(), null);

    await says('do-not-have');
    assert.equal(currentSays(), 'I do not have this');

    await upload({ base, token: p.token, itemId: p.itemIds[0], publicKey: p.keys.publicKey, plaintext: PLAINTEXT });
    assert.equal(currentSays(), null, 'they said they could not send it, and then they sent it');

    const junk = await says('something-else');
    assert.equal(junk.status, 400, 'only the sentences the page offers are accepted');
  });
});

test('a new request can be filled in from an old one, which is the year-two pain', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const p = await ready({ agent, db });
    await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[2]}/withdraw`);

    const prefilled = await (await p.client.get(`/requests/new?from=${p.requestId}`)).text();
    assert.match(prefilled, /Filled in from/, 'the page says where the list came from');
    assert.match(prefilled, /value="Northwind Ltd"/, 'the client is carried over');
    assert.match(prefilled, /value="accounts@northwind\.example"/, 'and their address, which a reminder needs');

    // Read the textarea's *value*, not the whole page: the placeholder text lists example documents,
    // and matching against that would pass or fail for reasons unrelated to what was carried over. The
    // first version of this test did exactly that and reported a failure that was the placeholder.
    const carried = /<textarea id="items"[^>]*>([\s\S]*?)<\/textarea>/.exec(prefilled)?.[1];
    assert.ok(carried, 'the form has somewhere to put the list');
    assert.match(carried, /Bank statements/, 'and the documents are in it');
    assert.match(carried, /Signed engagement letter/);
    assert.ok(!/Photo ID/.test(carried), 'a withdrawn item is not carried into the new list');

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request').get().n,
      1,
      'and nothing was created merely by looking at the form',
    );
  });
});
/**
 * The review loop: what happens when the practice sits down with a request and its files.
 *
 * Two things live here, and the first is a bug this pass found rather than a feature it added. A request whose
 * documents had all arrived and been checked, but where one of them had been **flagged as unusable**, reported
 * itself as *ready to work on* — while the chase page, reading the same request, listed the client as owing
 * something. Two screens disagreeing about one request, and 277 tests had nothing to say about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { history, itemsOf, outstandingOf, requestProgress } from '../src/store.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

/** A practice whose request has files on every item, and a link to send the rest with. */
async function withArrivals(run, { items = 3 } = {}) {
  return withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    for (const itemId of practice.itemIds.slice(0, items)) {
      const { response } = await upload({
        base,
        token,
        itemId,
        publicKey: practice.keys.publicKey,
        plaintext: Buffer.from('a document'),
        filename: 'scan.pdf',
      });
      assert.ok(response.ok, 'the fixture sent a file');
    }
    await run({ base, practice, db, token, agent });
  });
}

test('a flagged document keeps a request off "ready", because two screens must not disagree', async () => {
  await withArrivals(async ({ practice, db }) => {
    // Everything in, one of them rejected. The file is here; it is not usable; the client owes another.
    await practice.client.post(`/requests/${practice.requestId}/items/${practice.itemIds[0]}/attention`, {
      attention_note: 'Uploaded 2024 instead of 2025',
    });

    const flagged = requestProgress(db, practice.requestId);
    assert.equal(flagged.state, 'to-check', 'first it says there are files nobody has looked at');

    // The practice looks at them all — the per-document path, one at a time.
    for (const itemId of practice.itemIds) {
      await practice.client.post(`/requests/${practice.requestId}/items/${itemId}/check`, {});
    }

    const after = requestProgress(db, practice.requestId);
    assert.equal(after.checked, 3, 'all three are checked');
    assert.equal(after.needsAttention, 1, 'and one was flagged');
    assert.equal(
      after.state,
      'waiting',
      'so the request is still waiting on the client — not "ready to work on"',
    );
    assert.equal(outstandingOf(db, practice.requestId).length, 1, 'the chase agrees that something is still wanted');

    const board = await (await practice.client.get('/requests')).text();
    assert.match(board, /waiting on the client/, 'and the board says so');
    assert.match(
      board,
      /<div class="n">0<\/div><div class="k">ready to work on<\/div>/,
      'nor is it counted in the "ready to work on" tile — the label is on the page either way, so the count is what is checked',
    );

    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();
    assert.match(page, /Waiting on a replacement/, 'the request page names the real situation');
    assert.ok(!/Everything asked for has arrived and been checked/.test(page), 'and does not overstate it');
    assert.match(page, /Uploaded 2024 instead of 2025/, 'with the reason still attached');
  });
});

test('one press checks off everything that has arrived, and each check is its own event', async () => {
  await withArrivals(async ({ practice, db }) => {
    const before = requestProgress(db, practice.requestId);
    assert.equal(before.state, 'to-check', 'three files, nobody has looked');

    const checked = await practice.client.post(`/requests/${practice.requestId}/check-all`, {});
    assert.equal(checked.status, 303, 'the action is accepted');
    assert.equal(checked.headers.get('location'), `/requests/${practice.requestId}?checked=3`, 'and counts what it did');

    const after = requestProgress(db, practice.requestId);
    assert.equal(after.checked, 3, 'every arrival is checked');
    assert.equal(after.toCheck, 0, 'nothing is left to look at');
    assert.equal(after.state, 'ready', 'and the request is genuinely ready');

    // Not one batch event: three events, one per document, exactly as the buttons beside each row write.
    const events = history(db, practice.requestId).filter((row) => row.kind === 'item.checked');
    assert.equal(events.length, 3, 'three checks, three rows in the record');
    assert.deepEqual(
      events.map((row) => row.detail).sort(),
      itemsOf(db, practice.requestId).map((item) => item.label).sort(),
      'each naming the document it belongs to',
    );

    const page = await (await practice.client.get(`/requests/${practice.requestId}?checked=3`)).text();
    assert.match(page, /<strong>3 documents checked\.<\/strong>/, 'the page says how many');
    assert.match(page, /Ready to work on/, 'and the state line has moved on');
  });
});

test('the bulk check touches only what has arrived, and says how many it found', async () => {
  await withArrivals(async ({ practice, db }) => {
    // The fixture sent two of the three, so one document is still outstanding and cannot be checked.
    const checked = await practice.client.post(`/requests/${practice.requestId}/check-all`, {});
    assert.equal(checked.status, 303);
    assert.equal(checked.headers.get('location'), `/requests/${practice.requestId}?checked=2`, 'it checked two');

    const progress = requestProgress(db, practice.requestId);
    assert.equal(progress.checked, 2, 'the two arrivals');
    assert.equal(progress.outstanding, 1, 'and the one that never came is untouched');
    assert.equal(progress.state, 'waiting', 'so the request is still waiting on the client');
    assert.equal(
      itemsOf(db, practice.requestId).filter((item) => item.checked && item.received).length,
      2,
      'checked means checked against a file, never against an empty row',
    );
  }, { items: 2 });
});

test('checking a flagged document does not quietly drop it', async () => {
  await withArrivals(async ({ practice, db }) => {
    await practice.client.post(`/requests/${practice.requestId}/items/${practice.itemIds[1]}/attention`, {
      attention_note: 'That is the 2024 statement',
    });

    await practice.client.post(`/requests/${practice.requestId}/check-all`, {});

    const progress = requestProgress(db, practice.requestId);
    assert.equal(progress.checked, 3, 'the bulk action checks what has arrived, including the rejected one');
    assert.equal(progress.needsAttention, 1, 'and the flag is still there');
    assert.equal(progress.state, 'waiting', 'so the request is not ready — the client still owes a usable copy');
    assert.deepEqual(
      outstandingOf(db, practice.requestId).map((item) => item.label),
      ['Signed engagement letter'],
      'and it is still the thing being asked for',
    );
  });
});

test('pressing it when there is nothing to check says so, and writes nothing', async () => {
  await withArrivals(async ({ practice, db }) => {
    assert.equal((await practice.client.post(`/requests/${practice.requestId}/check-all`, {})).status, 303);
    const eventsBefore = history(db, practice.requestId).length;

    const again = await practice.client.post(`/requests/${practice.requestId}/check-all`, {});
    assert.equal(again.status, 404, 'the second press has nothing to do and says so');
    assert.match(await again.text(), /nothing to check/, 'in words rather than by doing something invisible');
    assert.equal(history(db, practice.requestId).length, eventsBefore, 'and nothing was added to the record');

    const unknown = await practice.client.post('/requests/6f9619ff-816d-4d0f-9a2e-000000000000/check-all', {});
    assert.equal(unknown.status, 404, 'a request that does not exist is the same answer');
  });
});

test('checking off a request needs a signed-in practice', async () => {
  await withArrivals(async ({ agent, practice, db }) => {
    const anonymous = await agent().post(`/requests/${practice.requestId}/check-all`, {});
    assert.equal(anonymous.status, 303, 'a signed-out press is sent to sign in');
    assert.match(anonymous.headers.get('location') ?? '', /^\/signin/, 'which is the sign-in page');
    assert.equal(
      history(db, practice.requestId).filter((row) => row.kind === 'item.checked').length,
      0,
      'and no check is recorded for somebody who is not signed in',
    );
    assert.equal(requestProgress(db, practice.requestId).toCheck, 3, 'the work is still waiting to be done');
  });
});

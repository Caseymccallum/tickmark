/**
 * Changing a request after it exists.
 *
 * The operation was missing rather than broken: a title and a due date could be set once and never touched
 * again. That is not how a practice works — deadlines move, typos happen, and a request filed against the
 * wrong client is a correction rather than a new request. The only fix used to be to close it and start
 * again, which throws away the client's link and the record of what they had already sent.
 *
 * The rule carried over from clients applies here too: a name that matches an existing client moves the
 * request to *them*, and never quietly creates a second record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { practiceWithRequest, withServer } from './helpers.js';

const eventsOf = (db, requestId) =>
  db.prepare('SELECT kind, detail FROM event WHERE request_id = ? ORDER BY at').all(requestId);

test('a request can be edited after it is made, and the record says what changed', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    const form = await (await client.get(`/requests/${requestId}/edit`)).text();
    assert.match(form, /Edit this request/, 'there is a page for it');
    assert.match(form, /value="2025 return"/, 'with the title already in it');
    assert.match(form, /id="due" name="due" type="date" value=""/, 'and the due date');

    const saved = await client.post(`/requests/${requestId}/edit`, {
      client: 'Northwind Ltd',
      title: '2025 return — amended',
      due: '2026-04-30',
      client_note: 'The deadline moved to April.',
    });
    assert.equal(saved.status, 303);
    assert.match(String(saved.headers.get('location')), /saved=/, 'and it lands back on the form having saved');

    const after = await (await client.get(`/requests/${requestId}`)).text();
    assert.match(after, /2025 return — amended/, 'the new title is on the request');
    assert.match(after, /needed by 2026-04-30/, 'and so is the new due date');
    assert.match(after, /The deadline moved to April\./, 'and the note to the client');

    const board = await (await client.get('/requests')).text();
    assert.match(board, /2025 return — amended/, 'the board shows the new title');
    assert.match(board, /2026-04-30/, 'with the new date');

    // What changed, in words. An event saying "edited" without saying what would be the least useful row
    // in the record.
    const [edited] = eventsOf(db, requestId).filter((row) => row.kind === 'request.edited');
    assert.ok(edited, 'the edit is recorded');
    assert.match(edited.detail, /title → 2025 return — amended/);
    assert.match(edited.detail, /due → 2026-04-30/);
    assert.match(edited.detail, /note to the client was rewritten/);
  });
});

test('an edit that changes nothing is not an event, because a form submitted twice is not history', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const before = eventsOf(db, requestId).length;

    const saved = await client.post(`/requests/${requestId}/edit`, {
      client: 'Northwind Ltd',
      title: '2025 return',
      due: '',
      client_note: '',
    });
    assert.equal(saved.status, 303);
    assert.match(String(saved.headers.get('location')), /saved=nothing/, 'and it says so plainly');

    assert.equal(eventsOf(db, requestId).length, before, 'nothing was written to the record');
  });
});

test('a due date can be cleared, which is how "there is no deadline" is said', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/edit`, { client: 'Northwind Ltd', title: '2025 return', due: '2026-04-30' });
    assert.equal(db.prepare('SELECT due_at FROM request WHERE id = ?').get(requestId).due_at, '2026-04-30');

    await client.post(`/requests/${requestId}/edit`, { client: 'Northwind Ltd', title: '2025 return', due: '' });
    assert.equal(db.prepare('SELECT due_at FROM request WHERE id = ?').get(requestId).due_at, null, 'the date is gone');

    const [last] = eventsOf(db, requestId).filter((row) => row.kind === 'request.edited').slice(-1);
    assert.match(last.detail, /due date removed/, 'and the record says the date was taken off rather than changed');
  });
});

test('a request filed against the wrong client can be moved, and it moves rather than copying', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const lodis = await client.post('/requests', {
      client: 'Lodis Ltd',
      client_email: 'accounts@lodis.example',
      title: '2026 filing',
      items: 'Accounts',
    });
    assert.equal(lodis.status, 303);
    const lodisId = db.prepare('SELECT id FROM client WHERE name = ?').get('Lodis Ltd').id;

    const moved = await client.post(`/requests/${requestId}/edit`, {
      client_id: lodisId,
      client: 'Lodis Ltd',
      title: '2025 return',
      due: '',
      client_note: '',
    });
    assert.equal(moved.status, 303);

    assert.equal(
      db.prepare('SELECT client_id FROM request WHERE id = ?').get(requestId).client_id,
      lodisId,
      'the request belongs to the other client now',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client').get().n, 2, 'and no client was created');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request_item WHERE request_id = ?').get(requestId).n,
      3,
      'the checklist moved with it — nothing was copied, and nothing was left behind',
    );

    const [edited] = eventsOf(db, requestId).filter((row) => row.kind === 'request.edited');
    assert.match(edited.detail, /moved to Lodis Ltd/);
  });
});

test('an edit is refused when it would leave the request without a title, or with a nonsense date', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    const noTitle = await client.post(`/requests/${requestId}/edit`, { client: 'Northwind Ltd', title: '   ', due: '' });
    assert.equal(noTitle.status, 400, 'a title is required');
    assert.match(await noTitle.text(), /A title is required/);

    const badDate = await client.post(`/requests/${requestId}/edit`, {
      client: 'Northwind Ltd',
      title: '2025 return',
      due: 'next Tuesday',
    });
    assert.equal(badDate.status, 400, 'a date a browser would not send is refused');
    assert.equal(
      db.prepare('SELECT title FROM request WHERE id = ?').get(requestId).title,
      '2025 return',
      'and nothing was changed by either refusal',
    );
  });
});

test('another practice cannot edit a request it cannot see', async (t) => {
  await withServer(async ({ agent, db }) => {
    const mine = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const theirs = await practiceWithRequest({ agent, db }, 'kim@other.example');

    const looked = await theirs.client.get(`/requests/${mine.requestId}/edit`);
    assert.equal(looked.status, 404, 'the form is not found');

    const attempted = await theirs.client.post(`/requests/${mine.requestId}/edit`, {
      client: 'Mine now',
      title: 'Mine now',
      due: '',
    });
    assert.equal(attempted.status, 404, 'and neither is the write');
    assert.equal(
      db.prepare('SELECT title FROM request WHERE id = ?').get(mine.requestId).title,
      '2025 return',
      'and nothing was changed',
    );
  });
});

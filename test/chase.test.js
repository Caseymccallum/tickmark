/**
 * The chase: drafting the message that asks for what has not arrived, and closing a request when
 * there is nothing left to ask for.
 *
 * These are the two things that decide whether the tool is used in a second season. A list that
 * cannot be chased is a list someone works from memory instead, and a list that never empties is a
 * list that stops being read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reminderDraft } from '../src/app.js';
import { createLink, practiceWithRequest, signUp, upload, withServer } from './helpers.js';

/** Draft a reminder through the page, and return the rendered page. */
const draft = (client, requestId, days = '30') => client.post(`/requests/${requestId}/remind`, { days });

test('the draft says how many are outstanding, names them, and carries a link', () => {
  const one = reminderDraft({
    clientName: 'Northwind Ltd',
    title: '2025 return',
    dueAt: null,
    outstanding: ['Photo ID'],
    link: 'https://office.example/r/tok',
  });
  assert.equal(one.subject, 'Still needed for 2025 return');
  assert.match(one.body, /^Hello Northwind Ltd,/);
  assert.match(one.body, /still waiting on one document/, 'one document is said in the singular');
  assert.match(one.body, / {2}- Photo ID/);
  assert.match(one.body, /https:\/\/office\.example\/r\/tok/, 'an absolute link, so it can be pasted into mail');
  assert.ok(!one.body.includes('needed by'), 'no due date is mentioned when there is none');
  assert.match(one.body, /does not apply to you, reply/, 'the escape hatch is there');
  assert.match(one.body, /Thanks,$/);

  const many = reminderDraft({
    clientName: 'Northwind Ltd',
    title: '2025 return',
    dueAt: '2026-01-31',
    outstanding: ['Bank statements', 'Photo ID'],
    link: 'https://office.example/r/tok',
  });
  assert.match(many.body, /still waiting on 2 documents/);
  assert.match(many.body, / {2}- Bank statements/);
  assert.match(many.body, / {2}- Photo ID/);
  assert.match(many.body, /marked as needed by 2026-01-31/);
});

test('a reminder names the outstanding items, and its link opens the client page', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    await upload({
      base,
      token: (await createLink(client, requestId)).token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('bank statements'),
    });

    const page = await draft(client, requestId);
    assert.equal(page.status, 200);
    const body = await page.text();

    assert.match(body, /A reminder for Northwind Ltd/);
    assert.match(body, /2 of 3 still outstanding/, 'two of the three have not arrived');
    assert.match(body, /Signed engagement letter/);
    assert.match(body, /Photo ID/);
    assert.ok(!body.includes('- Bank statements'), 'the one that arrived is not asked for again');
    assert.match(body, /Tickmark does not send this/, 'the page is honest that sending is manual');

    // The link in the message has to work, or the message is worse than useless.
    const inDraft = /https?:\/\/[^\s]*\/r\/([A-Za-z0-9_-]{20,})/.exec(body)?.[1];
    assert.ok(inDraft, 'the message carries an absolute link');
    assert.equal((await fetch(`${base}/r/${inDraft}`)).status, 200, 'and that link opens the client page');

    const kinds = db
      .prepare('SELECT kind FROM event WHERE request_id = ? ORDER BY at, rowid')
      .all(requestId)
      .map((row) => row.kind);
    assert.deepEqual(kinds, ['request.created', 'link.issued', 'upload.received', 'link.issued', 'reminder.drafted']);
  });
});

test('a reminder creates a fresh link, because the old one cannot be recovered', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    await draft(client, requestId);

    const rows = db.prepare('SELECT token_hash FROM access_token ORDER BY created_at').all();
    assert.equal(rows.length, 2, 'the reminder made its own link');
    assert.ok(
      !rows.map((row) => row.token_hash).includes(token),
      'and neither token is stored — only digests',
    );
  });
});

test('there is nothing to chase once everything has arrived', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    for (const itemId of itemIds) {
      await upload({ base, token, itemId, publicKey: keys.publicKey, plaintext: Buffer.from('here it is') });
    }

    const page = await draft(client, requestId);
    assert.equal(page.status, 303, 'no reminder is drafted');
    assert.equal(page.headers.get('location'), `/requests/${requestId}`);
    assert.equal(
      (await db.prepare('SELECT COUNT(*) AS n FROM access_token').get()).n,
      1,
      'and no link was made for a message that would say nothing',
    );
  });
});

test('a reminder cannot be drafted for another practice\'s request', async () => {
  await withServer(async ({ agent, db }) => {
    const { requestId } = await practiceWithRequest({ agent, db }, 'mine@practice.example');
    const theirs = agent();
    await signUp(theirs, 'theirs@practice.example');

    const page = await draft(theirs, requestId);
    assert.equal(page.status, 404);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM access_token').get()).n, 0, 'and nothing was made');
  });
});

test('closing a request takes it off the open list and puts it on the closed one', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    const closed = await client.post(`/requests/${requestId}/close`, {});
    assert.equal(closed.status, 303);
    assert.equal(closed.headers.get('location'), `/requests/${requestId}`);

    const page = await (await client.get(`/requests/${requestId}`)).text();
    assert.match(page, /<strong>Closed\.<\/strong>/);
    assert.match(page, /Reopen it/);
    assert.match(page, /request\.closed/, 'and the log records it');

    const open = await (await client.get('/requests')).text();
    assert.ok(!open.includes('2025 return'), 'it is not on the open list any more');
    assert.match(open, /closed \(1\)/, 'and the closed count is shown');

    const closedList = await (await client.get('/requests?closed=1')).text();
    assert.match(closedList, /2025 return/, 'it is on the closed list');
  });
});

test('reopening puts it back, so a mistake is not permanent', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    await client.post(`/requests/${requestId}/close`, {});
    const reopened = await client.post(`/requests/${requestId}/reopen`, {});
    assert.equal(reopened.status, 303);

    assert.match(await (await client.get('/requests')).text(), /2025 return/);
    const kinds = db
      .prepare('SELECT kind FROM event WHERE request_id = ? ORDER BY at, rowid')
      .all(requestId)
      .map((row) => row.kind);
    assert.ok(
      kinds.includes('request.closed') && kinds.includes('request.reopened'),
      'both acts are in the record, which is the point of recording them separately',
    );
  });
});

test('closing twice, and closing somebody else\'s, are both refused', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db }, 'mine@practice.example');
    assert.equal((await client.post(`/requests/${requestId}/close`, {})).status, 303);
    assert.equal(
      (await client.post(`/requests/${requestId}/close`, {})).status,
      404,
      'a request that is already closed is not an open request',
    );
    assert.match(await (await client.get(`/requests/${requestId}`)).text(), /Reopen it/, 'it is still closed');

    const theirs = agent();
    await signUp(theirs, 'theirs@practice.example');
    assert.equal((await theirs.post(`/requests/${requestId}/reopen`, {})).status, 404);
    assert.equal((await theirs.post(`/requests/${requestId}/close`, {})).status, 404);
  });
});

test('closing a request does not quietly revoke its link', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    assert.equal((await client.post(`/requests/${requestId}/close`, {})).status, 303);

    assert.equal(
      (await fetch(`${base}/r/${token}`)).status,
      200,
      'closing a file is not the same as telling a client to stop; revoking is a separate act',
    );
  });
});
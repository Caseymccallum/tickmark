/**
 * A request as a living list: adding to it, taking something off it, saying what arrived is not usable,
 * and the client saying something back.
 *
 * These exist because the plan claimed all four and the software did none of them. The claims were
 * `docs/mvp.md` items 4 and 5 — *"the client … can add a note"*, *"per item: outstanding, received,
 * needs attention"* — and an item list that could only be written once, at creation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reminderDraft } from '../src/app.js';
import { createLink, practiceWithRequest, signUp, upload, withServer } from './helpers.js';

const line = async (response) => response.text();

test('documents can be added to a request that is already out with a client', async () => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    assert.equal(
      (await practice.client.post(`/requests/${practice.requestId}/items`, {
        items: 'The 2024 statements as well\nPension statement\nbank statements',
      })).status,
      303,
    );

    const page = await line(await practice.client.get(`/requests/${practice.requestId}`));
    assert.match(page, /The 2024 statements as well/);
    assert.match(page, /Pension statement/);
    assert.match(page, /0 of 5 received/, 'the two new ones are counted, and counted as outstanding');

    const events = db
      .prepare('SELECT kind, detail FROM event WHERE request_id = ? ORDER BY at, rowid')
      .all(practice.requestId)
      .filter((row) => row.kind === 'items.added');
    assert.equal(events.length, 1, 'one event for one act, not one per document');
    assert.equal(events[0].detail, '2 items', 'and the detail says how many');
  });
});

test('an empty add is refused, and a closed request is refused with an explanation', async () => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });

    const empty = await practice.client.post(`/requests/${practice.requestId}/items`, { items: '  \n\n ' });
    assert.equal(empty.status, 400);
    assert.match(await line(empty), /nothing to add/);

    await practice.client.post(`/requests/${practice.requestId}/close`, {});
    const closed = await practice.client.post(`/requests/${practice.requestId}/items`, { items: 'One more' });
    assert.equal(closed.status, 400);
    assert.match(await line(closed), /is closed\. Reopen it/);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request_item').get().n,
      3,
      'and nothing was added to the closed request',
    );
  });
});

test('withdrawing an item stops the client being asked, and keeps the record of the asking', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    // Picked by label rather than by position, so this does not quietly start testing a different
    // document if the order of the list ever changes.
    const photoId = db
      .prepare("SELECT id FROM request_item WHERE request_id = ? AND label = 'Photo ID'")
      .get(practice.requestId).id;

    assert.equal(
      (await practice.client.post(`/requests/${practice.requestId}/items/${photoId}/withdraw`, {})).status,
      303,
    );

    const clientPage = await line(await fetch(`${base}/r/${token}`));
    assert.match(clientPage, /Bank statements/);
    assert.ok(!clientPage.includes('Photo ID'), "the withdrawn document is off the client's list");

    const practicePage = await line(await practice.client.get(`/requests/${practice.requestId}`));
    assert.match(practicePage, /Photo ID/, 'but the practice still sees it');
    assert.match(practicePage, /No longer being asked for/);
    assert.match(practicePage, /Ask for it again/);
    assert.match(practicePage, /0 of 2 received/, 'and the counts say two, not three');
    assert.match(practicePage, /item\.withdrawn/);

    assert.equal(
      (await practice.client.post(`/requests/${practice.requestId}/items/${photoId}/restore`, {})).status,
      303,
    );
    assert.match(await line(await fetch(`${base}/r/${token}`)), /Photo ID/, 'and the client is asked again');
    assert.match(await line(await practice.client.get(`/requests/${practice.requestId}`)), /item\.restored/);
  });
});

test('a file sent for a withdrawn item is refused rather than stored', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await practice.client.post(`/requests/${practice.requestId}/items/${practice.itemIds[0]}/withdraw`, {});

    const { response } = await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('a file nothing is waiting for'),
    });
    assert.equal(response.status, 409, 'a client holding an older page is told, not ignored');
    assert.match(await line(response), /no longer asking for that one/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM upload').get()).n, 0);
  });
});

test('needs attention keeps an item outstanding even though a file came in', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const statements = practice.itemIds[0];

    await upload({
      base,
      token,
      itemId: statements,
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('an unreadable scan'),
      filename: 'scan.pdf',
    });

    const flagged = await practice.client.post(`/requests/${practice.requestId}/items/${statements}/attention`, {
      attention_note: 'The scan came out blank — can you redo it?',
    });
    assert.equal(flagged.status, 303);

    const practicePage = await line(await practice.client.get(`/requests/${practice.requestId}`));
    assert.match(practicePage, /needs attention/);
    assert.match(practicePage, /The scan came out blank/, 'the practice sees why');
    assert.match(practicePage, /One document needs attention/, 'in the singular, and in a sentence');
    assert.match(practicePage, /Dealt with/, 'and there is a way to clear it');
    assert.match(practicePage, /item\.needs-attention/);

    const clientPage = await line(await fetch(`${base}/r/${token}`));
    assert.match(clientPage, /please send this again/, 'and so does the client');
    assert.match(clientPage, /The scan came out blank/);

    assert.equal(
      (await practice.client.post(`/requests/${practice.requestId}/items/${statements}/clear-attention`, {})).status,
      303,
    );
    const after = await line(await practice.client.get(`/requests/${practice.requestId}`));
    assert.ok(!after.includes('needs attention'), 'the flag is gone');
    assert.match(after, /item\.attention-cleared/);
    assert.match(after, /1 of 3 received/, 'and the item is plainly received again');
  });
});

test('a flagged item is chased again, in its own paragraph, with the reason', () => {
  const draft = reminderDraft({
    clientName: 'Northwind Ltd',
    title: '2025 return',
    dueAt: null,
    outstanding: ['Signed engagement letter'],
    again: [{ label: 'Bank statements', note: 'the scan came out blank' }],
    link: 'https://office.example/r/tok',
  });

  assert.match(draft.body, /still waiting on one document/);
  assert.match(draft.body, / {2}- Signed engagement letter/);
  assert.match(draft.body, /These need sending again:/);
  assert.match(draft.body, / {2}- Bank statements \(the scan came out blank\)/);
  assert.ok(
    draft.body.indexOf('Signed engagement letter') < draft.body.indexOf('These need sending again'),
    'what has not arrived comes first: it is the simpler sentence to read',
  );
});

test('a reminder made only of flagged items still reads properly', () => {
  const draft = reminderDraft({
    clientName: 'Northwind Ltd',
    title: '2025 return',
    dueAt: null,
    outstanding: [],
    again: [{ label: 'Photo ID', note: null }],
    link: 'https://office.example/r/tok',
  });
  assert.ok(!draft.body.includes('still waiting on'), 'no "we are waiting on nothing" paragraph');
  assert.match(draft.body, /These need sending again for 2025 return:/);
  assert.match(draft.body, / {2}- Photo ID/);
  assert.ok(!draft.body.includes('(null)'), 'and a flagged item with no reason gets no empty brackets');
});

test('the reminder through the page asks for a flagged item again', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('blank'),
      filename: 'scan.pdf',
    });
    await practice.client.post(`/requests/${practice.requestId}/items/${practice.itemIds[0]}/attention`, {
      attention_note: 'it came out blank',
    });

    const page = await line(await practice.client.post(`/requests/${practice.requestId}/remind`, { days: '30' }));
    assert.match(page, /3 of 3 still outstanding/, 'all three are on it: two missing, one unusable');
    assert.match(page, /it came out blank/, 'the draft carries the reason to the client');
  });
});

test("the client's note travels with the file and is shown to the practice", async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('a file'),
      filename: 'statements.pdf',
      note: 'Only one account — the other closed in 2024',
    });

    assert.equal(
      db.prepare('SELECT client_note FROM upload').get().client_note,
      'Only one account — the other closed in 2024',
      'the note is stored, which it never was before this',
    );
    assert.match(
      await line(await practice.client.get(`/requests/${practice.requestId}`)),
      /they said: Only one account/,
    );
    assert.match(await line(await fetch(`${base}/r/${token}`)), /name="note"/, 'and there is somewhere to type one');
  });
});

test('an unknown action on an item is refused, and another practice cannot change one', async () => {
  await withServer(async ({ agent, db }) => {
    const mine = await practiceWithRequest({ agent, db }, 'mine@practice.example');
    const itemId = mine.itemIds[0];

    const nonsense = await mine.client.post(`/requests/${mine.requestId}/items/${itemId}/archive`, {});
    assert.equal(nonsense.status, 400);
    assert.match(await line(nonsense), /not something that can be said about a document/);

    const theirs = agent();
    await signUp(theirs, 'theirs@practice.example');
    for (const action of ['withdraw', 'restore', 'attention', 'clear-attention']) {
      const response = await theirs.post(`/requests/${mine.requestId}/items/${itemId}/${action}`, {});
      assert.equal(response.status, 404, `${action} on another practice's request is not found`);
    }
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request_item WHERE withdrawn_at IS NOT NULL').get().n,
      0,
      'and nothing was changed',
    );
  });
});
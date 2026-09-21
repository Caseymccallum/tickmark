/**
 * The note to the client, and the upload ceiling they can see.
 *
 * A request can carry the practice's own words — why these documents are wanted, by when — and
 * those words are the first thing on the client's page, above the list. The client's per-file
 * upload ceiling is injected into the same page so the browser can refuse a 50 MB scan politely,
 * at the moment it is chosen, instead of at the end of a failed upload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withServer, practiceWithRequest, createLink } from './helpers.js';

const NOTE = 'Hi Sarah, here is the list for your 2026 corporate tax filing.\nPlease upload these by Friday.';

/** A second request on the same practice, with (or without) a note, made through the real form. */
async function makeRequest(client, { title, note = null }) {
  const created = await client.post('/requests', {
    client: 'Sarah Ltd',
    client_email: 'sarah@example.com',
    title,
    items: 'Accounts\nTax return',
    ...(note === null ? {} : { client_note: note }),
  });
  assert.equal(created.status, 303, 'the form accepts the note field');
  return created.headers.get('location').split('/').pop();
}

test('a note to the client is stored, shown first on their page, and escaped', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const hostile = 'Hello <script>alert(1)</script> & welcome';
    const withNote = await makeRequest(practice.client, { title: '2026 corporate tax', note: NOTE });
    const hostileId = await makeRequest(practice.client, { title: '2026 corporate tax (2)', note: hostile });

    // The client's page: the note above the list, newlines kept by the pre-wrap style.
    const { token } = await createLink(practice.client, withNote);
    const page = await (await fetch(`${base}/r/${token}`)).text();
    const noteAt = page.indexOf('Hi Sarah, here is the list for your 2026 corporate tax filing.');
    assert.ok(noteAt !== -1, 'the note is on the client page in the practice\u2019s own words');
    assert.ok(noteAt < page.indexOf('<table>'), 'and it is above the list, not buried below it');
    assert.match(page, /class="greeting"/, 'in its own box, not a paragraph lost in the page');

    // A note is the practice's words rendered as text, never as markup.
    const hostilePage = await (await fetch(`${base}/r/${(await createLink(practice.client, hostileId)).token}`)).text();
    assert.ok(!hostilePage.includes('<script>alert'), 'a note cannot inject markup');
    assert.match(hostilePage, /Hello &lt;script&gt;/, 'it is escaped, and still readable');

    // The practice sees what it wrote, on the request's own page.
    const practicePage = await (await practice.client.get(`/requests/${withNote}`)).text();
    assert.match(practicePage, /class="greeting"/);
    assert.match(practicePage, /Please upload these by Friday/);

    // And duplicating carries the note into the form, because it is usually still true next year.
    const prefilled = await (await practice.client.get(`/requests/new?from=${withNote}`)).text();
    const carried = /<textarea id="client_note"[^>]*>([\s\S]*?)<\/textarea>/.exec(prefilled)?.[1];
    assert.match(carried, /Hi Sarah, here is the list for your 2026 corporate tax filing\./);
  });
});

test('a request with no note shows no empty box', async () => {
  await withServer(async ({ agent, base, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const plain = await makeRequest(practice.client, { title: '2025 return', note: null });
    const { token } = await createLink(practice.client, plain);
    const page = await (await fetch(`${base}/r/${token}`)).text();
    assert.ok(!page.includes('class="greeting"'), 'nothing to say, nothing shown');
  });
});

test('a note longer than its cap is refused with a sentence, not truncated in silence', async () => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const refused = await practice.client.post('/requests', {
      client: 'Sarah Ltd',
      client_email: 'sarah@example.com',
      title: '2026 corporate tax',
      items: 'Accounts',
      client_note: 'x'.repeat(2001),
    });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /longer than 2000 characters/);
  });
});

test('the client page carries the practice\u2019s upload ceiling, so the browser can catch it early', async () => {
  await withServer(
    async ({ agent, base, db }) => {
      const practice = await practiceWithRequest({ agent, db });
      const { token } = await createLink(practice.client, practice.requestId);
      const page = await (await fetch(`${base}/r/${token}`)).text();
      assert.match(
        page,
        /<script type="application\/json" id="upload-limit">\{"maxBytes":1024\}<\/script>/,
        'the configured per-file limit is on the page, in the form the upload script reads',
      );
    },
    { maxUploadBytes: 1024 },
  );
});

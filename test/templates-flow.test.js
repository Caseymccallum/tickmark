/**
 * The template lifecycle: the list a practice keeps to stop retyping the same request every year.
 *
 * The audit found `templatePage` — the page a practice actually looks at — covered by nothing at all: 68 consecutive
 * uncovered lines, and the same for renaming, growing, trimming and deleting a list. That is a whole feature nobody
 * had ever driven end to end, which is exactly the kind of gap a coverage number is for.
 *
 * The assertions are about behaviour rather than plumbing: a template cannot be nameless, cannot be empty, cannot
 * keep a duplicate line, and deleting it really removes it (the one place in this product that does).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_TEMPLATE_NAME } from '../src/store.js';
import { practiceWithRequest, withServer } from './helpers.js';

/** The page as a reader sees it: tags gone, entities decoded, whitespace collapsed. */
const flat = (rendered) => rendered
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (whole, code) => String.fromCharCode(Number(code)))
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

test('a template can be made, refused, renamed, grown, trimmed and deleted', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });

    // --- refused before anything is written ---------------------------------------------------------
    assert.equal((await practice.client.post('/templates', { name: '', items: 'Photo ID' })).status, 400);
    assert.equal(
      (await practice.client.post('/templates', { name: 'x'.repeat(MAX_TEMPLATE_NAME + 1), items: 'Photo ID' })).status,
      400,
      'a name that no list could show is refused',
    );
    const empty = await practice.client.post('/templates', { name: 'Sole trader', items: '   \n  \n' });
    assert.equal(empty.status, 400);
    assert.ok(flat(await empty.text()).includes('at least one document'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template').get().n, 0, 'and nothing was stored');

    // --- made ---------------------------------------------------------------------------------------
    const created = await practice.client.post('/templates', {
      name: 'Sole trader — annual accounts',
      items: "Photo ID\nBank statements, all accounts\nLast year's return\nBank statements, all accounts",
      note: 'Please send these by the end of the month.',
    });
    assert.equal(created.status, 303);
    const id = created.headers.get('location').split('/').pop();
    assert.ok(id);

    // The duplicate line is collapsed rather than kept twice — a template with the same document on it twice
    // is a request that asks a client for the same thing twice.
    const items = db.prepare('SELECT label FROM template_item WHERE template_id = ? ORDER BY position').all(id);
    assert.deepEqual(items.map((row) => row.label), ['Photo ID', 'Bank statements, all accounts', "Last year's return"]);
    assert.equal(
      db.prepare('SELECT note FROM template WHERE id = ?').get(id).note,
      'Please send these by the end of the month.',
    );

    // --- read ---------------------------------------------------------------------------------------
    const page = await practice.client.get(`/templates/${id}`);
    assert.equal(page.status, 200);
    const rendered = flat(await page.text());
    for (const label of ['Photo ID', 'Bank statements, all accounts', "Last year's return"]) {
      assert.ok(rendered.includes(label), `${label} is on the page`);
    }
    assert.ok(rendered.includes('Sole trader'), 'under its own name');

    // --- renamed, with the same three refusals ------------------------------------------------------
    assert.equal((await practice.client.post(`/templates/${id}`, { name: '  ' })).status, 400);
    assert.equal((await practice.client.post(`/templates/${id}`, { name: 'x'.repeat(MAX_TEMPLATE_NAME + 1) })).status, 400);
    assert.equal((await practice.client.post(`/templates/${id}`, { name: 'Fine', note: 'n'.repeat(2001) })).status, 400);
    const renamed = await practice.client.post(`/templates/${id}`, { name: 'Sole trader — renamed', note: 'New note.' });
    assert.equal(renamed.status, 303);
    const row = db.prepare('SELECT name, note FROM template WHERE id = ?').get(id);
    assert.equal(row.name, 'Sole trader — renamed');
    assert.equal(row.note, 'New note.');

    // --- grown --------------------------------------------------------------------------------------
    const grown = await practice.client.post(`/templates/${id}/items`, { items: 'Signed engagement letter' });
    assert.equal(grown.status, 303);
    assert.match(grown.headers.get('location'), /\?added=1$/, 'and says how many arrived');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template_item WHERE template_id = ?').get(id).n, 4);

    // --- trimmed ------------------------------------------------------------------------------------
    const first = db.prepare('SELECT id FROM template_item WHERE template_id = ? ORDER BY position').get(id);
    const removed = await practice.client.post(`/templates/${id}/items/${first.id}/remove`, {});
    assert.equal(removed.status, 303);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template_item WHERE template_id = ?').get(id).n, 3);
    // Removing it twice is a 404 rather than a second silent success.
    assert.equal((await practice.client.post(`/templates/${id}/items/${first.id}/remove`, {})).status, 404);

    // --- and deleted, which nothing else in the product does ----------------------------------------
    const deleted = await practice.client.post(`/templates/${id}/delete`, {});
    assert.equal(deleted.status, 303);
    assert.equal(deleted.headers.get('location'), '/templates?removed=1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template WHERE id = ?').get(id).n, 0, 'the row is gone');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM template_item WHERE template_id = ?').get(id).n,
      0,
      'and so are its lines',
    );
    assert.equal((await practice.client.post(`/templates/${id}/delete`, {})).status, 404, 'deleting a gone list is a 404');
    assert.equal((await practice.client.get(`/templates/${id}`)).status, 404, 'and its page is not there either');
  });
});

test('a request on the board can be kept as a template for next year', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });

    const saved = await practice.client.post(`/requests/${practice.requestId}/save-as-template`, {
      name: 'From a request',
    });
    assert.equal(saved.status, 303);
    assert.match(saved.headers.get('location'), /\?made=1$/, 'and says it was made');

    const template = db.prepare('SELECT id, name, note FROM template ORDER BY created_at DESC LIMIT 1').get();
    assert.equal(template.name, 'From a request', 'named however the practice typed it');
    // The standing note comes from the request's own note to the client, not from this form.
    const requestNote = db.prepare('SELECT client_note FROM request WHERE id = ?').get(practice.requestId).client_note;
    assert.equal(template.note, requestNote);
    const labels = db.prepare('SELECT label FROM template_item WHERE template_id = ? ORDER BY position')
      .all(template.id).map((each) => each.label);
    assert.ok(labels.length > 0, 'the checklist came with it');
    // The request itself is untouched: saving a template is a copy, not a move.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request_item WHERE request_id = ?').get(practice.requestId).n,
      labels.length,
    );

    // And the template is usable immediately, so the next year is one action.
    assert.equal((await practice.client.get(`/templates/${template.id}`)).status, 200);

    // A request with nothing on it cannot become an empty template.
    const practiceId = db.prepare('SELECT id FROM practice').get().id;
    const practitionerId = db.prepare('SELECT id FROM practitioner WHERE practice_id = ?').get(practiceId).id;
    const clientId = db.prepare('SELECT client_id FROM request WHERE id = ?').get(practice.requestId).client_id;
    db.prepare(
      `INSERT INTO request (id, practice_id, client_id, title, practitioner_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('bare-request', practiceId, clientId, 'Nothing asked', practitionerId, new Date().toISOString());
    const refused = await practice.client.post('/requests/bare-request/save-as-template', { name: 'Empty' });
    assert.equal(refused.status, 400);
    assert.ok(flat(await refused.text()).includes('nothing on this request'));
  });
});

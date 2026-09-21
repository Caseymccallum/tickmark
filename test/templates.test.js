/**
 * Templates, and asking everyone at once.
 *
 * The research this product was built from says where a practice breaks: *manual tracking breaks down past 50
 * clients*. Built one at a time, sending the same standard request to sixty clients is an afternoon of typing,
 * and these tests are about the two things that turn it into one action — a list that is kept, and a send that
 * reaches everyone without lying about how it went.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemsOf, templatesOf, templateItemsOf } from '../src/store.js';
import { practiceWithRequest, signUp, withServer } from './helpers.js';

/** A practice signed up, keyed and ready to make a list. */
async function withPractice(run) {
  return withServer(async ({ base, agent, db }) => {
    const client = agent();
    assert.equal((await signUp(client, 'sam@practice.example')).status, 303, 'the fixture signs up');

    // A key, because sending an ask needs one — a link is issued by a practice that can receive what the client
    // sends back. The real browser flow's server half, as `test/helpers.js` does it.
    const { generatePracticeKey } = await import('../web/tickmark-crypto.js');
    const { publicKey, wrappedPrivateKey } = await generatePracticeKey('a passphrase long enough');
    const keyed = await client.post('/setup', {
      public_key: JSON.stringify(publicKey),
      wrapped_private_key: wrappedPrivateKey,
    });
    assert.equal(keyed.status, 303, 'the fixture makes a key');

    await run({ base, client, db, practiceId: db.prepare('SELECT id FROM practice').get().id });
  });
}

test('a list typed once can be used for the next client without retyping it', async (t) => {
  await withPractice(async ({ client, db }) => {
    const created = await client.post('/templates', {
      name: 'Sole trader — annual accounts',
      items: 'Photo ID\nBank statements',
      note: 'Please send these by the end of the month.',
    });
    assert.equal(created.status, 303, 'a list can be saved');
    const templateId = created.headers.get('location').split('/').pop();

    const list = await (await client.get('/templates')).text();
    assert.match(list, /Sole trader — annual accounts/, 'it is on the templates page');

    const form = await (await client.get(`/requests/new?template=${templateId}`)).text();
    assert.match(form, /Starting from/, 'and the request form says where the list came from');
    assert.match(form, /Bank statements/, 'with the documents filled in');
    assert.match(form, /Please send these by the end of the month/, 'and the standing note as the client note');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request').get().n,
      0,
      'opening the form creates nothing — it fills a form in, like every other way into a new request',
    );
  });
});

test('a template is a starting point: changing one never reaches back into requests made from it', async (t) => {
  await withPractice(async ({ client, db, practiceId }) => {
    const created = await client.post('/templates', { name: 'Standard', items: 'Photo ID\nBank statements' });
    const templateId = created.headers.get('location').split('/').pop();

    const made = await client.post('/requests', {
      client: 'Northwind Ltd',
      client_email: 'accounts@northwind.example',
      title: '2025 return',
      items: 'Photo ID\nBank statements',
    });
    const requestId = made.headers.get('location').split('/').pop();

    const added = await client.post(`/templates/${templateId}/items`, { items: 'Photo ID\nPayroll summary' });
    assert.equal(added.status, 303);

    assert.deepEqual(
      itemsOf(db, requestId).map((item) => item.label),
      ['Photo ID', 'Bank statements'],
      'the request kept the list it was made with, because it copied rather than pointed at it',
    );
    assert.deepEqual(
      templateItemsOf(db, templateId).map((item) => item.label),
      ['Photo ID', 'Bank statements', 'Payroll summary'],
      'and the template grew, with the document it already had not added twice',
    );
    assert.equal(templatesOf(db, practiceId).length, 1);
  });
});

test('a template can really be deleted, and the requests made from it cannot be', async (t) => {
  await withPractice(async ({ client, db, practiceId }) => {
    const created = await client.post('/templates', { name: 'Standard', items: 'Photo ID' });
    const templateId = created.headers.get('location').split('/').pop();

    const made = await client.post('/requests', {
      client: 'Northwind Ltd',
      client_email: 'accounts@northwind.example',
      title: '2025 return',
      items: 'Photo ID',
    });
    const requestId = made.headers.get('location').split('/').pop();

    const removed = await client.post(`/templates/${templateId}/delete`, {});
    assert.equal(removed.status, 303, 'deleting is allowed: nothing refers to a template');
    assert.equal(templatesOf(db, practiceId).length, 0, 'it is gone');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM template_item').get().n,
      0,
      'and so are its documents, rather than being left behind as orphans',
    );
    assert.equal(itemsOf(db, requestId).length, 1, 'the request it made is exactly where it was');
  });
});

test('a request can be saved as a list, which is how the first one usually appears', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });

    const saved = await client.post(`/requests/${requestId}/save-as-template`, { name: 'Standard return' });
    assert.equal(saved.status, 303);
    assert.match(saved.headers.get('location'), /^\/templates\//, 'it lands on the new template');

    const [template] = templatesOf(db, db.prepare('SELECT id FROM practice').get().id);
    assert.equal(template.name, 'Standard return', 'named what the practice typed');
    assert.equal(template.item_count, 3, 'with the request\u2019s whole checklist on it');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'request.edited'").get().n,
      0,
      'and the request itself is untouched',
    );
  });
});

test('a list with no name, or with nothing on it, is refused', async (t) => {
  await withPractice(async ({ client }) => {
    assert.equal((await client.post('/templates', { name: '', items: 'Photo ID' })).status, 400, 'a name is required');
    const blank = await client.post('/templates', { name: 'Nothing on it', items: '   \n  \n' });
    assert.equal(blank.status, 400, 'a list that asks for nothing is not a list');
  });
});

/**
 * Clients as records of their own.
 *
 * A request has always pointed at a `client` row rather than carrying a copy of a name and an address,
 * but nothing on screen said so and nothing let a practice see or fix one. These tests pin the two
 * behaviours that changed, because both were bugs rather than missing features:
 *
 * 1. An address typed on a later request used to be **thrown away** when the name matched an existing
 *    client, so a client created before anyone knew their email could never be given one — and since the
 *    chase reads the client's address, the symptom was "Tickmark will not write to them" with nothing on
 *    screen to explain it.
 * 2. A typo used to fork a client silently. Now the existing names are offered on the form, the name is
 *    fixable on the client's page, and the fix carries the whole history with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

test('an address typed later is kept, so a client is never permanently unreachable', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db }, 'sam@practice.example');

    // First request: no address known yet, which is how most relationships start. A new client, because
    // the helper's own request already carries an address.
    const first = await client.post('/requests', {
      client: 'Lodis Ltd',
      title: '2025 return',
      items: 'Bank statements',
    });
    assert.equal(first.status, 303);

    const clientRow = db.prepare('SELECT id, email FROM client WHERE name = ?').get('Lodis Ltd');
    assert.equal(clientRow.email, null, 'the client exists with no address');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client WHERE name = ?').get('Lodis Ltd').n, 1);

    // Second request, same client, and now somebody knows the address.
    const second = await client.post('/requests', {
      client: 'Lodis Ltd',
      client_email: 'accounts@lodis.example',
      title: '2026 return',
      items: 'Bank statements',
    });
    assert.equal(second.status, 303);

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM client WHERE name = ?').get('Lodis Ltd').n,
      1,
      'the matching name did not create a second client',
    );
    assert.equal(
      db.prepare('SELECT email FROM client WHERE name = ?').get('Lodis Ltd').email,
      'accounts@lodis.example',
      'and the address was written down — this is the bug: it used to be discarded',
    );

    // Which is the whole point: the chase can now reach them.
    const chase = await (await client.get('/chase')).text();
    assert.match(chase, /accounts@lodis\.example/, 'the chase has somewhere to write');
    assert.match(chase, /Lodis Ltd/, 'and the client is on it');
  });
});

test('the clients page lists a client with what they owe, and a request can be started from it', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const clientRow = db.prepare('SELECT id FROM client').get();

    const listed = await (await client.get('/clients')).text();
    assert.match(listed, /Northwind Ltd/, 'the client is on the list');
    assert.match(listed, new RegExp(`/clients/${clientRow.id}`), 'and links to their own page');
    assert.match(listed, /accounts@northwind\.example/, 'with the address the chase will use');
    assert.match(listed, /Outstanding/, 'and a column for what they still owe');

    // Their page: their details, their history, and the reuse the page exists for.
    const page = await (await client.get(`/clients/${clientRow.id}`)).text();
    assert.match(page, /2025 return/, 'their request is listed');
    assert.match(page, /Everything asked of them/);
    assert.match(page, /Bank statements/, 'the previous checklist is offered for the year-two case');
    assert.match(page, new RegExp(`/requests/new\\?for=${clientRow.id}&amp;like=last`), 'with a way to start one like it');

    // And starting one from their page carries the client: no name to retype, nothing to get wrong.
    const form = await (await client.get(`/requests/new?for=${clientRow.id}&like=last`)).text();
    assert.match(form, /id="client" name="client" required value="Northwind Ltd"/, 'the client is filled in');
    assert.match(form, new RegExp(`name="client_id" value="${clientRow.id}"`), 'and carried, not re-matched by name');
    const carried = /<textarea id="items"[^>]*>([\s\S]*?)<\/textarea>/.exec(form)?.[1];
    assert.match(carried, /Bank statements/, 'the checklist is the one from last time');
    assert.match(form, /2025 return/, 'and so is the title');
  });
});

test('a request created from a client page is filed against that client, not against a name', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const clientRow = db.prepare('SELECT id FROM client').get();

    // The name is corrected on the way through, which is what a typo noticed at the last moment looks
    // like. The request must still land on the same client — a name that no longer matches anything must
    // not fork a record.
    const created = await client.post('/requests', {
      client_id: clientRow.id,
      client: 'Northwind Limited',
      client_email: 'accounts@northwind.example',
      title: '2026 return',
      items: 'Bank statements',
    });
    assert.equal(created.status, 303);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client').get().n, 1, 'still one client');
    const after = db.prepare('SELECT name, email FROM client WHERE id = ?').get(clientRow.id);
    assert.equal(after.name, 'Northwind Limited', 'the correction was applied to the client');
    assert.equal(after.email, 'accounts@northwind.example', 'along with the address');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request WHERE client_id = ?').get(clientRow.id).n,
      2,
      'and both requests belong to them',
    );
  });
});

test('a client can be renamed, and their whole history moves with them', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const clientRow = db.prepare('SELECT id FROM client').get();
    const requestRow = db.prepare('SELECT id FROM request').get();

    const saved = await client.post(`/clients/${clientRow.id}`, {
      name: 'Northwind Trading Ltd',
      email: 'accounts@northwind.example',
    });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), `/clients/${clientRow.id}?saved=1`);

    assert.equal(
      db.prepare('SELECT id FROM request WHERE client_id = ?').get(clientRow.id).id,
      requestRow.id,
      'the request still belongs to the same client, because it points at the client rather than a name',
    );
    const board = await (await client.get('/requests')).text();
    assert.match(board, /Northwind Trading Ltd/, 'and the board shows the corrected name');
  });
});

test('two clients cannot end up with one name, and an address can be cleared on purpose', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const clientRow = db.prepare('SELECT id FROM client').get();
    const practiceId = db.prepare('SELECT id FROM practice').get().id;
    const practitionerId = db.prepare('SELECT id FROM practitioner').get().id;

    db.prepare('INSERT INTO client (id, practice_id, practitioner_id, name, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'other-client',
      practiceId,
      practitionerId,
      'Lodis Ltd',
      new Date().toISOString(),
    );

    // Merging decides which history survives, which is not a thing to do because a form was filled in
    // twice — so the name is refused and the practice chooses.
    const clash = await client.post(`/clients/${clientRow.id}`, { name: 'Lodis Ltd', email: '' });
    assert.equal(clash.status, 400);
    assert.match(await clash.text(), /already a client called Lodis Ltd/);
    assert.equal(
      db.prepare('SELECT name FROM client WHERE id = ?').get(clientRow.id).name,
      'Northwind Ltd',
      'and nothing was changed',
    );

    // An empty address on the client's own page clears it: here it is a decision.
    await client.post(`/clients/${clientRow.id}`, { name: 'Northwind Ltd', email: 'accounts@northwind.example' });
    assert.equal(
      db.prepare('SELECT email FROM client WHERE id = ?').get(clientRow.id).email,
      'accounts@northwind.example',
    );
    await client.post(`/clients/${clientRow.id}`, { name: 'Northwind Ltd', email: '' });
    assert.equal(
      db.prepare('SELECT email FROM client WHERE id = ?').get(clientRow.id).email,
      null,
      'the address is gone, on purpose',
    );

    // A blank address on a *request* form still means "not telling you", not "forget it".
    await client.post(`/clients/${clientRow.id}`, { name: 'Northwind Ltd', email: 'accounts@northwind.example' });
    await client.post('/requests', { client: 'Northwind Ltd', client_email: '', title: '2027', items: 'Photo ID' });
    assert.equal(
      db.prepare('SELECT email FROM client WHERE id = ?').get(clientRow.id).email,
      'accounts@northwind.example',
      'the address survives a request form that says nothing about it',
    );
  });
});

test('another practice has no client at that address, and no way to tell one is there', async (t) => {
  await withServer(async ({ agent, db }) => {
    const mine = agent();
    await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const mineRow = db.prepare('SELECT id FROM client').get();

    // Signed in as somebody else entirely — a second practice in the same database file.
    const theirs = (await practiceWithRequest({ agent, db }, 'kim@other.example')).client;

    const looked = await theirs.get(`/clients/${mineRow.id}`);
    assert.equal(looked.status, 404, 'a client of another practice is not found');
    assert.ok(!(await looked.text()).includes('Northwind'), 'and their name is not leaked by the refusal');

    const edited = await theirs.post(`/clients/${mineRow.id}`, { name: 'Mine now', email: '' });
    assert.equal(edited.status, 404);
    assert.equal(
      db.prepare('SELECT name FROM client WHERE id = ?').get(mineRow.id).name,
      'Northwind Ltd',
      'and nothing was changed',
    );
  });
});

test('the count on the client list is what is still wanted, not what has arrived', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const client = practice.client;
    const clientRow = db.prepare('SELECT id FROM client').get();

    const { token } = await createLink(client, practice.requestId);
    const anonymous = agent();
    const page = await (await anonymous.get(`/r/${token}`)).text();
    const itemId = new RegExp(`/r/${token}/items/([0-9a-f-]{36})`).exec(page)?.[1];
    await upload({
      base,
      token,
      itemId,
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('bank statements'),
      filename: 'statements.pdf',
    });

    // One of three has arrived, so the client still owes two. The list and the chase ask the same
    // question, and the failure this guards against is them answering it differently.
    const listed = await (await client.get('/clients')).text();
    const row = /<td align="right"><strong>(\d+)<\/strong><\/td>/.exec(listed);
    assert.equal(row?.[1], '2', 'two still outstanding');

    const chase = await (await client.get('/chase')).text();
    assert.match(chase, /Northwind Ltd/, 'and the client is still on the chase list');
    assert.ok(!/Nothing is outstanding for anyone/.test(chase));
    assert.equal(clientRow.id.length, 36, 'the client row is the one the list linked to');
  });
});

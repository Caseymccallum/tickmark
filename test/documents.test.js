/**
 * Three things that make a finished product feel like one: finding a document you know you have, knowing what to
 * do first, and being able to say who has looked at a client's file.
 *
 * None of them is a feature a practice asks for by name, and each is the kind of absence that only shows up in
 * use — which is why they are tested rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { history, uploadsOf } from '../src/store.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

test('every document is in one list, and the search says what it can look at', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('the statements'),
      filename: 'statements-october.pdf',
    });

    const page = await (await client.get('/files')).text();
    assert.match(page, /statements-october\.pdf/, 'the file is listed by the name the client gave it');
    assert.match(page, /Northwind Ltd/, 'with the client it belongs to');
    assert.match(page, /2025 return/, 'and the request it answers');
    // The limitation has to be legible, because somebody searching for a phrase inside a document would
    // otherwise conclude the search is broken rather than that it cannot read.
    assert.match(page, /searches the names, not the contents/, 'and the page admits what it cannot do');

    // Three ways in, because a practice remembers any of the three: what the file was called, who sent it, or
    // what the request was about.
    for (const [query, why] of [
      ['october', 'part of the filename'],
      ['northwind', 'the client'],
      ['2025', 'the request'],
    ]) {
      const found = await (await client.get(`/files?q=${query}`)).text();
      assert.match(found, /statements-october\.pdf/, `found by ${why}`);
      assert.match(found, /matching/, 'and the page says it is showing a match rather than everything');
    }

    const nothing = await (await client.get('/files?q=overdraft')).text();
    assert.match(nothing, /Nothing matches that/, 'a miss is stated plainly');
    assert.match(nothing, /searches names rather than\s+contents/, 'and the reason is repeated where it is needed');

    // The export honours the same search, or the filter somebody just applied is one they redo by hand.
    const csv = await (await client.get('/files.csv?q=northwind')).text();
    assert.match(csv, /statements-october\.pdf/);
    const missed = await (await client.get('/files.csv?q=overdraft')).text();
    assert.ok(!missed.includes('statements-october.pdf'), 'and so does the negative case');
  });
});

test('a document index is not for an assistant, who can open none of it', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('the statements'),
      filename: 'statements.pdf',
    });
    assert.equal((await client.get('/files')).status, 200, 'the owner may look');

    // An assistant's job is chasing, and the chase pages already say what has arrived for whom. A searchable
    // index of every document the practice holds is more than that job needs, so the role does not get it —
    // which is the permission model working in the direction that is easy to forget.
    const id = db.prepare('SELECT id FROM practitioner LIMIT 1').get().id;
    db.prepare("UPDATE practitioner SET role = 'assistant' WHERE id = ?").run(id);
    const refused = await client.get('/files');
    assert.equal(refused.status, 403, 'and an assistant may not');
    // The refusal explains whose job it is rather than being a shrug, which is the point of `refusalFor`.
    assert.match(await refused.text(), /practice key/i, 'with a reason, naming what they do not hold');
  });
});

test('opening a document is recorded, so a firm can say who has seen a client file', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('the statements'),
      filename: 'statements.pdf',
    });
    const [stored] = uploadsOf(db, requestId);

    assert.equal(
      history(db, requestId).filter((event) => event.kind === 'file.opened').length,
      0,
      'nothing has been opened yet',
    );

    const download = await client.get(`/requests/${requestId}/files/${stored.id}`);
    assert.equal(download.status, 200, 'the document is served');

    const logged = history(db, requestId).filter((event) => event.kind === 'file.opened');
    assert.equal(logged.length, 1, 'and the look is recorded');
    assert.match(logged[0].detail, /sam@practice\.example/, 'with who did it');
    assert.match(logged[0].detail, /statements\.pdf/, 'and which file it was');

    const page = await (await client.get(`/requests/${requestId}`)).text();
    assert.match(page, /file\.opened/, 'and the history on the request page shows it');
  });
});

test('a document that was never there is not recorded as opened', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('the statements'),
      filename: 'statements.pdf',
    });
    const [stored] = uploadsOf(db, requestId);
    assert.ok(stored, 'a file is on record');

    // The stored path is read straight from the database rather than through `uploadsOf`, which deliberately does
    // not expose it: the path is an implementation detail no page needs, and a test that wrecked the disk through
    // the product's own interface would be testing the wrong thing. This test is about what happens when
    // something *outside* the product moves a file.
    const { storage_path: onDisk } = db
      .prepare('SELECT storage_path FROM upload WHERE id = ?')
      .get(stored.id);

    // The record is written after the bytes are on their way. A failed read must not leave a record of a look
    // that never happened — that is worse than no audit at all, because it would be believed.
    const { rmSync } = await import('node:fs');
    rmSync(onDisk, { force: true });

    const missing = await client.get(`/requests/${requestId}/files/${stored.id}`);
    assert.equal(missing.status, 500, 'the record points at a file that is not there, and says so');
    assert.equal(
      history(db, requestId).filter((event) => event.kind === 'file.opened').length,
      0,
      'and nothing was recorded, because nothing was opened',
    );
  });
});

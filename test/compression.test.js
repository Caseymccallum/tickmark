/**
 * Compression, checked on the wire rather than through `fetch`.
 *
 * `fetch` decompresses transparently, so a test written with it can prove the body round-trips but cannot prove the
 * bytes were ever compressed, what `content-length` says, or what happens when a client says it does not want its
 * response altered. This opens a raw socket instead, because those are the questions that matter — the socket helper
 * is `raw` in `test/helpers.js`, where the asset tests use it too.
 *
 * 88% of a Tickmark page is the inlined stylesheet, and the stylesheet is inlined so that a page needs no second
 * request — so this is where the bytes are, and it is worth an assertion rather than a shrug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import { createLink, denonce, practiceWithRequest, raw, upload, withServer } from './helpers.js';

test('a page is compressed when the browser asks, and the numbers add up', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    await practiceWithRequest({ agent, db });

    const plain = await raw(base, '/signin'); // no Accept-Encoding at all
    const zipped = await raw(base, '/signin', { headers: { 'accept-encoding': 'gzip, deflate, br' } });

    assert.equal(plain.headers['content-encoding'], undefined, 'a client that did not ask gets none');
    assert.equal(zipped.headers['content-encoding'], 'gzip', 'a client that asked gets gzip');

    // `content-length` has to describe the bytes actually sent, or the browser waits for the rest of a page that
    // already finished — which is the classic way to get this wrong.
    assert.equal(Number(zipped.headers['content-length']), zipped.body.length, 'content-length matches what arrived');
    assert.ok(zipped.body.length < plain.body.length, 'the compressed body is smaller');
    assert.equal(
      denonce(gunzipSync(zipped.body).toString('utf8')),
      denonce(plain.body.toString('utf8')),
      'and decompresses to exactly the same page',
    );

    // `Vary` matters because a cache in front of this must not hand gzipped bytes to a client that asked for none.
    assert.equal(zipped.headers.vary, 'accept-encoding', 'a cache is told the answer depends on the request');
  });
});

test('a client that does not want its response altered gets it unaltered', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    await practiceWithRequest({ agent, db });

    const untouched = await raw(base, '/signin', { headers: { 'accept-encoding': 'gzip, no-transform' } });
    assert.equal(untouched.headers['content-encoding'], undefined, 'no-transform is honoured, not cosmetic');
    assert.match(untouched.body.toString('utf8'), /<html/, 'and the page arrived as itself');
  });
});

test('an encrypted document is never compressed, however loudly the client asks', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('a bank statement, notionally'),
      filename: 'statements.pdf',
    });

    const [stored] = db.prepare('SELECT id FROM upload WHERE request_id = ?').all(practice.requestId);
    const file = await raw(base, `/requests/${practice.requestId}/files/${stored.id}`, {
      headers: { cookie: practice.client.cookie, 'accept-encoding': 'gzip' },
    });

    assert.equal(file.status, 200, 'the document was served');
    // The bytes are already ciphertext. Compressing them would cost CPU to achieve nothing, and the point of this
    // response is that it is incompressible.
    assert.equal(file.headers['content-encoding'], undefined, 'ciphertext is not run through gzip');
    assert.equal(Number(file.headers['content-length']), file.body.length, 'and the length is the length');
  });
});

test('a small answer is left alone rather than wrapped in gzip for nothing', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    await practiceWithRequest({ agent, db });

    // `/healthz` is a few dozen bytes. Gzipping it would add a header and a call to save nothing.
    const tiny = await raw(base, '/healthz', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(tiny.status, 200);
    assert.equal(tiny.headers['content-encoding'], undefined, 'a small body is not compressed');
    assert.ok(tiny.body.length < 1024, 'and it really is small, so the test is about the threshold');
  });
});

test('a CSV export is compressed too, and still opens', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const cookie = practice.client.cookie;

    // One request is a few hundred bytes, which is *below* the threshold on purpose — so the export has to be made
    // big enough to be worth compressing before this test is about compression at all. Thirty of them is a small
    // season, which is the case that actually matters for a file somebody downloads.
    for (let index = 0; index < 30; index += 1) {
      await practice.client.post('/requests', {
        client: `Client ${index} Ltd`,
        client_email: `client${index}@example.test`,
        title: `2025 return for client ${index}`,
        items: 'Bank statements\nSigned engagement letter\nPhoto ID',
      });
    }

    const plain = await raw(base, '/requests.csv', { headers: { cookie } });
    const zipped = await raw(base, '/requests.csv', { headers: { cookie, 'accept-encoding': 'gzip' } });

    assert.ok(plain.body.length > 1024, 'the export is big enough for the threshold not to be the point');
    assert.equal(zipped.headers['content-encoding'], 'gzip', 'the export is compressed');
    assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
    // The byte-order mark is the first thing in either, which is what tells Excel how to read the file.
    assert.equal(gunzipSync(zipped.body)[0], 0xef, 'the BOM survived compression');
    assert.equal(gunzipSync(zipped.body).toString('utf8'), plain.body.toString('utf8'), 'and so did every cell');
    assert.ok(zipped.body.length < plain.body.length / 2, 'and it is worth the trouble');
  });
});

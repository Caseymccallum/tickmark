/**
 * The browser-side scripts, on the wire.
 *
 * These are the files a page needs in order to encrypt, decrypt or move a key, and they were served `no-store`:
 * correct about staleness, expensive about bytes. A client's page pulls `upload.js`, `preflight.js` and the crypto
 * module — about 28 KB — every time they open the link, on the page somebody opens on a phone on a train.
 *
 * What replaced it is `no-cache` with an `ETag` taken from the bytes being sent, and this file is the three claims
 * that has to earn: a repeat visit is a 304; a *changed* file is not (the one that could otherwise hide a stale
 * encryption script); and the scripts are compressed like every other text response.
 *
 * Raw sockets, for the reason `compression.test.js` gives: `fetch` hides the bytes, the encoding and the status that
 * matter here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { raw, withServer } from './helpers.js';

const SCRIPT = '/assets/upload.js';

test('a repeat visit costs a 304, and a validator that does not match costs a download', async () => {
  await withServer(async ({ base }) => {
    const first = await raw(base, SCRIPT, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'no-cache', 'the browser may keep it, and must ask before using it');
    assert.match(first.headers.etag, /^"[A-Za-z0-9_-]+"$/, 'the validator is a quoted hash of the bytes');

    const again = await raw(base, SCRIPT, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': first.headers.etag },
    });
    assert.equal(again.status, 304, 'the same bytes, so there is nothing to send');
    assert.equal(again.body.length, 0, 'and no body at all');
    assert.equal(again.headers.etag, first.headers.etag, 'with the validator, so the browser keeps its copy');
    assert.equal(again.headers.vary, 'accept-encoding', 'and the same Vary, so a cache keeps the two encodings apart');

    const stale = await raw(base, SCRIPT, { headers: { 'if-none-match': '"a-hash-from-an-older-copy"' } });
    assert.equal(stale.status, 200, 'a validator that does not match is answered with the file');
    assert.notEqual(stale.headers.etag, '"a-hash-from-an-older-copy"');
  });
});

test('the validator follows the bytes, so a deployed script can never be served stale', async () => {
  // A web directory of our own: the file is rewritten underneath a running server, which is what deploying a new
  // script does, and the answer has to change with it.
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-assets-'));
  const file = join(directory, 'upload.js');
  writeFileSync(file, 'export const version = 1;\n');
  try {
    await withServer(
      async ({ base }) => {
        const first = await raw(base, SCRIPT);
        assert.equal(first.status, 200);
        assert.match(first.body.toString('utf8'), /version = 1/, 'the file that was there when it was asked for');

        writeFileSync(file, 'export const version = 2;\n');

        const second = await raw(base, SCRIPT, { headers: { 'if-none-match': first.headers.etag } });
        assert.equal(second.status, 200, 'the browser asked with the old validator and must be told the file changed');
        assert.notEqual(second.headers.etag, first.headers.etag, 'because the validator describes the bytes, not the name');
        assert.match(second.body.toString('utf8'), /version = 2/, 'and the body is the new file');
      },
      { webDir: directory },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the scripts are compressed for a client that asks, and left alone for one that does not', async () => {
  await withServer(async ({ base }) => {
    const plain = await raw(base, SCRIPT);
    const zipped = await raw(base, SCRIPT, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    const untouched = await raw(base, SCRIPT, { headers: { 'accept-encoding': 'gzip, no-transform' } });

    assert.equal(plain.headers['content-encoding'], undefined, 'a client that did not ask gets the bytes themselves');
    assert.equal(zipped.headers['content-encoding'], 'gzip', 'a client that asked gets gzip');
    assert.equal(
      Number(zipped.headers['content-length']),
      zipped.body.length,
      'content-length describes the bytes actually sent, or the browser waits for a script that already finished',
    );
    assert.ok(zipped.body.length < plain.body.length, 'and there are fewer of them');
    assert.equal(
      gunzipSync(zipped.body).toString('utf8'),
      plain.body.toString('utf8'),
      'decompressing gives exactly the script',
    );
    assert.equal(zipped.headers.vary, 'accept-encoding', 'a cache is told the answer depends on the request');
    assert.equal(untouched.headers['content-encoding'], undefined, 'no-transform is honoured here too');
    assert.equal(untouched.headers['content-length'], String(plain.body.length));
  });
});

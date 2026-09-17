/**
 * The practice's download: fetching an envelope and opening it in the page.
 *
 * A browser is not driven here — the page's script is DOM glue around a function that is already
 * tested. What is tested is the part that could be wrong in a way nobody would notice: that the
 * route serves the *right* bytes, to the *right* practice, and that what comes back off it opens
 * into exactly what the client sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';

import { decryptEnvelope } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, signUp, upload, withServer } from './helpers.js';

const SECRET = 'Bank statement, Q1 2025. Closing balance: 12,345.67';
let practices = 0;

/**
 * Receive one file and return the id of the row that describes it.
 *
 * Each call gets its own practice and its own address, because two practices signing up with the
 * same email is not two practices — and a helper that pretended otherwise is how the assertion
 * below was first written against a scenario that did not exist.
 */
async function receive({ agent, base, db }, { secret = SECRET, filename = 'bank statements.pdf' } = {}) {
  practices += 1;
  const practice = await practiceWithRequest({ agent, db }, `sam${practices}@practice.example`);
  const { token } = await createLink(practice.client, practice.requestId);
  await upload({
    base,
    token,
    itemId: practice.itemIds[0],
    publicKey: practice.keys.publicKey,
    plaintext: Buffer.from(secret),
    filename,
  });
  const row = db.prepare('SELECT id FROM upload ORDER BY rowid DESC LIMIT 1').get();
  return { ...practice, uploadId: row.id, filename };
}

test('the envelope route hands back the bytes the client sent, encrypted', async () => {
  await withServer(async (context) => {
    const { client, requestId, privateKey, uploadId, filename } = await receive(context);

    const response = await client.get(`/requests/${requestId}/files/${uploadId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(decodeURIComponent(response.headers.get('x-file-name')), filename);
    assert.equal(response.headers.get('cache-control'), 'no-store', 'a ciphertext blob is still not cached');

    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(!Buffer.from(bytes).toString('latin1').includes('12,345.67'), 'the document is not in it');
    assert.deepEqual(
      Buffer.from(await decryptEnvelope(privateKey, bytes)).toString(),
      SECRET,
      'and what comes back opens into exactly what the client sent',
    );
  });
});

test('another practice cannot fetch an envelope, even with the upload id', async () => {
  await withServer(async (context) => {
    const { requestId, uploadId } = await receive(context);

    const theirs = context.agent();
    await signUp(theirs, 'theirs@practice.example');
    assert.equal((await theirs.get(`/requests/${requestId}/files/${uploadId}`)).status, 404);

    const anonymous = await context.agent().get(`/requests/${requestId}/files/${uploadId}`);
    assert.equal(anonymous.status, 303, 'and a stranger is sent to sign in');
  });
});

test('an upload id that is not in this request is not found', async () => {
  await withServer(async (context) => {
    const first = await receive(context);
    const second = await receive(context);

    assert.equal(
      (await first.client.get(`/requests/${first.requestId}/files/${second.uploadId}`)).status,
      404,
      'a real upload id from another request is not reachable through this one',
    );
    assert.equal((await first.client.get(`/requests/${first.requestId}/files/nonsense`)).status, 404);
  });
});

test('the request page carries what the browser needs to open a file', async () => {
  await withServer(async (context) => {
    const { client, requestId, uploadId, keys } = await receive(context);
    const page = await (await client.get(`/requests/${requestId}`)).text();

    const keyTag = /<script type="application\/json" id="key-records">([\s\S]*?)<\/script>/.exec(page)?.[1];
    assert.ok(keyTag, 'the wrapped key is in the page');
    assert.equal(JSON.parse(keyTag).keys[0].wrapped, keys.wrappedPrivateKey, "it is the practice's own key record");

    assert.match(page, new RegExp(`data-url="/requests/${requestId}/files/${uploadId}"`), 'the file has a save url');
    assert.match(page, /data-name="bank statements\.pdf"/, 'and knows the name to save it under');
    assert.match(page, /class="save" disabled/, 'the button starts disabled — there is no key until the passphrase is typed');
    assert.match(page, /id="passphrase"/, 'there is somewhere to type the passphrase');
    assert.match(page, /src="\/assets\/download\.js"/, 'and the script that does the work is loaded');
  });
});

test('a request with nothing received offers no unlock, and no script', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const page = await (await client.get(`/requests/${requestId}`)).text();

    assert.ok(!page.includes('id="passphrase"'), 'there is nothing to open, so nothing to type');
    assert.ok(!page.includes('download.js'), 'and no script is loaded for it');
  });
});

test('the decrypting script is served, and is the module the tests just used', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/assets/download.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    assert.match(source, /from '\.\/tickmark-crypto\.js'/, 'it imports the one crypto module');
    assert.match(source, /decryptWithKeys/, 'and calls the function the tests called');
  });
});

test('a store whose file has been removed says so rather than 404ing', async () => {
  await withServer(async (context) => {
    const { client, requestId, uploadId } = await receive(context);
    const row = context.db.prepare('SELECT storage_path FROM upload WHERE id = ?').get(uploadId);
    unlinkSync(row.storage_path);

    const response = await client.get(`/requests/${requestId}/files/${uploadId}`);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /the file itself is not/);
  });
});
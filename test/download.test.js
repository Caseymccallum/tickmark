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
import { readFileSync, unlinkSync } from 'node:fs';

import { decryptEnvelope, encryptFile } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, signUp, upload, withServer } from './helpers.js';

const SECRET = 'Bank statement, Q1 2025. Closing balance: 12,345.67';
let practices = 0;

/**
 * Send a file the client chose to send that nobody asked for — the "extras" case. Same envelope and
 * same headers as `upload`, but to the route that takes no item, because the difference is exactly
 * that the file answers no checklist line.
 */
async function sendExtra({ base, token, publicKey, plaintext, filename }) {
  const envelope = await encryptFile(publicKey, plaintext);
  return fetch(`${base}/r/${token}/extra`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(filename),
    },
    body: envelope,
  });
}

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

test('a request with documents offers to download them all, named into one archive', async () => {
  await withServer(async (context) => {
    const { agent, db, base } = context;
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await upload({ base, token, itemId: practice.itemIds[0], publicKey: practice.keys.publicKey, plaintext: Buffer.from('one'), filename: 'october.pdf' });
    await upload({ base, token, itemId: practice.itemIds[1], publicKey: practice.keys.publicKey, plaintext: Buffer.from('two'), filename: 'licence.pdf' });

    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();

    const listTag = /<script type="application\/json" id="file-list">([\s\S]*?)<\/script>/.exec(page)?.[1];
    assert.ok(listTag, 'the page carries the list of what to pack');
    const list = JSON.parse(listTag);
    assert.equal(list.archive, '2025 return.zip', 'the archive is named for the request');
    assert.deepEqual(
      list.files.map((file) => file.name),
      ['Bank statements/october.pdf', 'Signed engagement letter/licence.pdf'],
      'each file sits under the document it answers, ready to be a folder',
    );
    assert.match(list.files[0].url, new RegExp(`^/requests/${practice.requestId}/files/`), 'and points at its envelope');

    assert.match(page, /id="download-all"/, 'there is one control for the whole request');
    assert.match(page, /Download everything\s*\(2 files\)/, 'and it says how many files there are');
    assert.match(page, /src="\/assets\/download\.js"/, 'with the script that decrypts and packs them');
  });
});

test('a file sent without being asked is packed too, and is a save rather than a raw link', async () => {
  await withServer(async (context) => {
    const { agent, db, base } = context;
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await upload({ base, token, itemId: practice.itemIds[0], publicKey: practice.keys.publicKey, plaintext: Buffer.from('one'), filename: 'october.pdf' });
    await sendExtra({ base, token, publicKey: practice.keys.publicKey, plaintext: Buffer.from('extra'), filename: 'surprise.pdf' });

    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();

    const list = JSON.parse(/<script type="application\/json" id="file-list">([\s\S]*?)<\/script>/.exec(page)[1]);
    assert.deepEqual(
      list.files.map((file) => file.name),
      ['Bank statements/october.pdf', 'Also sent/surprise.pdf'],
      'the unsought file is in the archive too, under a folder of its own',
    );

    // The extras row was a plain link to the envelope route, which handed the practice ciphertext —
    // the bytes, not the document. It is a Save button now, like every other file, so it opens here.
    assert.ok(!/href="\/requests\/[^"]*\/files\/[^"]*">Download</.test(page), 'no raw ciphertext link is offered');
    assert.match(page, /class="save" disabled/, 'the file is a decrypting save, starting disabled');
    assert.match(page, /src="\/assets\/download\.js"/, 'and the script is there to open it');
  });
});

test('a request whose only file was sent without being asked still offers the download', async () => {
  await withServer(async (context) => {
    const { agent, db, base } = context;
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    await sendExtra({ base, token, publicKey: practice.keys.publicKey, plaintext: Buffer.from('extra'), filename: 'surprise.pdf' });

    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();

    // `received` counts checklist *lines* that have a file, so a request whose only document was
    // unsought is zero there. The download tool is keyed to files rather than lines, so it is present
    // all the same — this is the case the old `received > 0` guard used to hide.
    assert.match(page, /id="passphrase"/, 'there is somewhere to type the passphrase');
    assert.match(page, /src="\/assets\/download\.js"/, 'and the script is loaded');
    assert.ok(!/id="download-all"/.test(page), 'but one file needs no archive — the single save is enough');
  });
});

test('a practice can add a document for a client who could not send it themselves', async () => {
  await withServer(async (context) => {
    const { agent, db, base } = context;
    const practice = await practiceWithRequest({ agent, db });

    // The page offers the way in, and carries the key the file must be sealed to.
    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();
    assert.match(page, /Add a document for this client/, 'there is a way in');
    assert.match(page, /src="\/assets\/upload\.js"/, 'and the script that encrypts before saving');
    const keyTag = /<script type="application\/json" id="practice-key">([\s\S]*?)<\/script>/.exec(page)?.[1];
    assert.ok(keyTag, 'the practice key to encrypt to is on the page');
    const { keyId } = JSON.parse(keyTag);
    assert.ok(keyId, 'and it names the key the file will be sealed to');

    // Now add one, exactly as the browser does: encrypt to the practice key, post the envelope. It
    // goes through the signed-in client, because this is the practice's own action, not a link's.
    const envelope = await encryptFile(practice.keys.publicKey, Buffer.from('a scanned letter'));
    const response = await practice.client.request(`/requests/${practice.requestId}/files`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('scanned-letter.pdf'),
        'x-key-id': keyId,
        'x-item-id': practice.itemIds[0],
      },
      body: envelope,
    });
    assert.equal(response.status, 303, 'it lands and returns to the request');

    // It is on the request now, filed against the checklist line it answers.
    const row = db.prepare('SELECT request_item_id, filename FROM upload ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(row.filename, 'scanned-letter.pdf');
    assert.equal(row.request_item_id, practice.itemIds[0], 'filed against the document it answers');

    // And the record says who put it there, because "the client sent this" and "we scanned this in
    // for them" are different facts.
    const event = db
      .prepare("SELECT detail FROM event WHERE request_id = ? AND kind = 'file.added'")
      .get(practice.requestId);
    assert.match(event.detail, /on the client's behalf/, 'the record says the practice added it');

    // The server stored an envelope, never a readable letter.
    const stored = db.prepare('SELECT storage_path FROM upload ORDER BY rowid DESC LIMIT 1').get();
    const bytes = readFileSync(stored.storage_path);
    assert.ok(!bytes.includes(Buffer.from('a scanned letter')), 'what is on disk is ciphertext');
  });
});
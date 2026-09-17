/**
 * The link and the upload — the part of the product a client touches, and the part with no
 * session to fall back on: the token in the path is the whole of the authorization.
 *
 * What these tests are really guarding: that the token is not recoverable from the server,
 * that a link cannot deliver a file to somebody else's request, that a filename cannot
 * become a path, and that a refused upload leaves nothing behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { practiceWithRequest, signUp, withServer } from './helpers.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Create a link and return the token from the page that shows it once. */
async function createLink(client, requestId, days = '30') {
  const response = await client.post(`/requests/${requestId}/link`, { days });
  assert.equal(response.status, 200, 'creating a link renders the page that shows it');
  const token = /\/r\/([A-Za-z0-9_-]{20,})/.exec(await response.text())?.[1];
  assert.ok(token, 'the link is shown to the practice');
  return token;
}

test('a link is shown once, and the token itself is never stored', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);

    const rows = db.prepare('SELECT * FROM access_token').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, sha256(token), 'the digest is what is stored');
    assert.ok(
      !JSON.stringify(rows).includes(token),
      'the token must not appear in any column — a stolen database must not open client links',
    );

    // The practice cannot get it back either, which is the honest consequence of the above.
    const page = await client.get(`/requests/${requestId}`);
    const body = await page.text();
    assert.ok(!body.includes(token), 'the link is not recoverable from the application');
    assert.match(body, /expires/, 'but the practice can see that a link exists and when it dies');
  });
});

test('the client page opens with the token, lists the documents, and says it is not private yet', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);

    const page = await fetch(`${base}/r/${token}`, { redirect: 'manual' });
    assert.equal(page.status, 200);
    const body = await page.text();

    assert.match(body, /Bank statements/);
    assert.match(body, /Signed engagement letter/);
    assert.match(body, /Photo ID/);
    assert.match(body, /Northwind Ltd/);
    assert.match(body, /still needed/, 'nothing has arrived yet');
    assert.match(body, /This is not private yet/, 'the page must not imply encryption that does not exist');
    assert.match(body, /form class="upload"/, 'each item has somewhere to put a file');
    assert.ok(!body.includes('tickmark_session'), 'a client page carries no session');
  });
});

test('an unknown, an expired and a revoked link get three different answers', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);

    const unknown = await fetch(`${base}/r/${'x'.repeat(43)}`, { redirect: 'manual' });
    assert.equal(unknown.status, 404);
    assert.match(await unknown.text(), /No such link/);

    // Expiry is a fact about time, so the test moves the clock in the database rather than
    // waiting thirty days.
    db.prepare('UPDATE access_token SET expires_at = ?').run('2020-01-01T00:00:00.000Z');
    const expired = await fetch(`${base}/r/${token}`, { redirect: 'manual' });
    assert.equal(expired.status, 410, 'expired is not "not found" — the client needs a different sentence');
    assert.match(await expired.text(), /expired/);

    db.prepare('UPDATE access_token SET expires_at = ?, revoked_at = ?').run(
      '2999-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    const revoked = await fetch(`${base}/r/${token}`, { redirect: 'manual' });
    assert.equal(revoked.status, 410);
    assert.match(await revoked.text(), /cancelled/);
  });
});

/** What the client's own script sends: raw bytes with the name in a header. */
const rawUpload = (base, token, itemId, bytes, headers = {}) =>
  fetch(`${base}/r/${token}/items/${itemId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...headers },
    body: bytes,
  });

test('a client uploads a file, and the server stores exactly the bytes it was given', async () => {
  await withServer(async ({ agent, base, db, blobDir }) => {
    const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);
    const bytes = randomBytes(4096);

    const response = await rawUpload(base, token, itemIds[0], bytes, {
      'x-file-name': encodeURIComponent('bank statements.pdf'),
      'x-file-type': 'application/pdf',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, received: 'Bank statements', bytes: 4096 });

    const row = db.prepare('SELECT * FROM upload').get();
    assert.equal(row.filename, 'bank statements.pdf', 'the name is kept as a label');
    assert.equal(row.mime, 'application/pdf');
    assert.equal(row.size_bytes, bytes.length);
    assert.equal(row.sha256, sha256(bytes), 'the digest is over the bytes as they arrived');
    assert.ok(row.storage_path.startsWith(blobDir), 'the bytes live under the blob directory');
    assert.ok(
      readFileSync(row.storage_path).equals(bytes),
      'and they are byte-for-byte what the client sent — this is the claim the whole product rests on',
    );

    const practiceView = await (await client.get(`/requests/${requestId}`)).text();
    assert.match(practiceView, /1 of 3 received/, 'the practice sees the tick');
    assert.match(practiceView, /bank statements\.pdf/);

    const clientView = await (await fetch(`${base}/r/${token}`)).text();
    assert.match(clientView, /received/, 'and so does the client');
  });
});

test('a filename that looks like a path stays a label and never becomes a path', async () => {
  await withServer(async ({ agent, base, db, blobDir }) => {
    const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);
    const nasty = '../../../../etc/passwd';

    const response = await rawUpload(base, token, itemIds[0], Buffer.from('not a passwd file'), {
      'x-file-name': encodeURIComponent(nasty),
    });
    assert.equal(response.status, 201);

    const row = db.prepare('SELECT * FROM upload').get();
    assert.equal(row.filename, nasty, 'the name is recorded as the client typed it');
    const directory = join(blobDir, requestId);
    assert.equal(join(directory, `${row.id}.bin`), row.storage_path, 'the path is built from ids alone');
    assert.deepEqual(readdirSync(directory), [`${row.id}.bin`], 'exactly one file, inside the blob directory');
  });
});

test('an item belonging to another request cannot be uploaded to, even with a valid link', async () => {
  await withServer(async ({ agent, base, db }) => {
    const first = await practiceWithRequest({ agent, db }, 'one@practice.example');
    const second = await practiceWithRequest({ agent, db }, 'two@practice.example');
    const token = await createLink(first.client, first.requestId);

    const response = await rawUpload(base, token, second.itemIds[0], Buffer.from('crossing requests'));
    assert.equal(response.status, 404, 'a valid link is not a licence over every request');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM upload').get()).n, 0, 'and nothing was stored');
  });
});

test('a revoked link refuses the upload, and leaves nothing behind', async () => {
  await withServer(async ({ agent, base, db, blobDir }) => {
    const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);
    const tokenId = db.prepare('SELECT id FROM access_token').get().id;

    const revoked = await client.post(`/requests/${requestId}/revoke`, { token_id: tokenId });
    assert.equal(revoked.status, 303);

    const response = await rawUpload(base, token, itemIds[0], Buffer.from('too late'));
    assert.equal(response.status, 410);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM upload').get()).n, 0, 'nothing was recorded');
    assert.ok(!existsSync(join(blobDir, requestId)), 'and no directory was created');
  });
});

test('one practice cannot create or revoke a link on another practice\'s request', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db }, 'mine@practice.example');
    const token = await createLink(client, requestId);
    const tokenId = db.prepare('SELECT id FROM access_token').get().id;

    const theirs = agent();
    await signUp(theirs, 'theirs@practice.example');
    assert.equal((await theirs.post(`/requests/${requestId}/link`, { days: '30' })).status, 404);
    assert.equal((await theirs.post(`/requests/${requestId}/revoke`, { token_id: tokenId })).status, 404);

    assert.equal((await fetch(`${base}/r/${token}`)).status, 200, 'and the link still works');
  });
});

test('an upload that is not raw bytes is refused rather than stored as framing', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);

    const response = await fetch(`${base}/r/${token}/items/${itemIds[0]}`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      body: '--xyz\r\nContent-Disposition: form-data; name="file"\r\n\r\nhello\r\n--xyz--',
    });
    assert.equal(response.status, 415);
    assert.equal(
      (await db.prepare('SELECT COUNT(*) AS n FROM upload').get()).n,
      0,
      'multipart framing is not a file, and storing it would corrupt the client\'s document',
    );
  });
});

test('an upload larger than the limit is refused, and nothing is stored', async () => {
  await withServer(
    async ({ agent, base, db, blobDir }) => {
      const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
      const token = await createLink(client, requestId);

      const response = await rawUpload(base, token, itemIds[0], randomBytes(64 * 1024));
      assert.equal(response.status, 413);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM upload').get()).n, 0);
      assert.ok(!existsSync(join(blobDir, requestId)));
    },
    // A small cap in the test, so that proving the limit works does not mean moving 25 MiB.
    { maxUploadBytes: 8 * 1024 },
  );
});

test('the history records the link being made and the file arriving, in order', async () => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
    const token = await createLink(client, requestId);
    await rawUpload(base, token, itemIds[2], Buffer.from('a photograph of a passport'));

    const kinds = db
      .prepare('SELECT kind FROM event WHERE request_id = ? ORDER BY at, rowid')
      .all(requestId)
      .map((row) => row.kind);
    assert.deepEqual(kinds, ['request.created', 'link.issued', 'upload.received']);
  });
});
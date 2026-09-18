/**
 * Shared plumbing for the HTTP tests.
 *
 * **This file is not a test, and `npm test` does not run it.** The test script names the test files
 * explicitly (`node --test "test/*.test.js"`) because Node's default discovery executes *every* `.js`
 * file under a directory named `test`, recursively — and counts each one as a passing test. Plain
 * `node --test` therefore reported two more tests than exist, this file and `test/smtp-relay.js` being
 * the two. A count that overstates itself by two is exactly the kind of claim this project tries not to
 * make.
 *
 * One cookie-jar implementation and one server-starting helper, shared rather than copied,
 * because two copies of a test harness are two chances for the harness to be wrong in
 * different ways — the failing test would then be the harness's fault, which is the worst
 * kind of red.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { encryptFile, generatePracticeKey, unwrapPracticeKey } from '../web/tickmark-crypto.js';

/** A browser-like client that keeps its own cookie jar. */
export function agent(base) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(base + path, { ...options, headers, redirect: 'manual' });
      const set = response.headers.getSetCookie();
      if (set.length > 0) cookie = set.map((value) => value.split(';')[0]).join('; ');
      return response;
    },
    post(path, fields, extra = {}) {
      return this.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(extra.headers ?? {}) },
        body: new URLSearchParams(fields).toString(),
      });
    },
    get(path) {
      return this.request(path);
    },
  };
}

/**
 * Start the real server on a port nobody chose, in a data directory that is thrown away
 * afterwards — including the uploaded blobs, because a test that leaves files behind is a
 * test that fills a disk.
 */
export async function withServer(run, { maxUploadBytes, mailer, chaseBudgetMs } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-test-'));
  const blobDir = join(directory, 'blobs');
  const db = openDatabase(join(directory, 'tickmark.db'));
  const server = createApp(db, { blobDir, maxUploadBytes, mailer, chaseBudgetMs });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db, blobDir, agent: () => agent(base) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export const PASSWORD = 'a long enough password';
export const PASSPHRASE = 'a passphrase long enough';
export const signUp = (client, email, password = PASSWORD) => client.post('/signup', { email, password });

/**
 * Give a signed-in practice an encryption key, which is what sending a link requires.
 *
 * This runs the real browser flow's server half: the key pair is generated here with the same
 * module the browser uses, and the passphrase-wrapped private half is posted as the page posts
 * it. Nothing is faked, so a change to the wrapping format breaks these tests rather than
 * passing them.
 */
export async function setUpKey(client, passphrase = PASSPHRASE) {
  const keys = await generatePracticeKey(passphrase);
  const response = await client.post('/setup', {
    public_key: JSON.stringify(keys.publicKey),
    wrapped_private_key: keys.wrappedPrivateKey,
  });
  if (response.status !== 303) {
    throw new Error(`the test helper could not store a key: /setup answered ${response.status}`);
  }
  return { ...keys, response, passphrase };
}

/**
 * Create a link through the practice's own page, and take the token out of the page that shows it
 * once.
 *
 * The token is scraped from the rendered page rather than read from the database, because there is
 * nothing in the database to read: only its digest is stored, and a helper that could produce it
 * another way would be testing a flow the product does not have.
 */
export async function createLink(client, requestId, days = '30') {
  const response = await client.post(`/requests/${requestId}/link`, { days });
  const token = /\/r\/([A-Za-z0-9_-]{20,})/.exec(await response.text())?.[1];
  return { response, token };
}

/**
 * Encrypt a file to the practice's public key and send it the way the client's page does.
 *
 * Everything about this mirrors `web/upload.js`: the same content type, the same two headers,
 * and the envelope produced by the same function.
 */
export async function upload({ base, token, itemId, publicKey, plaintext, filename = 'upload.bin', note = null, headers = {} }) {
  const envelope = await encryptFile(publicKey, plaintext);
  const response = await fetch(`${base}/r/${token}/items/${itemId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(filename),
      ...(note === null ? {} : { 'x-note': encodeURIComponent(note) }),
      ...headers,
    },
    body: envelope,
  });
  return { response, envelope };
}

/**
 * Sign a practice up, create one request with three items, and return what a test needs.
 *
 * Item ids come from the database rather than by scraping the page: the page they appear on
 * is the *client's*, which needs a link first, and a test helper that quietly depended on a
 * page's markup would break every time the page changed.
 */
export async function practiceWithRequest({ agent, db }, email = 'sam@practice.example', passphrase = PASSPHRASE) {
  const client = agent();

  // Both steps check their outcome. A helper that carries on after a refused sign-up produces a
  // test that passes while exercising nothing — which is exactly what happened the first time this
  // was written, and it cost more time to find than the check would have.
  const signup = await signUp(client, email);
  if (signup.status !== 303) {
    throw new Error(
      `the test helper could not create ${email}: /signup answered ${signup.status}. Use a different address — emails are unique per practice.`,
    );
  }

  const keys = await setUpKey(client, passphrase);
  const created = await client.post('/requests', {
    client: 'Northwind Ltd',
    client_email: 'accounts@northwind.example',
    title: '2025 return',
    items: 'Bank statements\nSigned engagement letter\nPhoto ID',
  });
  const location = created.headers.get('location') ?? '';
  if (created.status !== 303 || !/^\/requests\/[0-9a-f-]{36}$/.test(location)) {
    throw new Error(
      `the test helper could not create a request for ${email}: /requests answered ${created.status} -> ${location}`,
    );
  }
  const requestId = location.split('/').pop();
  const itemIds = db
    .prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position')
    .all(requestId)
    .map((row) => row.id);
  return {
    client,
    requestId,
    itemIds,
    keys,
    privateKey: await unwrapPracticeKey(keys.wrappedPrivateKey, passphrase),
  };
}
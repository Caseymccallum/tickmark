#!/usr/bin/env node
/**
 * Check the documented install path, end to end, against a running container.
 *
 * `docker compose up` is what the README tells a practice to run, and `node --test` cannot check it: the
 * suite runs on the host, where `web/` is on disk. This repository has already been bitten by that gap
 * once — the Dockerfile did not copy `web/`, the image built and reported success, and the container then
 * crash-looped on `ERR_MODULE_NOT_FOUND` because the server has to import the envelope format from it.
 *
 * So this asks the container instead: the whole loop, through the server, over HTTP. It uses the same
 * crypto module the container serves, because that is the one a browser would run.
 *
 * Two steps, because a restart has to happen between them:
 *
 *   1.  docker compose up -d
 *       node tools/check-container.mjs                    # a practice, its key, two encrypted uploads,
 *                                                         # a rotation, the move of every stored file
 *                                                         # onto the new key, and the old key retired
 *       docker compose restart
 *       node tools/check-container.mjs --after-restart    # signs back in and opens those files through
 *                                                         # the volume that survived
 *   2.  docker compose down -v
 *
 * `BASE` points it elsewhere; it defaults to the port compose publishes, `http://127.0.0.1:3000`.
 */
import { createHash } from 'node:crypto';

import { decryptEnvelope, encryptFile, generatePracticeKey, unwrapPracticeKey } from '../web/tickmark-crypto.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const PASSPHRASE = 'a passphrase long enough for the container check';
const FRESH = 'a second passphrase, also long enough';

const ACCOUNT = { email: 'office@example.com', password: 'a long enough password' };

let cookie = '';
const jar = (response) => {
  const set = response.headers.getSetCookie();
  if (set.length > 0) cookie = set.map((value) => value.split(';')[0]).join('; ');
  return response;
};
const get = (path) => fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' }).then(jar);
const post = (path, fields) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  }).then(jar);

const say = (label, value) => console.log(`${label.padEnd(32)}: ${value}`);

/** A connection failure is the most likely one, and a raw ECONNREFUSED is not a diagnosis. */
async function reachable() {
  try {
    const home = await get('/');
    if (home.status !== 200) {
      console.error(`the server answered ${home.status} rather than a page — stopping rather than reporting nonsense`);
      process.exit(1);
    }
    say('the server answers', `200, ${(await home.text()).length} bytes`);
  } catch (error) {
    console.error(`nothing is serving at ${BASE} — ${error.cause?.code ?? error.message}`);
    console.error('is the container up?  docker compose up -d   then   docker compose logs');
    process.exit(1);
  }
}

/** The key records the page hands the browser, read out of the page the container rendered. */
async function readKeyTag() {
  const page = await (await get('/keys')).text();
  const raw = /<script type="application\/json" id="key-records">([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (!raw) throw new Error('the keys page carried no key records');
  return JSON.parse(raw);
}

/** Every stored file of a request, opened with the key that wraps it in the database. */
async function openEveryFile(requestId, privateKey) {
  const page = await (await get(`/requests/${requestId}`)).text();
  const ids = new Set([...page.matchAll(/\/requests\/[^/]+\/files\/([0-9a-f-]{36})/g)].map((m) => m[1]));
  const digest = createHash('sha256');
  const opened = [];
  for (const id of ids) {
    const bytes = new Uint8Array(await (await get(`/requests/${requestId}/files/${id}`)).arrayBuffer());
    digest.update(bytes);
    try {
      opened.push(Buffer.from(await decryptEnvelope(privateKey, bytes)).toString());
    } catch (error) {
      opened.push(`FAILED: ${error.message}`);
    }
  }
  return { opened, digest: digest.digest('hex') };
}

async function fresh() {
  await reachable();

  // The asset the browser needs for the pass. A missing `COPY web` breaks this and nothing else in the
  // suite, which is exactly why it is checked first.
  const script = await get('/assets/reencrypt.js');
  const body = await script.text();
  say('the re-encryption script is served', `${script.status}, ${body.length} bytes, ${/unwrapPracticeKey/.test(body) ? 'the real file' : 'NOT THE FILE'}`);

  say('sign up', `${(await post('/signup', ACCOUNT)).status}`);

  const keys = await generatePracticeKey(PASSPHRASE);
  say('store the encryption key', `${(await post('/setup', { public_key: JSON.stringify(keys.publicKey), wrapped_private_key: keys.wrappedPrivateKey })).status}`);

  const created = await post('/requests', {
    client: 'Northwind Ltd',
    client_email: 'accounts@northwind.example',
    title: '2025 return',
    items: 'Bank statements\nPhoto ID\nSigned engagement letter',
    due: '',
  });
  const requestId = created.headers.get('location')?.split('/').pop();
  say('create a request', `${created.status} -> ${requestId?.slice(0, 8)}`);

  const token = /\/r\/([A-Za-z0-9_-]{20,})/.exec(await (await post(`/requests/${requestId}/link`, { days: '30' })).text())?.[1];
  say('make a client link', token ? 'a token was issued' : 'NO TOKEN');

  const before = await readKeyTag();
  say('the keys page', `${before.keys.length} key(s), current ${before.currentKeyId.slice(0, 8)}`);

  // Uploads, sealed to the current key and saying so — the header the server now records.
  const clientPage = await (await fetch(`${BASE}/r/${token}`)).text();
  const items = [...new Set([...clientPage.matchAll(/\/r\/[^/]+\/items\/([0-9a-f-]{36})/g)].map((m) => m[1]))].slice(0, 2);
  say('the client page lists items', items.length);

  const send = async (itemId, text) => {
    const envelope = await encryptFile(keys.publicKey, Buffer.from(text));
    const response = await fetch(`${BASE}/r/${token}/items/${itemId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('statement.pdf'),
        'x-key-id': before.currentKeyId,
      },
      body: envelope,
    });
    return response.status;
  };
  say('upload one', await send(items[0], 'Northwind bank statement, Q1'));
  say('upload two', await send(items[1], 'photo id, page 1'));

  const rotated = await generatePracticeKey(FRESH);
  say('rotate the key', `${(await post('/setup', { public_key: JSON.stringify(rotated.publicKey), wrapped_private_key: rotated.wrappedPrivateKey })).status}`);

  const after = await readKeyTag();
  say('the keys page now', `${after.keys.length} key(s), current ${after.currentKeyId.slice(0, 8)}`);

  const oldPrivate = await unwrapPracticeKey(keys.wrappedPrivateKey, PASSPHRASE);
  const newPrivate = await unwrapPracticeKey(rotated.wrappedPrivateKey, FRESH);

  let moved = 0;
  for (;;) {
    const listed = await (await get(`/keys/${before.currentKeyId}/pending`)).json();
    if (listed.files.length === 0) break;
    const file = listed.files[0];
    const envelope = new Uint8Array(await (await get(file.url)).arrayBuffer());
    const plaintext = await decryptEnvelope(oldPrivate, envelope);
    const resealed = await encryptFile(rotated.publicKey, plaintext);
    const check = await decryptEnvelope(newPrivate, resealed);
    if (check.length !== plaintext.length || !check.every((byte, index) => byte === plaintext[index])) {
      throw new Error('the round trip did not match, so nothing should be posted');
    }
    const posted = await fetch(`${BASE}/files/${file.id}/reencrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-key-id': after.currentKeyId, cookie },
      body: resealed,
    });
    if (posted.status !== 200) throw new Error(`the container refused the move: ${posted.status} ${await posted.text()}`);
    moved += 1;
  }
  say('files moved to the new key', moved);
  say('left on the old key', (await (await get(`/keys/${before.currentKeyId}/pending`)).json()).files.length);

  const retired = await post(`/keys/${before.currentKeyId}/retire`, { confirm: 'retire' });
  const keysPage = await (await get('/keys')).text();
  say('retire the old key', `${retired.status}`);
  say('the page reads as a history', `${/Retired keys/.test(keysPage) ? 'live keys then retired' : 'NO HISTORY'}${/its copies were destroyed/.test(keysPage) ? ', with the reason' : ''}`);

  const { opened, digest } = await openEveryFile(requestId, newPrivate);
  say('files found after the pass', opened.length);
  say('  every one still opens', `${opened.filter((text) => !text.startsWith('FAILED')).length} of ${opened.length}`);
  say('  and are the originals', JSON.stringify(opened.map((text) => text.slice(0, 22))));
  say('a digest over them', digest.slice(0, 16));

  console.log('\nnext:  docker compose restart   then   --after-restart');
}

/**
 * After a restart: are the records still there, and is the retired key still recorded as retired?
 *
 * The volume is the whole backup story — "copy the data directory" — so a restart that lost the schema
 * migration, the key history or a retirement date would make that sentence false.
 */
async function afterRestart() {
  await reachable();

  say('signing back in', `${(await post('/signin', ACCOUNT)).status}`);

  const board = await (await get('/requests')).text();
  say('the request survived', /Northwind Ltd/.test(board) ? 'yes' : 'NO — the volume lost it');

  const requestId = /\/requests\/([0-9a-f-]{36})/.exec(board)?.[1];
  if (!requestId) {
    console.error('no request to look at — run without --after-restart first');
    process.exit(1);
  }

  const keysPage = await (await get('/keys')).text();
  const records = JSON.parse(/<script type="application\/json" id="key-records">([\s\S]*?)<\/script>/.exec(keysPage)[1]);
  say('keys still on the page', `${records.keys.length} live`);
  say('and the retired one', /its copies were destroyed, so it opens nothing/.test(keysPage) ? 'still recorded, with its date' : 'GONE — the record was lost');

  // The point of the whole pass: a document written before the rotation, sealed to the old key then moved
  // to the new one, opens with the key that now holds it.
  const privateKey = await unwrapPracticeKey(records.keys[0].wrapped, FRESH);
  const { opened } = await openEveryFile(requestId, privateKey);
  say('files still listed', opened.length);
  say('and every one opens', `${opened.filter((text) => !text.startsWith('FAILED')).length} of ${opened.length}`);
  say('  with the content intact', JSON.stringify(opened.map((text) => text.slice(0, 22))));

  console.log('\ndone — the volume carried the records across a restart');
}

if (process.argv.includes('--after-restart')) await afterRestart();
else await fresh();
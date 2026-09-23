/**
 * The three key pages, run rather than served.
 *
 * `web/setup.js`, `web/keys.js` and `web/reencrypt.js` are the part of a key's life that only a browser can do:
 * making it, changing the passphrase that protects it, and moving stored files onto it. All three were served on
 * every page and executed by nothing — so the claims around them lived in prose and nowhere else: that the
 * passphrase is never sent, that a passphrase change is the *same key sealed differently*, and that a re-sealed file
 * opens back to the document it replaced.
 *
 * What each page puts on the wire is opened again here with the real `web/tickmark-crypto.js`, because that is the
 * only check that means anything: a test that re-implemented the wrapping would only agree with itself.
 *
 * `test/fake-dom.js` is the browser they run in — see its header for why it is hand-written, and what it is loud
 * about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answer, element, installPage } from './fake-dom.js';
import {
  MIN_PASSPHRASE,
  decryptEnvelope,
  encryptFile,
  generatePracticeKey,
  privateKeyBytesForTransfer,
  unwrapPracticeKey,
} from '../web/tickmark-crypto.js';

const PASSPHRASE = 'a passphrase long enough';
const OTHER_PASSPHRASE = 'another passphrase entirely';
const DOCUMENT = 'Bank statement, Q1 2025. Closing balance: 12,345.67';

const bytes = (value) => new TextEncoder().encode(value);
const text = (value) => new TextDecoder().decode(value);
const fields = (body) => new URLSearchParams(String(body));

/**
 * Two key records, made once for the whole file, both sealed under the same passphrase — the common case the page's
 * own comment describes ("a practice usually seals every key under one passphrase").
 *
 * Each record is 600,000 rounds of PBKDF2, and a suite that spends a minute deriving keys is a suite somebody turns
 * off. The tests run in order and nothing here mutates a record.
 */
let keys = null;
const fixture = async () => {
  keys ??= Promise.all([generatePracticeKey(PASSPHRASE), generatePracticeKey(PASSPHRASE)]).then(([old, current]) => ({
    old,
    current,
  }));
  return keys;
};

/** The setup page's form, as the shell writes it. */
function setupForm() {
  const status = element();
  const submit = element({ disabled: true });
  const saved = element();
  const passphrase = element();
  const again = element();
  const form = element({
    children: {
      '.status': status,
      'button[type="submit"]': submit,
      '#saved-passphrase': saved,
      '#passphrase': passphrase,
      '#again': again,
    },
  });
  return { form, status, submit, saved, passphrase, again };
}

test('the first key is refused until the passphrase is confirmed, long enough and typed twice', async () => {
  const { form, status, submit, saved, passphrase, again } = setupForm();
  const page = installPage({ ids: { setup: form }, fetch: () => answer({ text: 'ok' }) });
  await page.load('../web/setup.js');

  // The checkbox is the page's one gate, and the button is disabled until it is ticked: the warning cannot be
  // scrolled past and forgotten.
  saved.checked = false;
  await saved.fire('change');
  assert.equal(submit.disabled, true, 'unticked, the button cannot be pressed at all');
  saved.checked = true;
  await saved.fire('change');
  assert.equal(submit.disabled, false, 'ticked, it can');

  passphrase.value = 'short';
  again.value = 'short';
  await form.fire('submit');
  assert.equal(status.textContent, `Use at least ${MIN_PASSPHRASE} characters.`);

  passphrase.value = PASSPHRASE;
  again.value = 'a different passphrase';
  await form.fire('submit');
  assert.equal(status.textContent, 'Those two passphrases are not the same.');

  assert.equal(page.sent.length, 0, 'and neither refusal generated a key or sent anything');
});

test('the key is made in the browser, and the passphrase is not sent', async () => {
  const { form, status, saved, passphrase, again } = setupForm();
  const page = installPage({ ids: { setup: form }, fetch: () => answer({ text: 'ok' }) });
  await page.load('../web/setup.js');

  saved.checked = true;
  await saved.fire('change');
  passphrase.value = PASSPHRASE;
  again.value = PASSPHRASE;
  await form.fire('submit');

  assert.equal(page.sent.length, 1, 'one request, and it is the one that stores the key');
  const [request] = page.sent;
  assert.equal(request.url, '/setup');
  assert.equal(request.method, 'POST');

  const posted = fields(request.body);
  assert.deepEqual(
    [...posted.keys()].sort(),
    ['public_key', 'wrapped_private_key'],
    'exactly two fields, and neither is a passphrase',
  );
  assert.ok(!String(request.body).includes(PASSPHRASE), 'and the passphrase is not in the body in any form');

  // What the server stored opens with the passphrase and to nothing else, and the public half matches it: a document
  // encrypted to the public key opens with the private key that arrived beside it.
  const wrapped = posted.get('wrapped_private_key');
  const publicKey = JSON.parse(posted.get('public_key'));
  const privateKey = await unwrapPracticeKey(wrapped, PASSPHRASE);
  const opened = await decryptEnvelope(privateKey, await encryptFile(publicKey, bytes(DOCUMENT)));
  assert.equal(text(opened), DOCUMENT, 'the two halves are one key pair, sealed to the passphrase');
  await assert.rejects(
    unwrapPracticeKey(wrapped, OTHER_PASSPHRASE),
    /does not open this key/,
    'and a different passphrase does not open it',
  );

  assert.equal(status.textContent, 'Saving it…');
  assert.equal(page.navigations.at(-1), '/requests', 'the practice lands in its workspace');
});

test('changing a passphrase is the same key, sealed differently, and only the record is sent', async () => {
  const { old } = await fixture();
  const status = element();
  const form = element({
    action: '/keys/k1/passphrase',
    dataset: { keyId: 'k1' },
    children: {
      '.status': status,
      '[name=old]': element({ value: PASSPHRASE }),
      '[name=fresh]': element({ value: OTHER_PASSPHRASE }),
      '[name=again]': element({ value: OTHER_PASSPHRASE }),
    },
  });
  const records = element({ textContent: JSON.stringify({ keys: [{ id: 'k1', wrapped: old.wrappedPrivateKey }] }) });
  const page = installPage({
    ids: { 'key-records': records },
    queries: { 'form.passphrase': [form] },
    fetch: () => answer({ text: 'ok' }),
  });
  await page.load('../web/keys.js');

  await form.fire('submit');

  assert.equal(page.sent.length, 1);
  const [request] = page.sent;
  assert.equal(request.url, '/keys/k1/passphrase', 'the form posts where it says it does');
  const posted = fields(request.body);
  assert.deepEqual([...posted.keys()], ['wrapped_private_key'], 'the only thing sent is the re-sealed record');
  assert.ok(
    !String(request.body).includes(PASSPHRASE) && !String(request.body).includes(OTHER_PASSPHRASE),
    'neither the old nor the new passphrase travels',
  );

  const resealed = posted.get('wrapped_private_key');
  const before = await privateKeyBytesForTransfer(old.wrappedPrivateKey, PASSPHRASE);
  const after = await privateKeyBytesForTransfer(resealed, OTHER_PASSPHRASE);
  assert.deepEqual(
    Array.from(after),
    Array.from(before),
    'the key itself is unchanged, so every stored file still opens',
  );
  await assert.rejects(
    privateKeyBytesForTransfer(resealed, PASSPHRASE),
    /does not open this key/,
    'and the passphrase that used to open it no longer does',
  );
  assert.equal(page.navigations.at(-1), '/keys');
});

test('a fresh passphrase that is short or mistyped is refused, and a wrong old one sends nothing', async () => {
  const { old } = await fixture();
  const status = element();
  const oldField = element({ value: 'not the passphrase at all' });
  const freshField = element({ value: OTHER_PASSPHRASE });
  const againField = element({ value: OTHER_PASSPHRASE });
  const form = element({
    action: '/keys/k1/passphrase',
    dataset: { keyId: 'k1' },
    children: { '.status': status, '[name=old]': oldField, '[name=fresh]': freshField, '[name=again]': againField },
  });
  const records = element({ textContent: JSON.stringify({ keys: [{ id: 'k1', wrapped: old.wrappedPrivateKey }] }) });
  const page = installPage({
    ids: { 'key-records': records },
    queries: { 'form.passphrase': [form] },
    fetch: () => answer({ text: 'ok' }),
  });
  await page.load('../web/keys.js');

  freshField.value = 'short';
  againField.value = 'short';
  await form.fire('submit');
  assert.equal(status.textContent, `Use at least ${MIN_PASSPHRASE} characters.`);

  freshField.value = OTHER_PASSPHRASE;
  againField.value = 'a different passphrase';
  await form.fire('submit');
  assert.equal(status.textContent, 'Those two are not the same.');

  // The one the practice is most likely to meet: a mistyped passphrase changes nothing, and sends nothing.
  againField.value = OTHER_PASSPHRASE;
  await form.fire('submit');
  assert.match(status.textContent, /that passphrase does not open this key/);
  assert.equal(page.sent.length, 0, 'nothing left the page, and the record on the server is untouched');
});

test('a file is moved onto the current key, and the server only ever gets an envelope', async () => {
  const { old, current } = await fixture();
  const stored = new Map([
    ['f1', await encryptFile(old.publicKey, bytes(DOCUMENT))],
    ['f2', await encryptFile(old.publicKey, bytes('Invoice 88: one thousand two hundred'))],
  ]);

  const status = element();
  const bar = element();
  const form = element({
    dataset: { keyId: 'old' },
    children: {
      '.status': status,
      progress: bar,
      '[name=passphrase]': element({ value: PASSPHRASE }),
      '[name=current_passphrase]': element(),
    },
  });
  const records = element({
    textContent: JSON.stringify({
      keys: [
        { id: 'old', wrapped: old.wrappedPrivateKey },
        { id: 'cur', wrapped: current.wrappedPrivateKey },
      ],
      currentKeyId: 'cur',
      currentPublicKey: current.publicKey,
    }),
  });

  // The server's answer *is* the progress: a file that has moved stops being listed, which is what makes closing
  // the tab harmless. So the list shrinks the way it would in the product.
  const lists = [
    [{ id: 'f1', filename: 'statements.pdf', url: '/files/f1' }, { id: 'f2', filename: 'invoice.pdf', url: '/files/f2' }],
    [{ id: 'f2', filename: 'invoice.pdf', url: '/files/f2' }],
    [],
  ];
  let listed = 0;

  const page = installPage({
    ids: { 'key-records': records },
    queries: { 'form.reencrypt': [form] },
    fetch: (request) => {
      if (request.url === '/keys/old/pending') {
        listed += 1;
        return answer({ json: { files: lists[listed - 1] ?? [] } });
      }
      if (request.url.startsWith('/files/') && request.method === 'POST') return answer({ text: 'ok' });
      if (request.url.startsWith('/files/')) return answer({ bytes: stored.get(request.url.slice('/files/'.length)) });
      throw new Error(`the page fetched ${request.url}, which this test did not expect`);
    },
  });
  await page.load('../web/reencrypt.js');

  await form.fire('submit');

  const posts = page.sent.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 2, 'both files were replaced');
  assert.equal(listed, 3, 'and the page asked what was left after each one rather than walking a list it fetched first');
  assert.equal(bar.value, 2, 'the bar followed the files');
  assert.equal(status.textContent, 'Moved 2. Reloading…');
  assert.equal(page.navigations.at(-1), '/keys');

  const currentPrivate = await unwrapPracticeKey(current.wrappedPrivateKey, PASSPHRASE);
  const opened = await decryptEnvelope(currentPrivate, new Uint8Array(posts[0].body));
  assert.equal(text(opened), DOCUMENT, 'what the server stored is sealed to the current key and opens back to the document');
  assert.equal(posts[0].headers['x-key-id'], 'cur', 'and it says which key sealed it, or a key could never be retired');
  const oldPrivate = await unwrapPracticeKey(old.wrappedPrivateKey, PASSPHRASE);
  await assert.rejects(
    decryptEnvelope(oldPrivate, new Uint8Array(posts[0].body)),
    'and the retiring key no longer opens it — the file has genuinely moved rather than been copied',
  );
});

test('a file that does not open stops the run before anything is replaced', async () => {
  const { old, current } = await fixture();
  // Sealed to a key the record being retired cannot open: the shape of a corrupted, foreign or half-written file.
  const foreign = await encryptFile(current.publicKey, bytes(DOCUMENT));

  const status = element();
  const form = element({
    dataset: { keyId: 'old' },
    children: {
      '.status': status,
      progress: element(),
      '[name=passphrase]': element({ value: PASSPHRASE }),
      '[name=current_passphrase]': element(),
    },
  });
  const records = element({
    textContent: JSON.stringify({
      keys: [
        { id: 'old', wrapped: old.wrappedPrivateKey },
        { id: 'cur', wrapped: current.wrappedPrivateKey },
      ],
      currentKeyId: 'cur',
      currentPublicKey: current.publicKey,
    }),
  });
  const page = installPage({
    ids: { 'key-records': records },
    queries: { 'form.reencrypt': [form] },
    fetch: (request) => {
      if (request.url === '/keys/old/pending') {
        return answer({ json: { files: [{ id: 'f1', filename: 'damaged.pdf', url: '/files/f1' }] } });
      }
      if (request.url.startsWith('/files/') && request.method === 'POST') return answer({ text: 'ok' });
      if (request.url.startsWith('/files/')) return answer({ bytes: foreign });
      throw new Error(`the page fetched ${request.url}, which this test did not expect`);
    },
  });
  await page.load('../web/reencrypt.js');

  await form.fire('submit');

  assert.match(status.textContent, /^Stopped after 0 files: /, 'it says where it stopped and how much it moved');
  assert.match(status.textContent, /press the button again to carry on/, 'and that nothing was lost');
  assert.equal(
    page.sent.filter((request) => request.method === 'POST').length,
    0,
    'nothing was replaced, which is the whole reason the round trip is checked first',
  );
});

test('a current key under a different passphrase is asked for before anything is touched', async () => {
  const { old } = await fixture();
  // The uncommon case the second box exists for: this practice sealed its two keys under different passphrases.
  const other = await generatePracticeKey(OTHER_PASSPHRASE);
  const stored = await encryptFile(old.publicKey, bytes(DOCUMENT));
  const status = element();
  const alsoTyped = element();
  const form = element({
    dataset: { keyId: 'old' },
    children: {
      '.status': status,
      progress: element(),
      '[name=passphrase]': element({ value: PASSPHRASE }),
      '[name=current_passphrase]': alsoTyped,
    },
  });
  const records = element({
    textContent: JSON.stringify({
      keys: [
        { id: 'old', wrapped: old.wrappedPrivateKey },
        { id: 'cur', wrapped: other.wrappedPrivateKey },
      ],
      currentKeyId: 'cur',
      currentPublicKey: other.publicKey,
    }),
  });
  let listed = 0;
  const page = installPage({
    ids: { 'key-records': records },
    queries: { 'form.reencrypt': [form] },
    fetch: (request) => {
      if (request.url === '/keys/old/pending') {
        listed += 1;
        return answer({
          json: { files: listed === 1 ? [{ id: 'f1', filename: 'statements.pdf', url: '/files/f1' }] : [] },
        });
      }
      if (request.url.startsWith('/files/') && request.method === 'POST') return answer({ text: 'ok' });
      if (request.url === '/files/f1') return answer({ bytes: stored });
      throw new Error(`the page fetched ${request.url}, which this test did not expect`);
    },
  });
  await page.load('../web/reencrypt.js');

  // The two keys are sealed under different passphrases, so the run stops before re-sealing anything the person
  // could not read back.
  await form.fire('submit');
  assert.match(status.textContent, /second box/, 'the page says which passphrase it is missing');
  assert.equal(listed, 0, 'and it stopped before touching a single file');

  alsoTyped.value = OTHER_PASSPHRASE;
  await form.fire('submit');
  assert.equal(status.textContent, 'Moved 1. Reloading…', 'with the current key open, the same run goes through');
  assert.equal(page.sent.filter((request) => request.method === 'POST').length, 1);
});

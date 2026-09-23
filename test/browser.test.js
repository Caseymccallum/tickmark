/**
 * The two pages that touch a document: the client's upload, and the practice's download.
 *
 * The encryption module has its own tests, and they run *the* implementation rather than a copy of it — Web Crypto
 * is the same API in Node as in a page, so `crypto.test.js` is not a second thing to be wrong. What it cannot reach
 * is the glue around that: `web/upload.js` deciding what to put on the wire, and `web/download.js` turning what came
 * back into a file the practice can open. Those lines were **served on every page and executed by nothing**, which is
 * the difference between a claim and a check.
 *
 * `test/fake-dom.js` is the browser they run in: enough of one to press the buttons, hand-written for the same reason
 * the SMTP client is, and no dependency in a test run that deliberately installs nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser } from './fake-dom.js';
import {
  HEADER_BYTES,
  MAGIC,
  decryptEnvelope,
  encryptFile,
  generatePracticeKey,
  unwrapPracticeKey,
} from '../web/tickmark-crypto.js';

const PASSPHRASE = 'a passphrase long enough';
const SECRET = 'Bank statement, Q1 2025. Closing balance: 12,345.67';
const bytes = (value) => new TextEncoder().encode(value);
const text = (value) => new TextDecoder().decode(value);

test('the client\u2019s page encrypts the file before anything is sent', async () => {
  const { publicKey, wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const file = new File([bytes(SECRET)], 'statements.pdf', { type: 'application/pdf' });
  const browser = installBrowser({
    publicKey,
    keyId: 'key-7',
    maxBytes: 1024,
    files: [file],
    fetch: async () => ({ ok: true, status: 201 }),
  });

  await browser.load('../web/upload.js');
  await browser.uploadForm.fire('submit');

  assert.equal(browser.sent.length, 1, 'one submit, one request');
  const [request] = browser.sent;
  const envelope = new Uint8Array(request.body);

  assert.deepEqual(Array.from(envelope.slice(0, 4)), Array.from(MAGIC), 'what left the browser is an envelope');
  assert.ok(
    !Buffer.from(envelope).toString('latin1').includes('12,345.67'),
    'and the document does not survive in it — the page encrypted before it sent',
  );
  assert.equal(request.headers['x-file-name'], 'statements.pdf', 'the name travels as a header, not in the body');
  assert.equal(request.headers['x-key-id'], 'key-7', 'and so does which key sealed it, or a key could never be retired');
  assert.equal(browser.reloads.count, 1, 'the client is shown what happened rather than left looking at a form');

  // The other half of the claim, and the only way to state it: what the page sent opens with the passphrase and
  // nothing else. If the page had encrypted to anything else, this is where it would show.
  const key = await unwrapPracticeKey(wrappedPrivateKey, PASSPHRASE);
  assert.equal(text(await decryptEnvelope(key, envelope)), SECRET);
});

test('a file over the practice\u2019s limit is refused before it is encrypted', async () => {
  const { publicKey } = await generatePracticeKey(PASSPHRASE);
  const file = new File([bytes('a bank statement, longer than eight bytes')], 'big.pdf', { type: 'application/pdf' });
  const browser = installBrowser({ publicKey, maxBytes: 8, files: [file] });

  await browser.load('../web/upload.js');
  await browser.fileInput.fire('change');

  assert.equal(browser.sendButton.disabled, true, 'the send button stays dead');
  assert.match(browser.uploadStatus.textContent, /too large/, 'and the client is told why, before waiting on a send');

  // A form submitted without a change event is the case the backstop exists for.
  await browser.uploadForm.fire('submit');
  assert.equal(browser.sent.length, 0, 'so nothing is encrypted, and nothing is sent');
});

test('clearing the picker puts the page back, and a refusal from the server is shown as words', async () => {
  const { publicKey } = await generatePracticeKey(PASSPHRASE);
  const file = new File([bytes('a bank statement')], 'statements.pdf', { type: 'application/pdf' });
  const browser = installBrowser({
    publicKey,
    maxBytes: 1024,
    files: [],
    // The server's own refusal page, markup and all — what a client sees when a limit is hit for a reason the
    // browser cannot know about.
    fetch: async () => ({
      ok: false,
      status: 413,
      text: async () => '<p class="warn">That file is too large for this request.</p>',
    }),
  });

  await browser.load('../web/upload.js');

  await browser.fileInput.fire('change');
  assert.equal(browser.sendButton.disabled, false, 'nothing chosen is not a refusal');
  assert.equal(browser.uploadStatus.textContent, '', 'and nothing is said about a file nobody picked');

  browser.fileInput.files = [file];
  await browser.fileInput.fire('change');
  assert.equal(browser.sendButton.disabled, false, 'a file inside the limit can be sent');

  await browser.uploadForm.fire('submit');
  assert.equal(browser.sent.length, 1, 'it was sent');
  assert.equal(
    browser.uploadStatus.textContent,
    'That file is too large for this request.',
    'and the refusal is read as a sentence rather than as markup',
  );
  assert.equal(browser.reloads.count, 0, 'with no reload, because there is nothing new to show');
});

test('the practice\u2019s page opens the envelope in the tab and saves the document', async () => {
  const { publicKey, wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const envelope = await encryptFile(publicKey, bytes(SECRET));
  const browser = installBrowser({
    wrappedKey: wrappedPrivateKey,
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => envelope.slice().buffer }),
  });

  await browser.load('../web/download.js');
  assert.equal(browser.saveButton.disabled, true, 'the page starts with no key, so nothing can be saved');

  browser.passphrase.value = PASSPHRASE;
  await browser.unlockButton.fire('click');
  assert.equal(browser.unlockStatus.textContent, 'Key unlocked for this tab. You can save files now.');
  assert.equal(browser.saveButton.disabled, false, 'and the saves open');

  await browser.saveButton.fire('click');

  assert.equal(browser.sent.length, 1, 'the page fetched the file it was asked to open');
  assert.equal(browser.sent[0].url, '/files/one/download');
  assert.equal(browser.saved.length, 1, 'and one document reached the browser');

  const [download] = browser.saved;
  assert.equal(download.name, 'statements.pdf', 'under the name the practice gave it');
  assert.equal(
    text(new Uint8Array(await download.blob.arrayBuffer())),
    SECRET,
    'what was saved is the document itself, not the envelope it arrived in',
  );
  assert.equal(browser.saveStatus.textContent, `Saved statements.pdf (${bytes(SECRET).length} bytes).`);

  // One minute, and not zero: revoking the blob URL the moment the anchor is clicked cancels the download in some
  // browsers, which is the reason the delay is there. Asserted rather than waited for.
  assert.equal(browser.timers.length, 1, 'the object URL is released once');
  assert.equal(browser.timers[0].ms, 60000, 'a minute after the save rather than during it');
  browser.timers[0].fn();
  assert.deepEqual(browser.revoked, [download.url], 'and releasing it is what the timer does');
});

test('a wrong passphrase opens nothing, and saves nothing', async () => {
  const { publicKey, wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const envelope = await encryptFile(publicKey, bytes(SECRET));
  const browser = installBrowser({
    wrappedKey: wrappedPrivateKey,
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => envelope.slice().buffer }),
  });

  await browser.load('../web/download.js');
  browser.passphrase.value = 'not the passphrase at all';
  await browser.unlockButton.fire('click');

  assert.equal(browser.unlockStatus.textContent, "That passphrase does not open any of this practice's keys.");
  assert.equal(browser.saveButton.disabled, true, 'so there is still nothing to save with');
  assert.equal(browser.passphrase.value, '', 'and the page does not keep what was typed into it');

  // Pressing save anyway asks for the passphrase rather than fetching a file it cannot open: the difference between
  // a page that refuses and a page that wastes the practice's bandwidth on an envelope it will not read.
  await browser.saveButton.fire('click');
  assert.equal(browser.sent.length, 0, 'nothing was fetched');
  assert.equal(browser.saved.length, 0, 'and nothing was handed to the browser');
  assert.equal(browser.unlockStatus.textContent, 'Type your passphrase first.');
});

test('an envelope changed in storage is refused by the page rather than opened wrongly', async () => {
  const { publicKey, wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const good = await encryptFile(publicKey, bytes(SECRET));
  let served = good;
  const browser = installBrowser({
    wrappedKey: wrappedPrivateKey,
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => served.slice().buffer }),
  });

  await browser.load('../web/download.js');
  browser.passphrase.value = PASSPHRASE;
  await browser.unlockButton.fire('click');
  assert.equal(browser.saveButton.disabled, false, 'the key is open, so any refusal below is about the file');

  for (const [what, index] of [
    ['a byte of the ciphertext', HEADER_BYTES],
    ['a byte of the header — the ephemeral key an attacker would want to substitute', 10],
    ['the last byte, inside the authentication tag', good.length - 1],
  ]) {
    served = Uint8Array.from(good);
    served[index] ^= 0x01;

    await browser.saveButton.fire('click');

    assert.match(browser.saveStatus.textContent, /could not be opened/, `${what} must not open`);
  }

  assert.equal(browser.saved.length, 0, 'and nothing was handed to the browser at any point');
});

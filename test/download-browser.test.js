/**
 * The practice's download page, driven as a page rather than as a route.
 *
 * `download.test.js` checks that the route serves the right bytes to the right practice. This checks what the page
 * *does* with them: the passphrase that opens nothing, the file that will not open, the archive that must not be
 * half-saved. Those are the failures a practice would hit and nobody would notice were untested, because the happy
 * path is the one that gets used.
 *
 * **One test, one instance, many states — on purpose.** `test/fake-dom.js` loads a module through a cache-busting
 * query, so every `load()` is a separate instrumented script as far as `npm run coverage` is concerned: ten scenarios
 * would report ten partially-covered copies of `download.js` and drag the project's number down while testing more.
 * The page holds its unlocked keys in a module variable, so the states here are walked in the order a person would
 * meet them, with the test owning the elements it changes — which is also the more faithful model of a tab somebody
 * is actually using.
 *
 * The property underneath every case: the plaintext exists in this tab and nowhere else, and a failure produces a
 * sentence rather than a half-download.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answer, installBrowser } from './fake-dom.js';
import { decryptEnvelope, encryptFile, generatePracticeKey, unwrapPracticeKey } from '../web/tickmark-crypto.js';

const PASSPHRASE = 'a passphrase long enough';
const OTHER = 'a different passphrase entirely';
const SECRET = 'Bank statement, Q1 2025. Closing balance: 12,345.67';
const bytes = (value) => new TextEncoder().encode(value);

test('the passphrase panel stays folded until something actually needs a key', async () => {
  const { wrappedPrivateKey } = await generatePracticeKey(PASSPHRASE);
  const browser = installBrowser({ wrappedKey: wrappedPrivateKey, fetch: async () => answer() });

  await browser.load('../web/download.js');
  assert.equal(browser.unlockPanel.open, false, 'it starts folded away — a reader checking on a request is not asked for a secret');

  // Pressing save with nothing typed opens the panel, moves the reader to it and says what to do. That is the
  // whole of the progressive disclosure: the field appears at the moment it is the next thing to do.
  await browser.saveButton.fire('click');
  assert.equal(browser.unlockPanel.open, true, 'and opens when a save needs a key');
  assert.match(browser.unlockStatus.textContent, /Type your passphrase first/);

  browser.passphrase.value = PASSPHRASE;
  await browser.unlockButton.fire('click');
  assert.match(browser.unlockStatus.textContent, /Key unlocked for this tab/);
  assert.equal(browser.saveButton.disabled, false);
});

test('the download page: unlock, save and pack, through every state it has', async () => {
  // Two keys, because a practice that rotated has two and the page has a branch for a passphrase that opens only
  // some of them. Everything sealed to `older` is what this practice's passphrase opens.
  const older = await generatePracticeKey(PASSPHRASE);
  const newer = await generatePracticeKey(OTHER);
  const sealedTo = (key, plaintext) => encryptFile(key.publicKey, bytes(plaintext));
  const mine = await sealedTo(older, SECRET);
  const theirs = await sealedTo(newer, 'a document this passphrase cannot open');

  // What the page fetches, switched per phase — a tab's fetches are not all the same either.
  let respond = () => answer();
  const browser = installBrowser({
    wrappedKeys: [older.wrappedPrivateKey, newer.wrappedPrivateKey],
    // Present from the start so the page has the bulk control the way a real request page does; its contents
    // are replaced per phase below.
    fileList: { archive: 'request.zip', files: [] },
    fetch: async (request) => respond(request),
  });
  await browser.load('../web/download.js');

  // --- nothing typed --------------------------------------------------------------------------------
  assert.equal(browser.saveButton.disabled, true, 'there is no key until the passphrase is typed');
  await browser.unlockButton.fire('click');
  assert.match(browser.unlockStatus.textContent, /Type your passphrase first/);

  // --- a passphrase that opens nothing --------------------------------------------------------------
  browser.passphrase.value = 'not the passphrase';
  await browser.unlockButton.fire('click');
  assert.match(browser.unlockStatus.textContent, /does not open any of this practice's keys/);
  assert.equal(browser.saveButton.disabled, true, 'the save buttons stay dead — there is no key to open anything with');
  assert.equal(browser.passphrase.value, '', 'and the field is cleared rather than left holding a wrong secret');

  // --- a passphrase that opens one of the two -------------------------------------------------------
  browser.passphrase.value = PASSPHRASE;
  await browser.unlockButton.fire('click');
  // Not a failure: a fact the page states, because "wrong passphrase" would be a lie about a key that did open.
  assert.match(browser.unlockStatus.textContent, /1 of 2 keys unlocked/);
  assert.match(browser.unlockStatus.textContent, /will not open with this passphrase/);
  assert.equal(browser.saveButton.disabled, false, 'a key did open, so saving works');
  assert.equal(browser.passphrase.disabled, true, 'and the field is not left open holding the passphrase');
  assert.equal(browser.unlockButton.disabled, true);

  // --- saving the file the client sent ---------------------------------------------------------------
  respond = () => answer({ bytes: mine });
  await browser.saveButton.fire('click');
  assert.equal(browser.sent.length, 1);
  assert.equal(browser.sent[0].url, '/files/one/download', 'it fetched the envelope, not a rendered document');
  assert.equal(browser.saved.length, 1, 'one save');
  const [saved] = browser.saved;
  assert.equal(saved.name, 'statements.pdf', 'under the name the server recorded');
  assert.equal(new TextDecoder().decode(new Uint8Array(await saved.blob.arrayBuffer())), SECRET);
  assert.doesNotMatch(browser.saveStatus.textContent, /12,345\.67/, 'the document is never put on the page as text');
  assert.match(browser.saveStatus.textContent, /Saved statements\.pdf/);
  // Revoked late rather than at once, because revoking immediately cancels the download in some browsers.
  assert.equal(browser.revoked.length, 0);
  assert.equal(browser.timers.find((timer) => timer.ms === 60000)?.ms, 60000, 'released after a minute');
  // And the proof that what was saved is the document: the same envelope opens with the practice's own key.
  const key = await unwrapPracticeKey(older.wrappedPrivateKey, PASSPHRASE);
  assert.equal(new TextDecoder().decode(await decryptEnvelope(key, mine)), SECRET);

  // --- a save the server refuses ---------------------------------------------------------------------
  respond = () => answer({ ok: false });
  await browser.saveButton.fire('click');
  assert.match(browser.saveStatus.textContent, /The server refused that/);
  assert.equal(browser.saved.length, 1, 'nothing further was saved');

  // --- an envelope sealed to a key this passphrase does not open -------------------------------------
  respond = () => answer({ bytes: theirs });
  await browser.saveButton.fire('click');
  assert.match(browser.saveStatus.textContent, /could not be opened/);
  assert.equal(browser.saved.length, 1, 'a file that cannot be opened is not handed over as if it had been');

  // --- packing the request: nothing to pack ----------------------------------------------------------
  browser.fileListElement.textContent = JSON.stringify({ archive: 'empty.zip', files: [] });
  await browser.downloadAllButton.fire('click');
  assert.match(browser.downloadAllStatus.textContent, /nothing here to save yet/i);
  assert.equal(browser.saved.length, 1);

  // --- packing the request: two documents, one download ----------------------------------------------
  const second = await sealedTo(older, 'the invoices');
  browser.fileListElement.textContent = JSON.stringify({
    archive: '2025-return.zip',
    files: [{ name: 'statements.pdf', url: '/files/a' }, { name: 'invoices.pdf', url: '/files/b' }],
  });
  respond = (request) => answer({ bytes: request.url === '/files/a' ? mine : second });
  await browser.downloadAllButton.fire('click');

  assert.equal(browser.saved.length, 2, 'one download for the whole request');
  const packed = browser.saved[1];
  assert.equal(packed.name, '2025-return.zip', 'under the name the request page chose');
  const asText = Buffer.from(new Uint8Array(await packed.blob.arrayBuffer())).toString('latin1');
  assert.ok(asText.includes('statements.pdf'), 'the archive names the first file');
  assert.ok(asText.includes('invoices.pdf'), 'and the second');
  assert.match(browser.downloadAllStatus.textContent, /Saved 2025-return\.zip/);

  // --- packing the request: one document will not open ------------------------------------------------
  // A half-archive is a file that quietly lost a document — worse than an error, because nobody counts the files.
  respond = (request) => answer({ bytes: request.url === '/files/a' ? mine : theirs });
  await browser.downloadAllButton.fire('click');
  assert.match(browser.downloadAllStatus.textContent, /Nothing was packed/);
  assert.equal(browser.saved.length, 2, 'and nothing further was handed over');

  // --- the all-keys branch: a practice whose single key this passphrase does open ---------------------
  // The page re-reads the key records on every unlock, so narrowing them is a state it can genuinely be in
  // (a practice that has not rotated). This is the message most practices will actually see.
  browser.keyRecords.textContent = JSON.stringify({ keys: [{ wrapped: older.wrappedPrivateKey }] });
  browser.passphrase.disabled = false;
  browser.passphrase.value = PASSPHRASE;
  await browser.unlockButton.fire('click');
  assert.match(browser.unlockStatus.textContent, /Key unlocked for this tab/);
});

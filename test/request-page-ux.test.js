/**
 * The request page and the client page, as a person meets them.
 *
 * Three things the audit found on these two screens, and each one is a small claim that is easy to lose again:
 *
 * - the passphrase field used to occupy the middle of the page a practice opens all day, whether or not they were
 *   there to open a document;
 * - the document table scrolls below about 44rem, and a scroll region with no visible edge looks like a table that
 *   simply ends — with a review button waiting off-screen;
 * - what the file picker accepts is invisible, so a client cannot tell a photo from a document until the picker
 *   greys one out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

test('the passphrase field is folded away, and the bulk download is not', async () => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    // Two documents, because "Download everything" only appears when there is more than one.
    for (const [item, name] of [[practice.itemIds[0], 'one.pdf'], [practice.itemIds[1], 'two.pdf']]) {
      await upload({
        base, token, itemId: item, publicKey: practice.keys.publicKey, plaintext: Buffer.from('a document'), filename: name,
      });
    }

    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();

    // The disclosure is closed as it arrives: a practice checking whether anything has come in is not asked for a
    // secret to do it. Nothing in the markup opens it; the page's script does, at the moment a save needs a key.
    assert.match(page, /<details class="disclosure" id="unlock-panel">/, 'the panel is a plain disclosure');
    assert.doesNotMatch(page, /<details[^>]*id="unlock-panel"[^>]*\sopen/, 'and it is closed');
    assert.match(page, /<summary>Open what has arrived<\/summary>/, 'with a summary that says what it does');
    assert.match(page, /id="passphrase"/, 'and the field is still there, inside it');

    // The bulk download is outside the disclosure, because it is the thing most practices came for. It stays
    // visible; only the secret is folded away.
    const downloadAt = page.indexOf('id="download-all"');
    const panelAt = page.indexOf('id="unlock-panel"');
    assert.ok(downloadAt > -1, 'the bulk download is on the page');
    assert.ok(downloadAt < panelAt, 'and it is above the disclosure rather than inside it');
    assert.match(page, /Download everything/, 'named in full rather than an icon');
  });
});

test('a client can see what the picker accepts, and the picker keeps its semantics', async () => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const page = await (await practice.client.get(`/r/${token}`)).text();

    // The semantics a phone's camera depends on, unchanged.
    assert.match(page, /type="file"[^>]*multiple/, 'more than one file at a time');
    assert.match(page, /accept="image\/\*,\*?application\/pdf"/, 'photos and PDFs');
    assert.match(page, /aria-label="Upload one or more files for:/, 'and a name that says which document it is for');

    // And what the attribute means, in words, because an attribute is invisible.
    assert.match(page, /A photo or a PDF is fine/, 'the client is told what is accepted');
  });
});

test('a table that scrolls says so, and its controls do not break mid-word', async () => {
  await withServer(async ({ agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();

    // The two-tone trick: gradients pinned to the content (local) and shadows pinned to the box (scroll) mean an
    // edge appears only while there is something to scroll to, and never when there is not.
    assert.match(page, /no-repeat local/, 'the fade travels with the content');
    assert.match(page, /no-repeat scroll/, 'and the shadow sits on the box');
    assert.match(page, /radial-gradient\(farthest-side at 100% 50%/, 'a right-hand edge to show there is more');

    // A review control is a phrase. It wraps as a whole rather than breaking across the middle of a word.
    assert.match(page, /td button, td \.btn \{ white-space: nowrap; \}/);
    assert.match(page, /td \.inline \{ flex-wrap: wrap;/, 'and a row of them wraps rather than overflowing');
  });
});

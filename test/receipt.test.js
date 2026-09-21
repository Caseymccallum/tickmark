/**
 * The client's own receipt.
 *
 * The page has always told a client what had arrived, item by item, and never let them check it. "Did you
 * get it?" is a phone call to a practice that has to look the answer up, and the person best placed to
 * answer it is the one holding the link.
 *
 * Two things are being pinned here, and the second is the one worth defending: the filenames shown back to
 * the client are the ones **they** chose, so this is their own message returning rather than a disclosure —
 * and a client who sent nothing today still sees what they sent in March, because that is what a receipt
 * is for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

/** A request with a link, and the ids a client's page works from. */
async function withLink({ base, agent, db }, email = 'sam@practice.example') {
  const practice = await practiceWithRequest({ agent, db }, email);
  const { token } = await createLink(practice.client, practice.requestId);
  const anonymous = agent();
  const page = await (await anonymous.get(`/r/${token}`)).text();
  // Deduped: every item has two forms pointing at it — the upload and the "says" one — so scraping the
  // page naively returns each id twice, and the second entry is the first item over again. That mistake
  // made an earlier version of this file withdraw the item it had just uploaded to.
  const itemIds = [...new Set([...page.matchAll(new RegExp(`/r/${token}/items/([0-9a-f-]{36})`, 'g'))].map((m) => m[1]))];
  return { ...practice, token, anonymous, itemIds };
}

test('a client is told how many they have sent, and sees the name and date of each', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { token, anonymous, itemIds, keys } = await withLink({ base, agent, db });

    const before = await (await anonymous.get(`/r/${token}`)).text();
    assert.match(before, /You have sent 0 of 3\s+documents/, 'nothing sent yet, and it says so');
    assert.ok(!before.includes('you sent'), 'with no receipt lines to show');

    await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('bank statements'),
      filename: 'statements-2025.pdf',
    });

    const after = await (await anonymous.get(`/r/${token}`)).text();
    assert.match(after, /You have sent 1 of 3\s+documents/, 'the count moves');
    assert.match(after, /you sent/, 'and there is a receipt line');
    assert.match(after, /<strong>statements-2025\.pdf<\/strong>/, 'naming the file the client chose');
    assert.match(after, /on \d{4}-\d{2}-\d{2}/, 'and the day it arrived');
    assert.match(after, /received/, 'beside the item it answered');
  });
});

test('when everything has arrived, the nagging stops and the page says thank you', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { requestId, client } = await practiceWithRequest({ agent, db }, 'sam@practice.example');
    const { token } = await createLink(client, requestId);
    const anonymous = agent();
    const page = await (await anonymous.get(`/r/${token}`)).text();
    const itemIds = [...page.matchAll(new RegExp(`/r/${token}/items/([0-9a-f-]{36})`, 'g'))].map((m) => m[1]);

    // Encrypt each file to the key the page itself hands out, the way a browser does — read from the page
    // rather than from the helper, because the point is that the client's page is enough to send with.
    const { publicKey } = JSON.parse(
      /<script type="application\/json" id="practice-key">(.*?)<\/script>/s.exec(page)[1],
    );
    for (const itemId of itemIds) {
      const { response } = await upload({
        base,
        token,
        itemId,
        publicKey,
        plaintext: Buffer.from('a document'),
        filename: `doc-${itemId.slice(0, 4)}.pdf`,
      });
      assert.ok(response.ok, `the upload for ${itemId} was accepted`);
    }

    const complete = await (await anonymous.get(`/r/${token}`)).text();
    assert.match(complete, /Thank you — everything asked for has arrived/, 'the page thanks them');
    assert.match(complete, /All 3 documents are/, 'and says how many are with the practice');
    assert.ok(!/You have sent \d of \d/.test(complete), 'the count is replaced rather than repeated');
    assert.ok(!/please send this again/.test(complete), 'and nothing is being asked for again');
  });
});

test('the receipt is a client\u2019s own record, and a withdrawn document is not on it', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const { token, anonymous, itemIds, keys, client, requestId } = await withLink({ base, agent, db });

    await upload({
      base,
      token,
      itemId: itemIds[0],
      publicKey: keys.publicKey,
      plaintext: Buffer.from('a document'),
      filename: 'sent.pdf',
    });
    assert.match(await (await anonymous.get(`/r/${token}`)).text(), /sent\.pdf/, 'the file is on the receipt');

    // The practice stops asking for that item. The client's list is the current ask, so the line goes —
    // what arrived is kept in the record, which is the practice's page and not this one.
    await client.post(`/requests/${requestId}/items/${itemIds[1]}/withdraw`, {});
    const after = await (await anonymous.get(`/r/${token}`)).text();
    assert.match(after, /You have sent 1 of 2\s+documents/, 'the total follows the current ask');
    assert.match(after, /sent\.pdf/, 'and what they sent is still on their receipt');
  });
});

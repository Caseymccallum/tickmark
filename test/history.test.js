/**
 * Getting the history out of the tool.
 *
 * The other exports give the lists — requests, clients, documents. This gives the *record*: what was sent,
 * what arrived, and when, across every request at once. It is the answer to "did we ever get the bank
 * statements?" as a file rather than as memory, and the one thing the request pages only show one request
 * at a time. `What` is the event's own name, the same code the request page shows — so the file and the
 * screen cannot disagree about what happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLink, practiceWithRequest, withServer } from './helpers.js';

test('the whole history comes out as a spreadsheet, saying what happened and to whom', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    // A second thing the record keeps: issuing a link puts `link.issued` against the request.
    await createLink(client, requestId);

    const response = await client.get('/history.csv');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/, 'it is a CSV file');

    const csv = await response.text();
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'When,Client,Request,What,Detail', 'the header names what a row holds');

    // The record covers the request's life so far — it was made, and a link was issued — and each row
    // names the client and the request, so a spreadsheet can be sorted by either.
    assert.match(csv, /request\.created/, 'the request being made is in the record');
    assert.match(csv, /link\.issued/, 'and so is the link that was sent');
    assert.match(csv, /Northwind Ltd/, 'every row names the client');
    assert.match(csv, /2025 return/, 'and the request it belongs to');
    assert.equal(lines.length, 3, 'a header and the two events, and nothing invented');
  });
});
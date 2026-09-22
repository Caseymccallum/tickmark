/**
 * The two checks a browser makes before a file is encrypted.
 *
 * These are the only part of the document flow that can look inside a file, and it is available here precisely
 * because the server never does: the plaintext is already in the browser, so looking at it costs nobody their
 * privacy. The alternative — Suralink's answer — is to read everything server-side so it can be pre-screened,
 * which is the one thing this product's design rules out.
 *
 * Both checks warn rather than refuse. The reasoning is in `web/preflight.js`, and one test below pins the
 * thing that makes them possible at all: the payload the page hands the browser carries no hash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { containsBytes, duplicateOf, looksEncryptedPdf, readableBytes } from '../web/preflight.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

const bytes = (text) => new Uint8Array([...text].map((character) => character.charCodeAt(0)));

// --- the pure checks ----------------------------------------------------------------------------

test('an encrypted PDF is recognised from the marker its trailer leaves in plain text', () => {
  // A real encrypted PDF says so in its trailer, and that entry cannot itself be encrypted — a reader has to
  // find it before it can decrypt anything. So the marker is plain text even when nothing else is.
  const encryptedTail = bytes('\n/Size 42 /Root 1 0 R /Encrypt 9 0 R >>\nstartxref\n1234\n%%EOF');
  assert.equal(
    looksEncryptedPdf({ name: 'statement.pdf', type: 'application/pdf', head: bytes('%PDF-1.7\n'), tail: encryptedTail }),
    true,
    'found at the end, which is where a trailer normally sits',
  );

  // A linearised PDF — optimised for reading over a slow connection — keeps a copy of the trailer at the
  // start, which is why both ends are searched rather than only the last few kilobytes.
  const encryptedHead = bytes('%PDF-1.7\n/Encrypt 9 0 R\n1 0 obj');
  assert.equal(
    looksEncryptedPdf({ name: 'statement.pdf', type: '', head: encryptedHead, tail: bytes('%%EOF') }),
    true,
    'found at the start, which is what "linearised" means',
  );

  const ordinary = bytes('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\nstartxref\n99\n%%EOF');
  assert.equal(
    looksEncryptedPdf({ name: 'accounts.pdf', type: 'application/pdf', head: bytes('%PDF-1.7'), tail: ordinary }),
    false,
    'an ordinary PDF is left alone',
  );
});

test('the PDF check only looks at PDFs, so a photo is never second-guessed', () => {
  // A statement sent as a photo of a screen is a real thing and often perfectly acceptable, so nothing here
  // should comment on a JPEG. The guard is by name and by declared type, because a browser's guess at the type
  // is not always right and the extension usually is.
  const withMarker = bytes('.../Encrypt...');
  assert.equal(
    looksEncryptedPdf({ name: 'statement.jpg', type: 'image/jpeg', head: withMarker, tail: withMarker }),
    false,
    'not a PDF by any measure',
  );
  assert.equal(
    looksEncryptedPdf({ name: 'statement.pdf', type: 'image/jpeg', head: withMarker, tail: withMarker }),
    true,
    'the extension wins when the browser has guessed the type wrong',
  );
  assert.equal(
    looksEncryptedPdf({ name: 'no-extension', type: 'application/pdf', head: withMarker, tail: withMarker }),
    true,
    'and the declared type wins when there is no extension',
  );
});

test('the duplicate check compares the two facts the client can already see', () => {
  const already = [
    { name: 'statement.pdf', bytes: 240_000, at: '2026-03-12' },
    { name: 'id.jpg', bytes: 1_800_000, at: '2026-03-14' },
  ];

  assert.ok(duplicateOf({ name: 'statement.pdf', size: 240_000 }, already), 'the same file, picked twice');
  assert.equal(duplicateOf({ name: 'statement.pdf', size: 241_000 }, already), null, 'a different scan is a different size');
  assert.equal(duplicateOf({ name: 'accounts.pdf', size: 240_000 }, already), null, 'a different name');
  assert.equal(duplicateOf({ name: 'statement.pdf', size: 240_000 }, []), null, 'nothing sent yet');
});

test('sizes are written the way a person reads them', () => {
  assert.equal(readableBytes(240_000), '234 KB');
  assert.equal(readableBytes(14 * 1024 * 1024), '14.0 MB');
  assert.equal(readableBytes(0), '1 KB', 'rounded up rather than reported as zero, which reads like a bug');
});

// --- the page has to hand the browser the list ---------------------------------------------------

test('the client\u2019s page hands the browser what it already sent, and nothing more than that', async () => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);

    const before = await (await fetch(`${base}/r/${token}`)).text();
    assert.match(before, /id="already-sent"/, 'the payload is on the page');
    assert.match(before, /id="already-sent">\[\]</, 'and empty when nothing has been sent');

    const sent = await upload({
      base,
      token,
      itemId: practice.itemIds[0],
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('the statement'),
      filename: 'statement.pdf',
    });
    assert.ok(sent.response.ok, 'the document arrived');

    const after = await (await fetch(`${base}/r/${token}`)).text();
    const payload = JSON.parse(/id="already-sent">([^<]*)</.exec(after)[1]);
    assert.deepEqual(
      Object.keys(payload[0]).sort(),
      ['at', 'bytes', 'name'],
      'name, size and date — the three facts already on the page',
    );
    assert.equal(payload[0].name, 'statement.pdf');
    assert.equal(payload[0].bytes, sent.envelope.length, 'the size of what was stored');
    assert.ok(payload[0].at, 'and the date it arrived, so the warning can name it');

    // The load-bearing assertion. A hash of the contents would make the duplicate check sharper, and it would
    // make this a product that holds a verifier for a client's bank statement. If somebody ever adds one, this
    // fails — the argument for not doing it is in web/preflight.js.
    assert.ok(!/sha-?256|digest|hash/i.test(after), 'no digest of the contents reaches the browser');

    // The envelope's own hash is still recorded, which is a different thing entirely: it is a hash of
    // ciphertext, so it verifies nothing about what the client sent.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM upload WHERE sha256 IS NOT NULL').get().n,
      1,
      'the ciphertext hash is still recorded server-side, where it always was',
    );
    assert.equal(containsBytes(bytes(payload[0].name), 'statement'), true, 'and the check reads what it was given');
  });
});

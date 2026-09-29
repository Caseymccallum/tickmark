/**
 * The ZIP writer.
 *
 * `web/zip.js` is the only hand-written format code on the client side that gathers *every* document
 * on a request into one file, so it is tested the way the SMTP client is: against the format, not
 * against itself. The parser below reads an archive back the way an unzipper does — from the central
 * directory, following each offset to its stored bytes — so a wrong offset or a short write is caught
 * by the reader's arithmetic rather than echoed back as agreement.
 *
 * The checksum is checked against the standard CRC-32 check value (0xCBF43F26 for "123456789"), so
 * the implementation is held to the specification rather than to its own idea of a checksum.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crc32, zip } from '../web/zip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A reader for the central directory — the part an unzipper trusts. Returns one entry per file. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record, found by scanning back from the end (it may have a comment).
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  assert.notEqual(end, -1, 'the archive has an end-of-central-directory record');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  assert.equal(directoryOffset + directorySize, end, 'the directory runs right up to the end record');

  const entries = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, `central-directory record ${i} has its signature`);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // Follow the offset to the local header and pull the bytes it stores.
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `${name}: the offset points at a local header`);
    assert.equal(view.getUint16(localOffset + 8, true), method, `${name}: local and directory agree on the method`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = new Uint8Array(bytes.subarray(dataStart, dataStart + size));

    entries.push({ name, method, crc, size, data });
    at += 46 + nameLen;
  }
  return entries;
}

test('crc32 is the reference’s checksum, not our own idea of one', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926, 'the CRC-32 (zlib) check value');
  assert.equal(crc32(encoder.encode('abc')), 0x352441c2, 'and the usual vector for "abc"');
  assert.equal(crc32(new Uint8Array(0)), 0, 'and an empty file is 0');
});

test('an archive unpacks into exactly the files it was given, bytes and all', () => {
  const files = [
    { name: '2025 return/Bank statements/october.pdf', bytes: encoder.encode('the october statements') },
    { name: '2025 return/Photo ID/licence.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) },
    { name: '2025 return/Also sent/nothing.bin', bytes: new Uint8Array(0) },
  ];
  const entries = readZip(zip(files, new Date(2026, 0, 2, 3, 4, 6)));

  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    files.map((file) => file.name),
    'every name survives, folders and all — a `/` is a folder in a ZIP',
  );
  for (const [index, entry] of entries.entries()) {
    const file = files[index];
    assert.equal(entry.method, 0, `${entry.name} is stored, so what went in is what comes out`);
    assert.deepEqual([...entry.data], [...file.bytes], `${entry.name} is itself, byte for byte`);
    assert.equal(entry.crc, crc32(file.bytes), `${entry.name} carries its real checksum`);
    assert.equal(entry.size, file.bytes.length, `${entry.name} is its real size`);
  }
});

test('an archive of nothing is still a valid, empty archive', () => {
  const archive = zip([]);
  assert.equal(archive.length, 22, 'just the end record');
  assert.deepEqual(readZip(archive), []);
});

test('a client’s file keeps its name — the UTF-8 flag is set', () => {
  const name = '2025 return/Banque états/café résumé.pdf';
  const archive = zip([{ name, bytes: encoder.encode('x') }]);
  const [entry] = readZip(archive);
  assert.equal(entry.name, name, 'the accented name comes back as it went in');
  const view = new DataView(archive.buffer);
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800, 'bit 11 of the local header says the name is UTF-8');
});

test('two files with the same name both survive — an archive never keeps only one', () => {
  const files = [
    { name: 'Bank statements/scan.pdf', bytes: encoder.encode('the first scan') },
    { name: 'Bank statements/scan.pdf', bytes: encoder.encode('the second scan') },
  ];
  const entries = readZip(zip(files));
  assert.equal(entries.length, 2, 'both are in there');
  assert.equal(decoder.decode(entries[0].data), 'the first scan');
  assert.equal(decoder.decode(entries[1].data), 'the second scan');
});

test('what is stored is the file as it is — this compresses nothing and mangles nothing', () => {
  // Bytes that would change under any compressor or any text encoding. Storing means they do not.
  const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x0d, 0x0a, 0x00, 0x1a]);
  const [entry] = readZip(zip([{ name: 'raw.bin', bytes }]));
  assert.deepEqual([...entry.data], [...bytes]);
});
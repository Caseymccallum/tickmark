/**
 * A ZIP writer, small enough to read, with no dependency.
 *
 * The product's rule is that it has no third-party code, and this is the one place that rule is
 * *felt* rather than stated: every library that makes a zip in a browser is a dependency someone has
 * to trust. A request's documents are the most sensitive bytes in the practice, so the thing that
 * gathers them is written here and nowhere else.
 *
 * ## The shape of a ZIP, and why this one stores rather than compresses
 *
 * A ZIP is a run of *local headers* each followed by its bytes, then a *central directory* that
 * indexes them, then one *end of central directory* record. That is all. The format allows each
 * entry to be compressed or stored raw; this writer **stores** (method 0) for three reasons:
 *
 * 1. The documents are PDFs, scans and photos — already-compressed bytes that deflate barely shrinks,
 *    so the saving would not be worth the CPU.
 * 2. Store means the file's bytes go into the archive unchanged, which is the case a test can assert
 *    exactly. A compressor needs its own test vectors and its own bugs.
 * 3. It keeps this file at the size where it can be read in one sitting, which is the property that
 *    makes hand-written format code a reasonable thing to have.
 *
 * What is written is honest: a correct CRC-32 per entry (the checksum an unzipper verifies), correct
 * offsets, and the UTF-8 flag so a client's file keeps its name. An archive from here opens in
 * Explorer, in `unzip`, and in a browser's own download handling.
 *
 * Names may contain `/`, which is how folders appear in a ZIP — there is no separate directory
 * record. That is what lets the request page hand this a path like `Bank statements/oct.pdf` and get
 * a real folder back.
 */

/** The CRC-32 table, built once. The polynomial is the one ZIP mandates (0xEDB88320, reflected). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * The checksum a ZIP carries for every entry, and the one every unzipper checks before it trusts a
 * byte. `crc32` of the ASCII string "123456789" is 0xCBF43926 — the CRC-32 (zlib) check value, which
 * `test/zip.test.js` asserts against Python's and Node's own `crc32` so this implementation is held
 * to the reference rather than to its own idea of a checksum.
 */
export function crc32(bytes) {
  const data = toBytes(bytes);
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Accept a Uint8Array, an ArrayBuffer, or a typed-array view, and give back bytes to write. */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset ?? 0, value.byteLength ?? value.length ?? 0);
}

/**
 * The timestamp a ZIP keeps per entry, in MS-DOS form (no timezone, 2-second resolution). It is
 * cosmetic — the date a file "arrived" is on the request page, where it is a fact — so it is derived
 * from one `Date` for the whole archive and never used to decide anything.
 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Pack entries into one ZIP.
 *
 * `entries` is `[{ name, bytes }]`, where `name` may include folders (`Bank statements/oct.pdf`) and
 * `bytes` is the file as it is — this stores them without compressing. Returns the whole archive as
 * one Uint8Array, ready to hand to a `Blob`.
 *
 * A `date` may be passed to stamp every entry; leaving it out uses now. It exists so tests can be
 * exact about the output rather than about the clock.
 */
export function zip(entries, date = new Date()) {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(date);
  const records = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    const data = toBytes(entry.bytes);
    return { name, data, crc: crc32(data) };
  });

  // Every offset is known before anything is written, because a ZIP is a flat file whose index
  // points forward at numbers that must already be right.
  const localOffsets = [];
  let offset = 0;
  for (const record of records) {
    localOffsets.push(offset);
    offset += 30 + record.name.length + record.data.length;
  }
  let directorySize = 0;
  for (const record of records) directorySize += 46 + record.name.length;
  const directoryOffset = offset;

  const out = new Uint8Array(directoryOffset + directorySize + 22);
  const view = new DataView(out.buffer);

  // The local headers, each immediately followed by its stored bytes.
  records.forEach((record, index) => {
    const at = localOffsets[index];
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true); // version needed to extract: 2.0
    view.setUint16(at + 6, 0x0800, true); // bit 11: the name is UTF-8, not some code page
    view.setUint16(at + 8, 0, true); // method 0 — stored, uncompressed
    view.setUint16(at + 10, stamp.time, true);
    view.setUint16(at + 12, stamp.date, true);
    view.setUint32(at + 14, record.crc, true);
    view.setUint32(at + 18, record.data.length, true); // compressed size (equal: stored)
    view.setUint32(at + 22, record.data.length, true); // uncompressed size
    view.setUint16(at + 26, record.name.length, true);
    view.setUint16(at + 28, 0, true); // no extra field
    out.set(record.name, at + 30);
    out.set(record.data, at + 30 + record.name.length);
  });

  // The central directory: one record per file, carrying the offset of the local header above.
  let at = directoryOffset;
  records.forEach((record, index) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, 0x0800, true); // the same UTF-8 promise
    view.setUint16(at + 10, 0, true); // method 0
    view.setUint16(at + 12, stamp.time, true);
    view.setUint16(at + 14, stamp.date, true);
    view.setUint32(at + 16, record.crc, true);
    view.setUint32(at + 20, record.data.length, true);
    view.setUint32(at + 24, record.data.length, true);
    view.setUint16(at + 28, record.name.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk number
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, localOffsets[index], true);
    out.set(record.name, at + 46);
    at += 46 + record.name.length;
  });

  // The end of the directory, which is what an unzipper reads first to find the rest.
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 4, 0, true); // this disk
  view.setUint16(at + 6, 0, true); // the disk the directory is on
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, directorySize, true);
  view.setUint32(at + 16, directoryOffset, true);
  view.setUint16(at + 20, 0, true); // no archive comment

  return out;
}
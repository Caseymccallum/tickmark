/**
 * The checks a browser can make before a file is encrypted, and before anything leaves the machine.
 *
 * These exist because of a decision the rest of the product makes: **the server never sees the file**, so it
 * cannot look at it. Every competitor in this space answers that by reading the document server-side — "AI
 * agents pre-screen documents as they arrive", in Suralink's words. This cannot, on purpose. What it can do is
 * check the file *in the browser*, where the plaintext already is and where looking at it costs nobody their
 * privacy.
 *
 * Two things are worth catching at the moment a client picks a file, and both are the same shape: a problem the
 * practice would otherwise have to notice later, explain in an email, and ask for again.
 *
 * 1. **A password-protected PDF.** Bank statements arrive locked more often than not — the password is usually
 *    a date of birth or a postcode, and the client does not know it is a problem, because it opens fine on
 *    their machine. The practice gets a file it cannot open and the document goes round the loop again.
 * 2. **The same file twice.** Sending the same statement four times is a named pain in this product's own
 *    research, and the client does not know they have done it.
 *
 * Nothing here blocks an upload. Both are warnings, because the browser's judgement is a heuristic and the
 * client may not be able to do anything about it — a warning that stops somebody sending the only copy they
 * have would be worse than the problem it is trying to prevent.
 */

/** Does a byte array contain an ASCII string? Small, obvious, and no dependency for four lines of work. */
export function containsBytes(bytes, text) {
  const needle = [...text].map((character) => character.charCodeAt(0));
  outer: for (let start = 0; start + needle.length <= bytes.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Whether a PDF is encrypted, judged from the bytes at its two ends.
 *
 * A PDF that is encrypted says so in its trailer dictionary — `/Encrypt n 0 R` — and that entry is **not
 * itself encrypted**, because a reader has to be able to find it before it can decrypt anything. So the marker
 * is plain text in the file, which means it can be found without a PDF parser and without decrypting a byte.
 *
 * Both ends are searched because a PDF can be laid out either way round: normally the trailer is at the end,
 * and in a "linearised" file (optimised for reading over a slow connection) a copy sits at the start. Four
 * kilobytes each way is far more than either marker needs.
 *
 * This is a heuristic and is treated as one. It cannot produce a false negative worth worrying about — a PDF
 * cannot be encrypted without a trailer saying so. It *can* produce a false positive: a document that merely
 * *mentions* `/Encrypt`, such as a bank's own instructions on how to unlock a statement. That is why it warns
 * rather than refuses, and why the wording hedges ("this looks like").
 */
export function looksEncryptedPdf({ name = '', type = '', head, tail }) {
  const isPdf = /\.pdf$/i.test(name) || type === 'application/pdf';
  if (!isPdf) return false;
  return containsBytes(head, '/Encrypt') || containsBytes(tail, '/Encrypt');
}

/**
 * Whether this file looks like one the client has already sent.
 *
 * Compared on **name and size**, both of which this product already shows the client on their own page — the
 * filename because it travels as a header the practice sees, and the size because it is in the record. Adding a
 * hash of the contents would catch more, and it is exactly the thing this product refuses to hold: a hash of a
 * scanned bank statement is a verifier for that statement, and a server that holds one is a server that can be
 * asked to confirm whether a given file is yours. A rule that keeps the server ignorant is worth losing an
 * edge case to.
 *
 * The edge cases it loses: a re-scan of the same page (different bytes, usually a different size) and the same
 * document saved under a new name. Both are rare next to the actual complaint, which is a client pressing send
 * twice on the same file.
 */
export function duplicateOf({ name, size }, alreadySent) {
  return alreadySent.find((sent) => sent.name === name && sent.bytes === size) ?? null;
}

/** The sizes both messages quote, in the units a person reads. Kept here so the two cannot drift. */
export function readableBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Three more checks, of the same shape and the same restraint.
 *
 * The two above catch a file the practice cannot open, or did not need twice. These catch a file that
 * is *there* but will not do the job it was sent for: the scan nobody can read, the PDF that stops
 * halfway, the thumbnail that was never going to show a figure. That is the mechanical half of what a
 * competitor calls "AI document review" — the part that can be judged from a file's own frame rather
 * than from what is inside it.
 *
 * What is deliberately absent is the other half: *semantic* review. "This is a pay stub where a W-2
 * should be." "This ID expired in March." Both need a machine that reads the document, and the only
 * way to have one read it is to hand it over — which is the exact trade this product refuses. So the
 * line is drawn here on purpose. The browser catches what is wrong with the *file*; it never comments
 * on what is inside it. That is a smaller promise than "AI reviews your uploads", and it is one this
 * product can actually keep without reading a client's bank statement.
 */

/** The short side of a photo below which text on a page is rarely readable. A warning, never a rule. */
export const MIN_READABLE_SIDE = 500;

/**
 * Whether a PDF stops before its own end, judged from its last bytes.
 *
 * Every complete PDF closes with the marker `%%EOF` — it is how a reader knows the trailer it just
 * followed was the real one and not a coincidence of the data. A file cut off mid-transfer, or a scan
 * that died halfway, cannot have it: the end was never written. So a missing `%%EOF` at the very end
 * is the one truncation signal the bytes that *are* there cannot fake, and it is read from the last
 * few kilobytes without parsing anything.
 *
 * Warns rather than refuses, and the wording hedges, because some real-world PDFs are followed by a
 * little junk and a client told their only copy is worthless may send nothing at all — which is worse
 * than a missing page the practice can ask for by name.
 */
export function looksTruncatedPdf({ name = '', type = '', tail }) {
  const isPdf = /\.pdf$/i.test(name) || type === 'application/pdf';
  if (!isPdf || !tail) return false;
  // Step back over trailing whitespace and null padding, then look for the marker behind it.
  let end = tail.length;
  while (
    end > 0 &&
    (tail[end - 1] === 0x00 || tail[end - 1] === 0x09 || tail[end - 1] === 0x0a ||
      tail[end - 1] === 0x0d || tail[end - 1] === 0x20)
  ) end -= 1;
  const marker = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  if (end < marker.length) return true;
  for (let i = 0; i < marker.length; i += 1) {
    if (tail[end - marker.length + i] !== marker[i]) return true;
  }
  return false;
}

/**
 * The pixel size of a PNG or a JPEG, read from its header — or null if this is neither, or one whose
 * header this cannot make out.
 *
 * Both formats announce their dimensions near the very start, before any pixel data and well inside
 * the window this reads: a PNG fixes width and height at bytes 16–24; a JPEG's sit in its first `SOF`
 * frame header, found by walking the marker chain. Reading the size is not reading the document — it
 * is closer to reading the label on the envelope than to opening it.
 */
export function imageDimensions(head) {
  if (!head) return null;
  // PNG — 8-byte signature, then IHDR: length (4), "IHDR" (4), width (4), height (4), big-endian.
  if (
    head.length >= 24 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  ) {
    return {
      width: (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19],
      height: (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23],
    };
  }
  // JPEG — SOI, then a chain of segments until a SOF frame header, which carries height then width.
  if (head.length >= 10 && head[0] === 0xff && head[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < head.length) {
      if (head[pos] !== 0xff) { pos += 1; continue; }
      const marker = head[pos + 1];
      if (marker === 0xff) { pos += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
      if (marker === 0xd9) return null; // end of image before any frame header
      const frame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) {
        return {
          height: (head[pos + 5] << 8) | head[pos + 6],
          width: (head[pos + 7] << 8) | head[pos + 8],
        };
      }
      const length = (head[pos + 2] << 8) | head[pos + 3];
      if (length < 2) return null;
      pos += 2 + length;
    }
  }
  return null;
}

/**
 * Whether a photo is too small to read, returning its size so the message can name it.
 *
 * The commonest unusable upload is not the wrong document — it is a photograph of one taken from
 * across the room, or a pasted thumbnail, where every figure is three pixels tall. Pixel size is the
 * honest proxy: a page of text below MIN_READABLE_SIDE on its short side cannot be read by anybody,
 * and saying so needs no judgement about the *contents* at all.
 *
 * Warns rather than refuses, and hedges ("often"), because a small photo of a large-print letter can
 * be perfectly clear and this cannot tell the difference.
 */
export function looksUnreadablySmall({ name = '', type = '', head }) {
  const isImage = /^image\//.test(type) || /\.(jpe?g|png)$/i.test(name);
  if (!isImage) return null;
  const size = imageDimensions(head);
  if (!size) return null;
  const short = Math.min(size.width, size.height);
  return short > 0 && short < MIN_READABLE_SIDE ? size : null;
}

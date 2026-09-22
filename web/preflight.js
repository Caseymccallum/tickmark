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

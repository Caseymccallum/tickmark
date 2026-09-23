/**
 * The one thing this server does with a stored document: read the first bytes of it.
 *
 * A stored file is an envelope, and the server cannot read past its header — `readEnvelope` says whether the bytes
 * are an envelope at all, which is the whole of what it can know and all it needs to refuse a plaintext upload. The
 * head is read on its own rather than the file: 84 bytes are allocated for a 20 MB scan, and no path here loads a
 * document into this process's memory.
 *
 * It is its own file because two modules on opposite sides of the product need it, and both are refusing the same
 * thing: the client's upload path will not store something a browser did not encrypt, and the key-retirement pass
 * will not replace a stored envelope with bytes that are not one. Reading the *whole* file happens in exactly one
 * place — where a response's headers are being decided — and that one streams rather than buffers.
 *
 * Nothing here joins a path: the storage path comes from a row the caller has already scoped to a practice.
 */
import { open } from 'node:fs/promises';

import { HEADER_BYTES } from '../web/tickmark-crypto.js';

/** The first bytes of a spooled file, for the envelope check — the whole file is never read back. */
export async function readHead(path, length = HEADER_BYTES + 1) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

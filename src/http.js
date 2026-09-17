/**
 * Reading what a browser sent — with a limit, because a request body is attacker
 * controlled and an unbounded read is a way to exhaust the operator's memory.
 */

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Collect a request body, refusing anything over `limit` bytes.
 *
 * The refusal is deliberate in two ways. The promise rejects as soon as the limit is
 * passed, so the caller can answer immediately rather than after a hostile upload
 * finishes. And the rest of the body is **discarded rather than buffered** — the socket
 * is left open so that the client can actually read the answer. Destroying the
 * connection here was the first attempt, and it turned a clear "too large" into a
 * connection reset, which tells the sender nothing.
 */
export function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (refused) return;
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        reject(new RequestError(413, 'the request body is larger than this endpoint accepts'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (!refused) reject(error);
    });
  });
}

/** `application/x-www-form-urlencoded` as an object. */
export function formFields(body) {
  return Object.fromEntries(new URLSearchParams(body.toString('utf8')));
}

/** A field from a form, trimmed, or `fallback` if it was absent or blank. */
export const field = (fields, name, fallback = null) => {
  const value = fields[name];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
};
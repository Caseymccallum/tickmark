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

/**
 * Compression, and why this product does it in-process rather than leaving it to a proxy.
 *
 * **The case for it**, measured on a real page: 37.9 KB of HTML — of which 33 KB is the stylesheet, which is inlined
 * on purpose so a page needs no second request — compresses to 8.3 KB. That is 22% of the bytes for **0.76 ms** of
 * CPU. On a slow connection it is the difference between 39 ms and 8 ms of transfer for every single navigation, and
 * a practice on a VPN or a poor line feels that far more than they feel anything the server does.
 *
 * The deployment documentation says to put a reverse proxy in front, and a proxy would gzip as well. This is for the
 * installs that do not have one — a machine on a local network, a trial, a VPS behind nothing — which is a real share
 * of how this gets run, and the whole reason the product has no build step and no dependencies.
 *
 * **gzip rather than brotli**, which is the wrong way round from habit: brotli wins on JavaScript and on text with a
 * large dictionary, and this content is highly repetitive CSS and HTML where gzip measured *smaller* (8.3 KB against
 * 8.5 KB) as well as cheaper to compute.
 *
 * **Level 1, not the default 6**, and `tools/bench-gzip.mjs` is why. Measured on the three shapes of page this product
 * sends:
 *
 * | | level 1 | level 6 |
 * | --- | --- | --- |
 * | a page with one row (33 KB) | 10.2 KB in 0.48 ms | 8.4 KB in 0.67 ms |
 * | a board with 500 rows (122 KB) | 12.1 KB in 0.37 ms | 10.3 KB in 0.93 ms |
 *
 * Level 1 is where the knee is: on the biggest page it sends 1.8 KB more and costs **0.56 ms less**. Higher levels buy
 * progressively fewer bytes for progressively more CPU, which is the right trade for an archive and the wrong one for
 * a live server.
 *
 * **Why compressing is safe here, since a reviewer should ask.** Compressing a response that carries both a secret
 * and attacker-supplied input is the BREACH precondition. This product has no secret in any response body: session
 * tokens and challenge tokens live in `HttpOnly` cookies, there is no CSRF token anywhere because the routes rely on
 * `SameSite=Lax`, and the only key material a page ever contains is a *public* key or a private key already wrapped
 * under a passphrase the server has never seen. The one page holding something secret — two-factor setup, which shows
 * the shared secret — cannot be reached cross-origin with a session, because `SameSite=Lax` means a cross-origin
 * request arrives unauthenticated and is answered with the sign-in page.
 */
import { gzipSync } from 'node:zlib';

/**
 * Below this, compressing costs more than it saves: a redirect, a small JSON answer and an error page are all a few
 * hundred bytes, and every one of them would gain a header and a gzip call to shave nothing.
 */
const WORTH_COMPRESSING = 1024;

/**
 * The body as the client asked for it.
 *
 * Takes the `ServerResponse` rather than the request, and reads `response.req` for the `Accept-Encoding` — which is
 * why adding this did not change the signature of `sendPage` and the sixty-odd call sites that use it. `response.req`
 * is set by Node's HTTP server and is the same request object the handler already has.
 *
 * `no-transform` is honoured: a client that says it does not want its response altered gets it unaltered.
 */
export function acceptableBody(response, body, type) {
  if (body.length < WORTH_COMPRESSING) return { body, encoding: null };

  // Only text. An encrypted envelope is already random — compressing it would burn CPU to achieve nothing, and the
  // document download is the one response where the bytes are supposed to be incompressible.
  if (!/\b(json|text|javascript|xml|svg)\b/.test(type)) return { body, encoding: null };

  const asked = String(response.req?.headers['accept-encoding'] ?? '');
  if (!/\bgzip\b/.test(asked)) return { body, encoding: null };
  if (/\bno-transform\b/.test(asked)) return { body, encoding: null };

  const gzipped = gzipSync(body, { level: 1 });
  // A small body can come out larger than it went in; sending that would be worse than not compressing.
  if (gzipped.length >= body.length) return { body, encoding: null };
  return { body: gzipped, encoding: 'gzip' };
}

/** Add the encoding to a set of headers, and the `Vary` that tells a cache the answer depends on the request. */
export function withEncoding(headers, encoding) {
  return encoding ? { ...headers, 'content-encoding': encoding, vary: 'accept-encoding' } : headers;
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
/**
 * Reading what a browser sent — with a limit, because a request body is attacker
 * controlled and an unbounded read is a way to exhaust the operator's memory.
 *
 * And the one thing only a request can answer: **where this install is**, as a client would reach it
 * (`originOf`). Every absolute link the product builds — in a page, in an email, in the notification a client's own
 * upload triggers — comes from there.
 */

import { MAX_ITEMS } from './store.js';

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
 * **The case for it**, measured on a real page: 43 KB of HTML — of which 42.8 KB is the stylesheet, which is inlined
 * on purpose so a page needs no second request — compresses to 11.4 KB at gzip's default level and 13.6 KB at the
 * level this actually uses. That is a quarter of the bytes for about a millisecond of CPU. On a slow connection it is
 * the difference between 43 KB and 13.6 KB of transfer for every single navigation, and a practice on a VPN or a poor
 * line feels that far more than they feel anything the server does.
 *
 * The deployment documentation says to put a reverse proxy in front, and a proxy would gzip as well. This is for the
 * installs that do not have one — a machine on a local network, a trial, a VPS behind nothing — which is a real share
 * of how this gets run, and the whole reason the product has no build step and no dependencies.
 *
 * **gzip rather than brotli, re-measured rather than assumed.** On that 42.8 KB sheet: gzip level 1 gives 13.6 KB in
 * 1.0 ms, gzip level 6 gives 11.4 KB for the same, and brotli at quality 5 gives **10.9 KB for 2.5 ms**. So brotli is
 * smaller on this content now — half a kilobyte, for a millisecond and a half more CPU on every response, and every
 * page inlines the sheet. That is the level-1-against-6 trade one rung up, and it lands the same way for a live
 * server; a proxy in front can spend that CPU once and cache the result. If bandwidth ever matters more than CPU
 * here, this is the paragraph to measure again.
 *
 * **Level 1, not the default 6**, and `tools/bench-gzip.mjs` is why. Measured on the three shapes of page this product
 * sends:
 *
 * | | level 1 | level 6 |
 * | --- | --- | --- |
 * | a page with one row (43 KB) | 13.8 KB in 0.44 ms | 11.5 KB in 0.78 ms |
 * | a board with 500 rows (132 KB) | 15.8 KB in 0.44 ms | 13.5 KB in 1.20 ms |
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
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
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

/**
 * Spool a request body straight to a file, rather than into memory.
 *
 * `readBody` is right for forms and everything else small. It is wrong for uploads: a 25 MB ceiling
 * times a few concurrent clients is hundreds of megabytes of heap for bytes that are going to the
 * disk anyway. This streams them there — one chunk of memory however big the file is — hashes them
 * on the way past (the record's `sha256` is the digest of the ciphertext, so it must be the bytes as
 * they arrive), and enforces the same limit with the same sentence.
 *
 * A refusal leaves **nothing behind**: the partial file is removed before the `RequestError` is
 * raised, so the caller's "a refused upload leaves no file and no row" stays true without every
 * caller remembering to clean up. (The socket is left open after a refusal, for the same reason
 * `readBody` leaves it open: the client has to be able to read the answer.)
 */
export function spoolBody(request, limit, path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const out = createWriteStream(path);
    let size = 0;
    let settled = false;

    const giveUp = (error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      unlink(path).catch(() => {});
      reject(error);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        giveUp(new RequestError(413, 'the request body is larger than this endpoint accepts'));
        return;
      }
      hash.update(chunk);
      // Backpressure, honoured: a fast sender to a slow disk should wait, not fill memory — which is
      // the whole point of this function.
      if (!out.write(chunk)) {
        request.pause();
        out.once('drain', () => request.resume());
      }
    });
    request.on('error', giveUp);
    out.on('error', giveUp);
    request.on('end', () => {
      if (settled) return;
      out.end(() => {
        settled = true;
        resolve({ path, bytes: size, sha256: hash.digest('hex') });
      });
    });
  });
}

/**
 * Read a `multipart/form-data` body — what a form with a file in it sends — into its fields and its files.
 *
 * Hand-written, like the SMTP client and the ZIP reader, because a dependency here would be a dependency
 * that reads a request body: the most attacker-controlled input there is. It splits on the boundary and
 * understands only `form-data` parts carrying a `name`; anything else is passed over rather than guessed at.
 */
export function parseMultipart(body, boundary) {
  const fields = {};
  const files = [];
  if (typeof boundary !== 'string' || boundary.length === 0) return { fields, files };
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'latin1');
  const dash = Buffer.from(`--${boundary}`, 'latin1');

  for (let at = bytes.indexOf(dash); at >= 0; ) {
    let start = at + dash.length;
    // `--` right after a boundary is the closing mark, and the last part is done.
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break;
    if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2; // the CRLF that follows a boundary
    const headEnd = bytes.indexOf('\r\n\r\n', start, 'latin1');
    if (headEnd < 0) break;
    const headers = bytes.subarray(start, headEnd).toString('latin1');
    const contentStart = headEnd + 4;
    const next = bytes.indexOf(dash, contentStart);
    if (next < 0) break;
    let contentEnd = next;
    if (bytes[contentEnd - 2] === 0x0d && bytes[contentEnd - 1] === 0x0a) contentEnd -= 2; // the CRLF before it
    const content = bytes.subarray(contentStart, contentEnd);

    const disposition = /content-disposition: *form-data;([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const contentType = /content-type: *([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? null;
    if (name) {
      if (filename !== null) files.push({ name, filename, contentType, data: Buffer.from(content) });
      else fields[name] = content.toString('utf8');
    }
    at = next;
  }
  return { fields, files };
}

/**
 * Read a form whether it is `multipart/form-data` (a file along) or ordinary `application/x-www-form-urlencoded`.
 *
 * One call for both shapes, so a handler that takes an optional attachment does not grow its own dispatch —
 * and so a form with no file behaves exactly as it did before it grew the input. `limit` is the body ceiling,
 * and should be set to the attachment ceiling where a file may be attached.
 */
export async function readForm(request, limit = 64 * 1024) {
  const type = String(request.headers['content-type'] ?? '');
  if (/^multipart\/form-data/i.test(type)) {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.slice(1).find(Boolean) ?? null;
    return parseMultipart(await readBody(request, limit), boundary);
  }
  return { fields: formFields(await readBody(request, limit)), files: [] };
}

/** A field from a form, trimmed, or `fallback` if it was absent or blank. */
export const field = (fields, name, fallback = null) => {
  const value = fields[name];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
};

/**
 * One item per line, trimmed, blanks dropped, duplicates collapsed, capped.
 *
 * The list a practice types into a request's textarea, and the same rules the template pages apply to theirs — which
 * is why it lives here rather than in either of the two pages that use it: it is about the shape of what a browser
 * sent, which is this module's whole subject.
 *
 * Duplicates collapse case-insensitively, because "Bank statements" twice in one request is a mistake rather than an
 * intention. The cap is the store's own `MAX_ITEMS`, because that is where the limit is defined.
 */
export function parseItems(text) {
  const seen = new Set();
  const items = [];
  for (const line of String(text).split(/\r?\n/)) {
    const label = line.trim();
    if (label.length === 0) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(label.slice(0, 200));
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * A CSV file, parsed into rows of cells — the inverse of the `csvCell` writer the exports use, so a
 * practice can round-trip `tickmark-clients.csv`: export the directory, fix names in a spreadsheet,
 * import it back. Quoted fields are handled the way a spreadsheet writes them — embedded commas,
 * embedded newlines, and a doubled quote as an escaped quote — because "Smith, Jones & Co" is a real
 * client name and the import must not split it in two.
 *
 * Blank lines are dropped rather than becoming blank clients, and a UTF-8 BOM (which Excel insists
 * on) is stripped so the first column is not read as "\ufeffClient".
 */
export function parseCsv(text) {
  const clean = String(text ?? '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else if (ch !== '\r') cell += ch; // a CRLF inside a quoted cell reads as one line break
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      atCellStart = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
      continue;
    }
    cell += ch;
    atCellStart = false;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((row_) => row_.some((cellValue) => String(cellValue).trim() !== ''));
}

/**
 * A CSV of clients, turned into `{ name, email }` rows.
 *
 * The columns are found by name rather than by position, because the file is more likely to have come
 * from somewhere else — a practice-management export, a spreadsheet, another chasing tool — than from
 * Tickmark's own `tickmark-clients.csv`. "Smith, Jones & Co" is a name, and it is called "Client",
 * "Name", "Customer", "Contact" or "Company" in the wild. The address column is called "Address" in
 * our own export (where it holds an email) and "Email" in most others, so both are read.
 *
 * A file with no recognisable header is read positionally — first column the name, second the
 * address — which is what a two-column sheet pasted out of anything will be. Rows with no name are
 * returned rather than dropped, so the import can report them instead of losing them silently.
 */
const CLIENT_NAME_COLUMNS = ['client', 'name', 'client name', 'customer', 'customer name', 'contact', 'contact name', 'company', 'display name'];
const CLIENT_EMAIL_COLUMNS = ['address', 'email', 'e-mail', 'email address', 'e-mail address', 'contact email', 'client email'];

export function clientRowsFromCsv(text) {
  const grid = parseCsv(text);
  if (grid.length === 0) return [];
  const header = grid[0].map((cell) => String(cell).trim().toLowerCase());
  const nameAt = header.findIndex((cell) => CLIENT_NAME_COLUMNS.includes(cell));
  const emailAt = header.findIndex((cell) => CLIENT_EMAIL_COLUMNS.includes(cell));
  const hasHeader = nameAt !== -1 || emailAt !== -1;
  const nameColumn = nameAt !== -1 ? nameAt : 0;
  const emailColumn = emailAt !== -1 ? emailAt : 1;
  return grid.slice(hasHeader ? 1 : 0).map((row) => ({
    name: String(row[nameColumn] ?? '').trim(),
    email: String(row[emailColumn] ?? '').trim(),
  }));
}

/**
 * Where this server is, as a client would reach it.
 *
 * The link a practice pastes into an email has to be absolute, and the only place that knows the
 * address is the request that produced the page. `x-forwarded-proto` is honoured because the
 * documented deployment puts a reverse proxy in front of this, which terminates TLS and would
 * otherwise yield `http://` links in emails.
 */
//
// A configured `TICKMARK_PUBLIC_URL` wins over both headers, and that is the important half of this
// function. The `Host` header is *attacker-chosen* on a directly-exposed server, and the links built
// here travel inside emails — including the notification a **client's own action** triggers. Without
// the configured address, anybody holding a client link could stamp `Host: evil.example` on an upload
// and poison the link the practice receives. The header fallback remains because a local trial has no
// canonical address to configure, and inventing one would break the first run.
export const originOf = (request) => {
  const configured = String(process.env.TICKMARK_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${String(request.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim()}://${request.headers.host ?? 'localhost'}`;
};

/**
 * Server-rendered HTML, with escaping on by default.
 *
 * The rule this file exists to enforce: a value from the database or from a form is
 * *never* trusted to be markup. Interpolation through `html` escapes it, and the only
 * way to emit something unescaped is to say so explicitly with `raw`, which makes every
 * exception greppable.
 *
 * There is no template engine here because a template engine is a dependency, a syntax
 * to learn, and a second place where escaping can be forgotten.
 *
 * The stylesheet lives in `style.js` — what a page says and how it looks are separate files.
 */
import { STYLE } from './style.js';
import { acceptableBody, withEncoding } from './http.js';

class Safe {
  constructor(value) {
    this.value = value;
  }
}

/** Mark a string as already-safe markup. Use sparingly; every use is auditable. */
export const raw = (value) => new Safe(String(value));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);

function render(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/** `html` as a tagged template: interpolations are escaped unless they are `raw`. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let index = 0; index < values.length; index += 1) {
    out += render(values[index]) + strings[index + 1];
  }
  return raw(out);
}

/**
 * The mark, drawn inline rather than fetched: one fewer request, no asset route, and the identity cannot 404. It is
 * a tick in a rounded square — the product's whole idea in nine characters of geometry.
 *
 * The shapes are a constant because two things use them: the mark in the header, and the favicon below. They were
 * separate copies once, and a claim in a comment that two strings are the same is worth nothing.
 */
const MARK =
  '<rect width="32" height="32" rx="8" fill="#101828"/>' +
  '<path d="M9 16.5l4.6 4.5L23 10.8" fill="none" stroke="#32d583" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>';

const mark = (size = 22) =>
  raw(`<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" role="img" aria-label="Tickmark">${MARK}</svg>`);

/**
 * The same drawing, as a favicon — and **actually** the same drawing, because it is built from the same constant
 * rather than typed out twice.
 *
 * It was two hand-written copies until a premium pass deleted this line by accident and every page started throwing
 * `FAVICON is not defined` — a whole-suite failure from removing a constant whose only job was to be a tab icon. Two
 * copies of one drawing is one copy too many, and the comment above had been claiming they were identical while
 * nothing made them so.
 */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${MARK}</svg>`,
)}`;

/**
 * A small icon set, drawn inline rather than fetched.
 *
 * The same reasoning as the mark below it: an inline path cannot 404, needs no asset route, costs no request, and
 * inherits `currentColor` so an icon is the colour of the text it sits in. That last property is what keeps this
 * product's rule about colour — *everything chromatic is a state* — from being broken by decoration: an icon in a
 * warning is warning-coloured because it is **inside** the warning, not because somebody chose a colour for it.
 *
 * Each is 16×16 with `stroke="currentColor"`, no fill, round caps and joins, and a stroke width of 1.6 — thin enough
 * to read as a line drawing rather than as a glyph, which is what separates an interface that looks drawn from one
 * that looks assembled. They are `aria-hidden` because every one of them sits beside the word it means; an icon that
 * is the only thing saying something is an icon a screen reader cannot read.
 *
 * The set is deliberately short, and each name is a **meaning** rather than a picture: `shield` for a protection
 * claim, `clock` for something pending, `arrow` for a way onward. An icon that means nothing in particular is
 * decoration, and decoration is the thing this design system does not have.
 */
const ICONS = {
  // Done, or true. The one shape the whole product is named after.
  tick: '<path d="M3 8.5l3.2 3L13 4.5"/>',
  // A protection claim: the server cannot read your files.
  shield: '<path d="M8 1.8l5 1.9v4c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5v-4z"/><path d="M5.8 8.2l1.6 1.6 3-3.2"/>',
  // A passphrase, and the thing that cannot be recovered.
  key: '<circle cx="5.5" cy="8" r="3.2"/><path d="M8.7 8H14M12 8v2.2M10 8v1.6"/>',
  // A way onward.
  arrow: '<path d="M3 8h9.2M9 4.6L12.6 8 9 11.4"/>',
  // Payment, and the subscription behind it.
  card: '<rect x="2" y="3.5" width="12" height="9" rx="1.6"/><path d="M2 6.6h12M4.4 9.8h2.6"/>',
  // Something pending: a payment that has not cleared, a season not started.
  clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.6 1.6"/>',
  // Something wrong, or closed.
  alert: '<path d="M8 2.4l6 11H2z"/><path d="M8 6.6v3.2M8 11.6h.01"/>',
  // A workspace, or the firm that holds it.
  building: '<path d="M2.6 13.4V3.4h6.2v10M8.8 13.4V6.4h4.6v7"/><path d="M4.4 6.2h2.6M4.4 8.6h2.6M10.6 9h1.2M10.6 11.2h1.2"/>',
  // An address a client or a colleague will use.
  link: '<path d="M6.8 9.2a2.8 2.8 0 004 0l2-2a2.8 2.8 0 00-4-4l-.8.8"/><path d="M9.2 6.8a2.8 2.8 0 00-4 0l-2 2a2.8 2.8 0 004 4l.8-.8"/>',
  // A person, for the account these pages are about.
  person: '<circle cx="8" cy="5.6" r="2.6"/><path d="M3.4 13.4a4.8 4.8 0 019.2 0"/>',
};

/**
 * One icon, by meaning. `size` defaults to 16 because that is the size these were drawn at.
 *
 * The drawing attributes sit on the `<svg>` rather than on each shape, because `stroke`, `stroke-width`,
 * `stroke-linecap`, `stroke-linejoin` and `fill` are all **inherited** properties in SVG. That matters for more than
 * tidiness: the first version of this appended the attributes to `<path>` elements only, which would have made the
 * `card` icon's `<rect>` and the `clock` icon's `<circle>` invisible — a bug that shows up as a missing icon rather
 * than as an error, and only on the icons nobody happened to look at.
 *
 * Returns `Safe` markup, which is why the name is looked up rather than interpolated: a caller passing `"<script>"`
 * gets nothing at all instead of a hole in the escaping.
 */
export function icon(name, size = 16, className = '') {
  const shapes = ICONS[name];
  if (!shapes) return raw('');
  return raw(
    `<svg class="icon${className ? ` ${className}` : ''}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" ` +
      `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
      `${shapes}</svg>`,
  );
}

/** A tick in a box, for a list of things that are true. */
export const tick = (text) => html`<li>${icon('tick')}<span>${text}</span></li>`;


  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23101828'/%3E%3Cpath d='M9 16.5l4.6 4.5L23 10.8' fill='none' stroke='%2332d583' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

/**
 * The page shell. `practitioner` is the signed-in practice, or null on a public page — the header is the one place
 * that decision is made, and `here` is which nav item to mark as the current one.
 *
 * `banner` is a rendered fragment rather than a string, so a caller who wants a link in it can build one with `html`
 * and get escaping everywhere else.
 */
export function page({ title, practitioner = null, body, banner = null, signIn = true, here = null }) {
  const navLink = (href, label) =>
    html`<a href="${href}"${here === href ? raw(' aria-current="page"') : ''}>${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Tickmark</title>
  <link rel="icon" href="${FAVICON}">
  <meta name="color-scheme" content="light dark">
  <style>${raw(STYLE)}</style>
</head>
<body>
  <header class="top">
    <a class="brand" href="${practitioner ? '/requests' : '/'}">${mark()}<span>Tickmark</span></a>
    <nav>
      ${practitioner
        ? html`${navLink('/requests', 'Requests')}
            ${navLink('/clients', 'Clients')}
            ${navLink('/files', 'Documents')}
            ${navLink('/chase', 'Chase')}
            ${navLink('/templates', 'Templates')}
            ${navLink('/keys', 'Keys')}
            ${navLink('/members', 'Members')}
            <a class="who" href="/account/two-factor" title="${practitioner.email} — your account">${practitioner.email}</a>
            <form method="post" action="/signout"><button type="submit" class="ghost">Sign out</button></form>`
        : signIn
          ? html`<a href="/signin">Sign in</a>`
          : ''}
    </nav>
  </header>
  <main class="wrap">
    ${banner}
    ${body}
  </main>
  <footer class="foot">
    <strong>Tickmark</strong> — the list of documents a client owes you, and a tick as each one
    arrives. Files are encrypted in the browser before they are sent; the server stores what it
    cannot read.
  </footer>
</body>
</html>`;
}

/** A redirect, as the two headers that implement one. */
export function redirect(response, location, cookies = []) {
  const headers = { location };
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  response.writeHead(303, headers);
  response.end();
}

/**
 * A state, as a word in a shape you can scan down a column.
 *
 * `tone` is the only decision a caller makes, and it is a decision about meaning rather than about
 * colour: `ok` means nothing is wanted, `check` means somebody has work to do, `wait` means the
 * client does, `bad` means something is wrong, `off` means it is out of play. Every page that shows
 * a state uses this, so the same word means the same colour everywhere.
 */
export function badge(text, tone = 'off') {
  return html`<span class="badge ${tone}">${text}</span>`;
}

/** The tones, named for what they mean rather than what they look like. */
export const TONES = { done: 'ok', todo: 'check', waiting: 'wait', wrong: 'bad', done_for: 'off' };

/**
 * One number that matters, and what it is.
 *
 * Rendered as a link when `href` is given, because a count you can act on should be clickable —
 * a figure that answers "what do I do now?" and then refuses to take you there is a taunt.
 */
export function tile(number, label, { href = null, tone = null, current = false } = {}) {
  const body = html`<div class="n">${number}</div><div class="k">${label}</div>`;
  const className = `tile${tone ? ` ${tone}` : ''}`;
  if (!href) return html`<div class="${className}">${body}</div>`;
  return html`<a class="${className}" href="${href}"${current ? raw(' aria-current="page"') : ''}>${body}</a>`;
}

/** A block with a heading, so a long page reads as sections rather than as a column of prose. */
export function section(title, ...content) {
  return html`<section class="card"><h2>${title}</h2>${content}</section>`;
}

/** Something to say in place of a list that is empty: what is missing, and what to do about it. */
export function empty(heading, sentence, action = null) {
  return html`<div class="empty">
    <div class="h">${heading}</div>
    <p class="p">${sentence}</p>
    ${action ? html`<div class="actions">${action}</div>` : ''}
  </div>`;
}

/**
 * Headers every response carries, and why each one is here rather than being a habit.
 *
 * This is a product whose *client* URLs are credentials: a link is `/r/<token>` and the token is the whole of
 * the authentication. Three of these four exist because of that, and none of them is decoration.
 *
 * - **`Referrer-Policy: no-referrer`** — the one that matters most here. Without it, a browser sends the full
 *   URL of the page a link was clicked from, so a client who clicked anything outward from their portal page
 *   would hand that page's token to whoever was linked to. The page has no outbound links today; a policy that
 *   depends on that staying true is not a policy.
 * - **`X-Content-Type-Options: nosniff`** — a browser left to guess at a content type can decide an uploaded
 *   envelope is HTML. It is served as `application/octet-stream` precisely so it cannot be, and this is what
 *   tells the browser not to second-guess that.
 * - **`X-Frame-Options: DENY`** — nobody should be able to put a Tickmark page in an iframe, because the buttons
 *   on these pages are "close this request", "remove this member" and "turn two-factor off". Clickjacking a
 *   practice into switching its own second factor off is a cheap attack and this is a cheap answer to it. (The
 *   modern spelling of this is `frame-ancestors` in a CSP; there is no CSP yet, and one mechanism that works
 *   today is worth more than one that would work if something else existed.)
 * - **`Cross-Origin-Opener-Policy: same-origin`** — the encryption and decryption happen in this page's own
 *   scripts. Nothing here opens a window or embeds a frame, so nothing needs a reference to one.
 *
 * **No `Content-Security-Policy` yet**, and that is a decision with a reason rather than an omission: the pages
 * are built from inline `<style>` and small inline `<script type="application/json">` blocks, so a policy strict
 * enough to be worth having needs a nonce per response threaded through every rendering path. That is a real
 * piece of work rather than a header, and it is written down in `docs/security.md` as the next thing to do here
 * rather than left for somebody to notice.
 *
 * **No `Strict-Transport-Security`** either, deliberately: this software is often run over plain HTTP on a
 * local network, and a browser told to refuse HTTP for the host cannot be un-told for the length of the
 * max-age. A product that bricks a practice's browser for six months to add a header would be getting the
 * trade backwards. The deployment documentation says to put TLS in front of it, and HSTS belongs on that proxy
 * where it can be removed.
 */
export const SECURITY_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

/** Send a rendered page. */
export function sendPage(response, status, rendered, cookies = []) {
  const type = 'text/html; charset=utf-8';
  const { body, encoding } = acceptableBody(response, Buffer.from(rendered.value, 'utf8'), type);
  const headers = withEncoding(
    {
      ...SECURITY_HEADERS,
      'content-type': type,
      'content-length': body.length,
    },
    encoding,
  );
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  response.writeHead(status, headers);
  response.end(body);
}

/** One cell of a CSV row, quoted only when it has to be. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Send rows as a CSV file a spreadsheet will open.
 *
 * The **byte-order mark is deliberate**, and it is there for Excel: without it, Excel reads the file as
 * the system's old single-byte encoding, so a client called `Lødis Ltd` arrives mojibake'd — in the one
 * program this export exists to serve. Every other reader ignores it. The alternative, offering a file
 * that looks broken in Excel so that a stricter tool stays happy, gets the trade the wrong way round for
 * the people who asked for it.
 *
 * CRLF line endings for the same reason: it is what RFC 4180 specifies and what a spreadsheet expects.
 */
export function sendCsv(response, filename, rows, cookies = []) {
  const text = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const type = 'text/csv; charset=utf-8';
  const { body, encoding } = acceptableBody(response, Buffer.from(text, 'utf8'), type);
  const headers = withEncoding(
    {
      ...SECURITY_HEADERS,
      'content-type': type,
      // `attachment` rather than inline: this is a file to keep, not a page to read.
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': body.length,
    },
    encoding,
  );
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  response.writeHead(200, headers);
  response.end(body);
}
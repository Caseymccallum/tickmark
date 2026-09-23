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
 * The page shell. `practitioner` is the signed-in practice, or null on a public page — the header
 * is the one place that decision is made.
 *
 * `banner` is a rendered fragment rather than a string, so that a caller who wants a link in it can
 * build one with `html` and get escaping everywhere else.
 *
 * The mark is drawn inline rather than fetched: one fewer request, no asset route, and the identity
 * cannot 404. It is a tick in a rounded square — the product's whole idea in nine characters of
 * geometry — and the same drawing, url-encoded, is the favicon.
 */
const mark = (size = 22) => raw(`<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" role="img" aria-label="Tickmark">
  <rect width="32" height="32" rx="8" fill="#101828"/>
  <path d="M9 16.5l4.6 4.5L23 10.8" fill="none" stroke="#32d583" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23101828'/%3E%3Cpath d='M9 16.5l4.6 4.5L23 10.8' fill='none' stroke='%2332d583' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

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

/** Send a rendered page. */
export function sendPage(response, status, rendered, cookies = []) {
  const body = rendered.value;
  const headers = { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) };
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
  const body = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  response.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    // `attachment` rather than inline: this is a file to keep, not a page to read.
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(body),
    ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
  });
  response.end(body);
}
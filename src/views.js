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
import { randomBytes } from 'node:crypto';

import { STYLE } from './style.js';
import { acceptableBody, withEncoding } from './http.js';

class Safe {
  constructor(value) {
    this.value = value;
  }
}

/** Mark a string as already-safe markup. Use sparingly; every use is auditable. */
export const raw = (value) => new Safe(String(value));

/**
 * Where the per-response CSP nonce goes, and how it gets there.
 *
 * The value is minted and stamped in `sendPage` — the one seam every page already passes through —
 * rather than threaded through sixty render sites, which is how nonces get forgotten. The
 * placeholder is only ever replaced **as a whole attribute** (`nonce="{{nonce}}"` → `nonce="…"`),
 * and every occurrence of that exact attribute text is one this file wrote: user content cannot
 * forge it, because escaping turns any quote in user text into `&quot;` long before the stamp runs.
 */
export const NONCE_PLACEHOLDER = 'nonce="{{nonce}}"';

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
 * Data for the browser to read, inside a script element.
 *
 * The one sequence that can end a script element early is escaped, which is the whole of the
 * rule for putting JSON in HTML. Everything else is left alone so that the JSON is still valid
 * JSON — and a JSON parser does not care whether `<` arrived as an escape.
 */
export const jsonTag = (id, value) =>
  html`<script type="application/json" id="${id}">${raw(JSON.stringify(value).replace(/</g, '\\u003c'))}</script>`;



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

/**
 * The page shell. Three kinds of visitor get three different headers, and the header is the one place that decision
 * is made:
 *
 * - **`practitioner`** — somebody inside a practice. The full nav.
 * - **`account`** — somebody signed in to the *platform* but not yet inside a practice, which in hosted mode is every
 *   page of the gateway: the dashboard, the billing wall, the error pages. They get their account and a way out.
 * - **neither** — a stranger. A link to sign in, unless the page is the sign-in page itself (`signIn: false`), because
 *   a link to where you already are is noise.
 *
 * The `account` case was missing until the portal was audited for navigation, and its absence was visible: the
 * dashboard offered **"Sign in"** to somebody who was already signed in, and the billing wall — the page a locked-out
 * practice sees — had **no way back to their account and no way to sign out at all**. A page you cannot leave except
 * with the Back button is a page that feels broken.
 *
 * `banner` is a rendered fragment rather than a string, so a caller who wants a link in it can build one with `html`
 * and get escaping everywhere else.
 */
export function page({
  title,
  practitioner = null,
  account = null,
  body,
  banner = null,
  signIn = true,
  here = null,
}) {
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
  <style ${raw(NONCE_PLACEHOLDER)}>${raw(STYLE)}</style>
</head>
<body>
  <header class="top">
    <a class="brand" href="${practitioner ? '/requests' : account ? '/dashboard' : '/'}">${mark()}<span>Tickmark</span></a>
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
        : account
          ? html`${navLink('/dashboard', 'Your account')}
              <span class="who" title="${account.email}">${account.email}</span>
              <form method="post" action="/logout"><button type="submit" class="ghost">Sign out</button></form>`
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
  <script ${raw(NONCE_PLACEHOLDER)}>for (const el of document.querySelectorAll('[data-select-on-click]')) el.addEventListener('click', () => { el.focus(); el.select(); });</script>
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
 *   policy now says `frame-ancestors 'none'` as well; the header stays for the browsers that predate it —
 *   one mechanism that works everywhere beats one that works only where things are new.)
 * - **`Cross-Origin-Opener-Policy: same-origin`** — the encryption and decryption happen in this page's own
 *   scripts. Nothing here opens a window or embeds a frame, so nothing needs a reference to one.
 *
 * **A `Content-Security-Policy`**, and this is the whole of it: `default-src 'none'` with a per-response
 *   nonce blessing the one inline `<style>` block and the one inline script, `script-src 'self'` for the
 *   browser-side modules under `/assets`, `img-src 'self' data:` for the data-URI favicon, `connect-src`
 *   'self' for the fetches those modules make, `base-uri 'none'`, `form-action 'self'`, and
 *   `frame-ancestors 'none'`. No `unsafe-inline` anywhere — a policy containing it would be decoration.
 *   The nonce is minted and stamped in `sendPage` (see `NONCE_PLACEHOLDER`), which is why nothing in
 *   the rendering path has to remember it. The two things a nonce cannot bless — inline `style="…"`
 *   attributes and inline `on…=` handlers — do not exist anywhere in the product: the widths are
 *   classes in `src/style.js`, and "click selects this field" is one nonced script plus a data
 *   attribute. `tools/check-pages.mjs` refuses a rendered page that reintroduces either.
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

/**
 * What the policy allows, and nothing else. One function because the nonce is per response — a
 * constant here would be a nonce shared by every visitor, which is a nonce that means nothing.
 */
const policyWith = (nonce) =>
  `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
  `img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

/** Send a rendered page. */
export function sendPage(response, status, rendered, cookies = []) {
  const type = 'text/html; charset=utf-8';
  // Minted here and stamped into both the header and the page, because this is the one place every
  // page passes through. Threading a nonce through sixty render sites is how a nonce gets forgotten
  // in the sixty-first — and an un-stamped `nonce="{{nonce}}"` is a page whose styling the browser
  // silently throws away.
  const nonce = randomBytes(16).toString('base64url');
  const stamped = rendered.value.replaceAll(NONCE_PLACEHOLDER, `nonce="${nonce}"`);
  const { body, encoding } = acceptableBody(response, Buffer.from(stamped, 'utf8'), type);
  const headers = withEncoding(
    {
      ...SECURITY_HEADERS,
      'content-security-policy': policyWith(nonce),
      'content-type': type,
      'content-length': body.length,
    },
    encoding,
  );
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  response.writeHead(status, headers);
  response.end(body);
}

/**
 * One cell of a CSV row, quoted only when it has to be — and neutralised when it begins like a formula.
 *
 * **The apostrophe is a guard, not punctuation.** A cell whose text starts with `=`, `+`, `-`, `@` (or a
 * tab/CR) is read by Excel and friends as a formula, and several columns in these exports are chosen by
 * somebody *outside* the practice: a client's name, the filename on a client's upload, the note they left
 * beside it. A file called `=cmd|'/C calc'!A0` would otherwise execute when a bookkeeper opens the CSV —
 * the classic CSV-injection. Prefixing one apostrophe forces text interpretation in every spreadsheet,
 * and is invisible in the cell itself. (RFC 4180 says nothing about this; OWASP's CSV-injection
 * guidance is where the rule comes from.)
 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
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

/**
 * A JSON answer, for the routes that a script talks to rather than a person: the client's two uploads, the health
 * check CI polls, the counts on the keys page, and the invitation endpoints.
 *
 * Compressed and Content-Security-Policied like every other response, because the headers ride on every response
 * type — `acceptableBody` does the encoding negotiation here exactly as `sendPage` does it, and a JSON response that
 * skipped it would be the one un-compressed answer on the site.
 */
export function sendJson(response, status, value) {
  const type = 'application/json';
  const { body, encoding } = acceptableBody(response, Buffer.from(JSON.stringify(value), 'utf8'), type);
  response.writeHead(status, withEncoding({ ...SECURITY_HEADERS, 'content-type': type, 'content-length': body.length }, encoding));
  response.end(body);
}

/**
 * The page a refusal gets.
 *
 * **Errors are pages, not stack traces** — the habit `src/app.js` states at the top of itself: an unexpected failure
 * is logged for the operator and answered with a sentence, because a stack trace in a browser is information for an
 * attacker and nothing for a user. Every handler that refuses something answers through here, which is what keeps
 * that true by construction rather than by remembering.
 */
export function fail(response, status, message, practitioner = null, extra = null) {
  sendPage(
    response,
    status,
    page({
      title: status === 404 ? 'Not found' : 'That did not work',
      practitioner,
      body: html`<h1>${status === 404 ? 'Not found' : 'That did not work'}</h1>
        <p>${message}</p>
        ${extra}
        <p><a href="/">Back to the start</a></p>`,
    }),
  );
}

/**
 * Send a signed-out visitor to the sign-in page. Returns true if the handler may continue.
 *
 * The guard every signed-in page opens with, and it lives here rather than in `src/auth.js` because what it does is
 * answer a request — it redirects — and `auth.js` knows nothing about responses. Both halves of the idiom are load
 * bearing: the boolean is what a handler checks, and no handler keeps its own copy of the sentence.
 */
export function requireSignIn({ practitioner, response }) {
  if (practitioner) return true;
  redirect(response, '/signin');
  return false;
}

/**
 * What each request state is called on a screen.
 *
 * "Ready to work on" is the word the research uses and the word a practice would use. The other three are **whose
 * turn it is**, because that is the question the list exists to answer — and each of the three names a different
 * job: "files to check" is material nobody has opened, "waiting on the client" is nothing to do but wait, and
 * "the client answered" is a decision somebody owes them.
 */
export const REQUEST_STATE_WORDS = {
  ready: 'ready to work on',
  'to-check': 'files to check',
  // Parallel to "waiting on the client", because the two are the same sentence from opposite sides: this one means
  // the client has replied and the practice owes them an answer.
  answered: 'the client answered',
  waiting: 'waiting on the client',
};

/**
 * Which of the three colours a request state is.
 *
 * One function rather than the same ternary in four places, which is what it was until `answered` arrived and had to
 * be added to each of them — a state that renders in the wrong colour in one place is worse than one that is
 * missing, because it looks like it has been considered.
 */
export const stateTone = (state) => (state === 'ready'
  ? TONES.done
  : state === 'to-check' || state === 'answered'
    ? TONES.todo
    : TONES.waiting);

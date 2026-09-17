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
 */

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

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 2.5rem auto; padding: 0 1.25rem; }
  header { display: flex; align-items: baseline; gap: 1rem; border-bottom: 1px solid #8884; padding-bottom: .75rem; margin-bottom: 1.5rem; }
  header .name { font-weight: 700; font-size: 1.15rem; }
  header nav { margin-left: auto; display: flex; gap: 1rem; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin: 1rem 0 .25rem; }
  input, textarea { width: 100%; box-sizing: border-box; font: inherit; padding: .5rem .6rem; }
  button { font: inherit; padding: .5rem 1rem; margin-top: 1.25rem; cursor: pointer; }
  .note { color: #666; }
  form.inline { display: inline; }
  form.inline input { width: auto; min-width: 12rem; font-size: .9rem; }
  form.inline button { margin-top: 0; padding: .15rem .5rem; font-size: .9rem; }
  td form.inline { margin-right: .25rem; }
  .file { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .file .name { font-weight: 600; }
  .unlock { border: 1px solid #8884; padding: .75rem 1rem; margin: 1rem 0; border-radius: .25rem; }
  .unlock input { display: inline-block; width: auto; min-width: 16rem; }
  .unlock button { margin-top: 0; }
  button[disabled] { opacity: .5; cursor: default; }
  .error { border-left: 3px solid #b91c1c; background: #fef2f2; color: #7f1d1d; padding: .6rem .9rem; }
  .warning { border-left: 3px solid #b45309; background: #fffbeb; color: #713f12; padding: .6rem .9rem; }
  code { background: #8882; padding: .1rem .3rem; border-radius: .2rem; }
`;

/**
 * The page shell. `practitioner` is the signed-in practice, or null on a public page —
 * the header is the one place that decision is made.
 *
 * `banner` is a rendered fragment rather than a string, so that a caller who wants a link
 * in it can build one with `html` and get escaping everywhere else.
 */
export function page({ title, practitioner = null, body, banner = null }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Tickmark</title>
  <style>${raw(STYLE)}</style>
</head>
<body>
  <header>
    <span class="name">Tickmark</span>
    <nav>
      ${practitioner
        ? html`<span class="note">${practitioner.email}</span>
            <a href="/requests">Requests</a>
            <a href="/keys">Keys</a>
            <form method="post" action="/signout"><button type="submit">Sign out</button></form>`
        : html`<a href="/signin">Sign in</a>`}
    </nav>
  </header>
  ${banner}
  ${body}
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

/** Send a rendered page. */
export function sendPage(response, status, rendered, cookies = []) {
  const body = rendered.value;
  const headers = { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) };
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  response.writeHead(status, headers);
  response.end(body);
}
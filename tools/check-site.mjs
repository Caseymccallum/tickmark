/**
 * Structural sanity check for the landing page.
 *
 * Same purpose as tools/check-pages.mjs but for a page the app does not serve: `site/index.html` is
 * standalone and opened directly, so nothing else in the repository would notice if a tag were left open or
 * an entity mistyped. It is a marketing page that makes claims about the code, so a broken one is worse than
 * no page at all.
 */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const count = (pattern, text = html) => (text.match(pattern) ?? []).length;
const problems = [];

// Tags that must balance. Void elements (br, input, link, meta, img, hr) are excluded because they never close.
for (const tag of ['html', 'head', 'body', 'header', 'nav', 'section', 'div', 'p', 'ul', 'li', 'details', 'form', 'footer', 'pre', 'code', 'svg', 'svg', 'strong', 'em', 'blockquote', 'cite', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'button', 'h1', 'h2', 'h3', 'h4']) {
  const open = count(new RegExp(`<${tag}[\\s>]`, 'g'));
  const close = count(new RegExp(`</${tag}>`, 'g'));
  if (open !== close) problems.push(`<${tag}> opens ${open}, closes ${close}`);
}

if (!/^<!doctype html>/i.test(html.trim())) problems.push('no doctype');
if (!html.trim().endsWith('</html>')) problems.push('does not end with </html>');
if (/undefined|\[object Object\]/.test(html)) problems.push('an undefined or stringified object leaked into the page');
if (/&[a-z]+[^;\s]/.test(html.replace(/&[a-z]+;/g, '').replace(/&[a-z]+ /g, ' '))) problems.push('unterminated HTML entity');

// The stylesheet must be one block, and every rule in it must actually close. A brace *count* is not enough:
// an unclosed rule swallows every rule after it, so the counts balance while whole sections stop applying and
// nothing anywhere reports an error. This walks the blocks in order, the way a parser would.
const walk = (css) => {
  let depth = 0;
  let buffer = '';
  const top = [];
  for (const character of css) {
    if (character === '{') {
      if (depth === 0) top.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth < 0) return { top, depth, broken: true };
      buffer = '';
    } else if (depth === 0) {
      buffer += character;
    }
  }
  return { top, depth, broken: false };
};

if (count(/<style>/g) !== count(/<\/style>/g)) problems.push('a <style> block is not closed');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const { top, depth, broken } = walk(css);
if (broken) problems.push('the CSS closes a block that was never opened — everything after it is being mis-parsed');
if (depth !== 0) problems.push(`the CSS ends with ${depth} block(s) still open, so every rule after that point is being swallowed`);
for (const rule of ['.grid', '.grid.two', '.grid.three', '.plan', '.foot .cols']) {
  if (!top.includes(rule)) problems.push(`${rule} is no longer a top-level rule, so it is not applying`);
}

// A feature grid fixed at three columns needs a multiple of three items, or the last row is an orphan and the
// section reads as unfinished. This is the mistake that was in the first version of the page: seven cards.
const featureCards = count(/<div class="card lift">/g);
if (featureCards % 3 !== 0) {
  problems.push(`the three-column card grid has ${featureCards} cards, which is not a multiple of three — the last row will be short`);
}

// `.narrow` is a *centred* reading column, so it is only correct for a block whose text is meant to be
// centred — the closing call to action. Using it for a section heading puts the heading in the middle of the
// page above left-aligned content, and the two look like separate sections. That is what it was doing above
// the FAQ, so the rule is now asserted rather than remembered.
for (const [index, line] of html.split(/\r?\n/).entries()) {
  if (line.includes('class="narrow') && !line.includes('text-align:center')) {
    problems.push(`line ${index + 1}: .narrow centres its contents, so it needs text-align:center — use .band-head for a left-aligned section heading`);
  }
}

// The page must make no third-party requests. It is a statement about this product's privacy position, and
// a font or an analytics tag would quietly make it untrue.
const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
const unexpected = external.filter((url) => !url.startsWith('https://github.com/'));
if (unexpected.length > 0) problems.push(`third-party requests: ${unexpected.join(', ')}`);

// The price and the licence are the two claims that cost money if they are wrong, so they are the two
// asserted on. The licence is AGPL-3.0-or-later — see LICENSE and the licence section of README.md. This has
// been wrong once already: the page said MIT in three places while the repository said AGPL, which is two
// different licences with two different businesses behind them. It was then briefly FSL-1.1-ALv2 and back,
// which is why the assertion names one licence and fails on both of the others.
for (const claim of ['£49', '$59', '14-day', '25 MB', 'AGPL-3.0', 'Unlimited clients']) {
  if (!html.includes(claim)) problems.push(`the page no longer says "${claim}"`);
}
for (const wrong of ['MIT', 'FSL', 'Apache 2', 'source-available']) {
  if (new RegExp(`\\b${wrong}\\b`).test(html)) {
    problems.push(`the page names ${wrong}, and this project is licensed AGPL-3.0-or-later`);
  }
}

// "Open source" is now accurate, so it may be claimed — but the page must not claim *more* than AGPL gives.
// The licence does not stop a competitor hosting this and charging for it, and a page that implied otherwise
// would be the kind of small lie a reader who knows the licence would catch. So the phrase is fine and the
// promise is not.
for (const [index, line] of html.split(/\r?\n/).entries()) {
  if (/\b(no one|nobody|no-one) (else )?(may|can) (sell|host|resell|offer)\b/i.test(line)) {
    problems.push(`line ${index + 1}: AGPL permits anybody to host and charge for this — the page must not say otherwise`);
  }
}

// The licence must also match the repository rather than the page's memory of it.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (pkg.license !== 'AGPL-3.0-or-later') problems.push(`package.json now says the licence is ${pkg.license}`);

// The design system must come from src/style.js. If a token here drifts from the application's, the two
// surfaces stop being the same product and nobody notices until they sit side by side.
const appStyle = readFileSync(new URL('../src/style.js', import.meta.url), 'utf8');
for (const token of ['--canvas', '--surface', '--sunken', '--ink', '--ink-2', '--soft', '--brand', '--primary', '--sh-1', '--sh-2', '--sh-3', '--r-lg', '--fs-base']) {
  if (!html.includes(token)) problems.push(`the page is missing the design token ${token}`);
  if (!appStyle.includes(token)) problems.push(`src/style.js no longer defines ${token} — the page and the app have drifted apart`);
}

if (problems.length > 0) {
  console.error('site/index.html has problems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`site/index.html: fine. ${count(/<section/g)} sections, ${count(/<details/g)} questions.`);
console.log(`size: ${Math.round(html.length / 1024)} KB, external requests: ${external.length} (all GitHub links).`);

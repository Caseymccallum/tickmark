/**
 * The stylesheet, checked where a person cannot check it.
 *
 *   node tools/check-style.mjs
 *
 * Two things go wrong in `src/style.js` that nothing else catches, and both have happened:
 *
 * 1. **A backtick inside the CSS.** The sheet is a template literal, so one backtick in a comment ends the string and
 *    the module fails to load — which takes down every page and *every test*, with an error pointing at a line of CSS
 *    rather than at the comment that caused it. It has cost three separate debugging sessions in this project, which
 *    is two more than a mistake is allowed to cost.
 * 2. **An unbalanced brace.** A rule that never closes swallows every rule after it, so whole sections silently stop
 *    applying while the brace count still balances if a later stray one closes it. The landing page's checker learned
 *    this the same way; this is the same walk applied to the app's sheet.
 *
 * It also reports the sheet's size, because a stylesheet that grows without anybody noticing is how a page ends up
 * 88% CSS.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync('src/style.js', 'utf8');
let failed = false;

// ── 1. Backticks inside the sections ────────────────────────────────────────────────────────────────
const names = ['TOKENS', 'BASE', 'COMPONENTS', 'FORMS', 'TABLES', 'SURFACES', 'CLIENT_AND_MISC'];
const sheets = [];
for (const name of names) {
  const start = source.indexOf(`const ${name} = \``);
  if (start === -1) {
    console.error(`  ${name}: not found — has a section been renamed?`);
    failed = true;
    continue;
  }
  const from = start + `const ${name} = \``.length;
  // The section ends at the first backtick after the declaration, which is exactly why an inner one is fatal.
  const end = source.indexOf('`', from);
  const inner = source.slice(from, end);
  const line = source.slice(0, start).split('\n').length;
  sheets.push([name, inner]);
  console.log(`  ${name.padEnd(16)} ${String(inner.split('\n').length).padStart(4)} lines, starting at ${line}`);
}

// ── 2. Braces, walked in order rather than counted ──────────────────────────────────────────────────
const css = sheets.map(([, inner]) => inner).join('\n');
let depth = 0;
let lastOpen = 0;
let line = 1;
let walked = 0;
for (let index = 0; index < css.length; index += 1) {
  const character = css[index];
  if (character === '\n') line += 1;
  if (character === '{') {
    depth += 1;
    lastOpen = line;
    walked += 1;
  }
  if (character === '}') {
    depth -= 1;
    if (depth < 0) {
      console.error(`\n  a closing brace with nothing open, at line ${line} of the sheet`);
      failed = true;
      break;
    }
  }
}
if (depth > 0) {
  console.error(`\n  a rule opened at line ${lastOpen} of the sheet never closes (depth ${depth} at the end)`);
  failed = true;
}

// ── 3. The size, since 88% of a page is this ────────────────────────────────────────────────────────
const STYLE = (await import('../src/style.js')).STYLE;
const rules = (css.match(/\{/g) ?? []).length;
console.log(`\n  ${walked} rules, ${(STYLE.length / 1024).toFixed(1)} KB of CSS in every response`);

if (failed) {
  console.error('  the sheet is not loadable\n');
  process.exit(1);
}
console.log('  no backticks inside the literal, every rule closed\n');

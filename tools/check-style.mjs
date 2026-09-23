/**
 * The stylesheet, checked where a person cannot check it.
 *
 *   node tools/check-style.mjs
 *
 * Four things go wrong in `src/style.js` that nothing else catches. Two have already happened, and two are
 * arithmetic:
 *
 * 1. **A backtick inside the CSS.** The sheet is a template literal, so one backtick in a comment ends the string and
 *    the module fails to load — which takes down every page and *every test*, with an error pointing at a line of CSS
 *    rather than at the comment that caused it. It has cost three separate debugging sessions in this project, which
 *    is two more than a mistake is allowed to cost.
 * 2. **An unbalanced brace.** A rule that never closes swallows every rule after it, so whole sections silently stop
 *    applying while the brace count still balances if a later stray one closes it. The landing page's checker learned
 *    this the same way; this is the same walk applied to the app's sheet.
 * 3. **A variable used and never defined.** `var(--radius)` in `.promise` asked for a radius that does not exist —
 *    the tokens are `--r-lg`, `--r-md` and the rest — so the browser threw the declaration away and that block has
 *    been square-cornered since the day it was written. Nothing reports it: not the browser, not the tests, and not a
 *    person looking at the page.
 * 4. **A colour that fails contrast, or a token defined in one mode only.** Every ink is measured against the
 *    surfaces it is actually used on, and every state family against its own fill, at 4.5:1 — the AA threshold for
 *    body text. The light and dark blocks must define the same set of colours, because `prefers-color-scheme` swaps
 *    custom properties and nothing else: a token added to one block and forgotten in the other takes its value from
 *    the light sheet, which is how a dark page ends up with a white patch in it. This is also the check that would
 *    have found `--faint` at 2.9:1 before anybody had to notice it by eye.
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

// ── 4. The tokens, measured rather than read ────────────────────────────────────────────────────────
// The two checks above are about the sheet's *shape*; these are about its numbers. Both modes are in the same
// string, so the split is the dark media query — everything before it is the light block.
const darkFrom = STYLE.indexOf('@media (prefers-color-scheme: dark)');
const tokenMap = (text) => {
  const found = new Map();
  for (const match of text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) found.set(match[1], match[2]);
  return found;
};
const light = tokenMap(STYLE.slice(0, darkFrom));
const dark = tokenMap(STYLE.slice(darkFrom));

const defined = new Set([...STYLE.matchAll(/--([a-z0-9-]+):/gi)].map((match) => match[1]));
const used = [...new Set([...STYLE.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]))];
const undefinedTokens = used.filter((name) => !defined.has(name));
if (undefinedTokens.length > 0) {
  console.error(`  used but never defined: ${undefinedTokens.map((name) => `--${name}`).join(', ')}`);
  console.error('  a declaration with an undefined variable is not an error anywhere — the browser discards the');
  console.error('  whole declaration and whatever it styled keeps its default');
  failed = true;
} else {
  console.log(`  ${used.length} variables used, and every one of them defined`);
}

/** WCAG relative luminance, then the contrast ratio between two of them. */
const luminance = (hex) => {
  const channels = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (one, other) => {
  const [x, y] = [luminance(one), luminance(other)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// Every pair that is actually text somewhere: the four ink weights on the three surfaces, each state's words on its
// own fill, a link, and the words on a primary button.
const INKS = ['ink', 'ink-2', 'soft', 'faint'];
const SURFACES = ['canvas', 'surface', 'sunken'];
const PAIRS = [
  ...INKS.flatMap((ink) => SURFACES.map((surface) => [`${ink} on ${surface}`, ink, surface])),
  ...['ok', 'info', 'warn', 'bad', 'off'].map((state) => [`${state}-ink on ${state}-bg`, `${state}-ink`, `${state}-bg`]),
  ['link on canvas', 'link', 'canvas'],
  ['primary-ink on primary', 'primary-ink', 'primary'],
];

let tightest = { name: '', value: Infinity };
for (const [mode, tokens] of [['light', light], ['dark', dark]]) {
  for (const [name, foreground, background] of PAIRS) {
    const value = contrast(tokens.get(foreground), tokens.get(background));
    if (value < tightest.value) tightest = { name: `${mode}: ${name}`, value };
    if (value < 4.5) {
      console.error(`  ${mode}: ${name} is ${value.toFixed(2)}:1, below the 4.5:1 AA threshold for text`);
      failed = true;
    }
  }
}
console.log(`  ${PAIRS.length * 2} pairs of text and background clear AA; the tightest is ${tightest.name} at ${tightest.value.toFixed(2)}:1`);

const onlyLight = [...light.keys()].filter((name) => !dark.has(name));
const onlyDark = [...dark.keys()].filter((name) => !light.has(name));
if (onlyLight.length > 0 || onlyDark.length > 0) {
  console.error(`  defined in one mode only — light: ${onlyLight.join(', ') || '(none)'}; dark: ${onlyDark.join(', ') || '(none)'}`);
  failed = true;
} else {
  console.log(`  ${light.size} colour tokens, every one defined in both modes`);
}

if (!/@media print \{/.test(STYLE)) {
  console.error('  no print block: a practice prints a checklist for a meeting, and the chrome it cannot use comes off');
  failed = true;
} else {
  console.log('  a print block is present, for the page on paper');
}

if (failed) {
  console.error('  the sheet is not loadable\n');
  process.exit(1);
}
console.log('  no backticks inside the literal, every rule closed, every token defined and above AA\n');


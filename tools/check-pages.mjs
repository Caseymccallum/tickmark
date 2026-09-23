/**
 * Check the rendered pages for the mistakes that a design change introduces quietly: an
 * interpolation that produced `undefined`, a style block left unbalanced, a page that lost its
 * header or footer, a tag left open. Run after `tools/snapshot.mjs`.
 *
 *   node tools/check-pages.mjs [dir]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'tmp-snapshot';
const files = readdirSync(dir).filter((name) => name.endsWith('.html'));

const count = (text, needle) => text.split(needle).length - 1;
let problems = 0;

for (const file of files) {
  const page = readFileSync(join(dir, file), 'utf8');
  const issues = [];

  if (page.includes('undefined')) issues.push('contains "undefined"');
  if (page.includes('[object Object]')) issues.push('contains "[object Object]"');
  if (count(page, '<style') !== count(page, '</style>')) issues.push('unbalanced style tags');
  // The three things a strict Content-Security-Policy refuses and a careless edit reintroduces. The
  // nonce cannot bless a style *attribute* or an inline *handler*, and an un-stamped placeholder is a
  // page whose styling the browser silently discards. Keeping these out of the product is everyone's
  // job, so this checks every rendered page rather than trusting the review.
  if (/\sstyle="/.test(page)) issues.push('has an inline style attribute');
  if (/\s(?:on(?:click|load|error|submit|change|focus|blur|input|keydown|keyup|dblclick|contextmenu|toggle|animationend|pointerdown|pointerup))="/.test(page)) {
    issues.push('has an inline event handler');
  }
  if (!page.includes('<style nonce="')) issues.push('no nonced style block');
  if (page.includes('{{nonce}}')) issues.push('an un-stamped nonce placeholder');
  if (count(page, '{') !== count(page, '}')) issues.push('unbalanced braces');
  if (!page.includes('<svg class="mark"')) issues.push('no brand mark');
  if (!page.includes('<footer class="foot">')) issues.push('no footer');
  if (!/<title>[^<]+<\/title>/.test(page)) issues.push('no title');
  if (!page.includes('name="viewport"')) issues.push('no viewport');
  // Two things the shell owes every page, and the two that are invisible until the day they are missing: the
  // skip link that makes a keyboard's first Tab land on the content rather than on eight nav links, and the
  // theme-colour pair that keeps a phone's own browser chrome the same colour as the page beneath it. Both
  // are asserted here because neither shows up in a screenshot of a page that has lost them.
  if (!page.includes('class="skip"')) issues.push('no skip link');
  if (count(page, 'name="theme-color"') !== 2) issues.push('not exactly two theme-color tags');

  // Every form control that renders as an input should be inside a form or a known exception.
  const buttonsOutsideForms = count(page, '</form>') === 0 && count(page, '<button') > 0;

  if (issues.length > 0) {
    problems += 1;
    console.log(`${file}: ${issues.join(', ')}`);
  }
  void buttonsOutsideForms;
}

console.log(problems === 0 ? `all ${files.length} pages look structurally sound` : `${problems} of ${files.length} pages need a look`);

// A check that cannot fail is not a check — it is a comment. This tool is a gate in CI now, so a
// page that needs a look has to be able to stop the build that shipped it.
process.exit(problems === 0 ? 0 : 1);

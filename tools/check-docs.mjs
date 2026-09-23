/**
 * The documents, checked against each other.
 *
 *   node tools/check-docs.mjs
 *
 * Two kinds of rot, and both had already happened here by the time this file was written:
 *
 * 1. **A number that describes another file.** `README.md` said `docs/encryption.md` listed *four* things the
 *    encryption does not protect. It lists seven: three arrived over later phases, and the sentence a buyer reads
 *    first kept the old count. That is not a typo in this project — it is the one class of error the whole
 *    documentation style exists to prevent. The limits are meant to be *stated* rather than discovered, so a count
 *    that understates them is the failure mode, not a wording preference.
 * 2. **A document that nothing points at.** `docs/` is where a decision is recorded. A file no page links to is a
 *    decision nobody will read, which is the same as not having written it.
 *
 * Both are counted rather than remembered. The policy at the root is checked too, for the same reason: a
 * `SECURITY.md` nobody can find is not a disclosure process.
 */
import { readdirSync, readFileSync } from 'node:fs';

const readme = readFileSync('README.md', 'utf8');
const encryption = readFileSync('docs/encryption.md', 'utf8');
let failed = false;

// ── 1. The number the README states about the encryption document ───────────────────────────────────
// The sentence is prose, so the number is a word: "including the seven things it does not protect".
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const claimed = readme.match(/including the (\w+) things it does not protect/);
const marker = '**Not protected, and these are not oversights:**';
const from = encryption.indexOf(marker);
const to = encryption.indexOf('\n## ', from);
const section = from === -1 ? '' : encryption.slice(from, to === -1 ? undefined : to);
const listed = section.split('\n').filter((line) => /^- \*\*/.test(line)).length;

if (!claimed) {
  console.error('  the README no longer says "including the N things it does not protect" — this check has been');
  console.error('  reworded out of work rather than satisfied, so it needs updating, not deleting');
  failed = true;
} else if (!WORDS.includes(claimed[1])) {
  console.error(`  the README says "${claimed[1]}", and this check reads words: use ${WORDS.slice(1, 11).join(', ')}`);
  failed = true;
} else if (WORDS.indexOf(claimed[1]) !== listed) {
  console.error(`  README.md claims ${claimed[1]} limits; docs/encryption.md lists ${listed}`);
  console.error(`  ${listed} in "Not protected" and ${claimed[1]} in the README cannot both be right`);
  failed = true;
} else {
  console.log(`  README: ${claimed[1]} things it does not protect == encryption.md: ${listed} under "Not protected"`);
}

// ── 2. Every document in docs/ is reachable from the README ─────────────────────────────────────────
const docs = readdirSync('docs').filter((name) => name.endsWith('.md')).sort();
const unlinked = docs.filter((name) => !readme.includes(`docs/${name}`));
for (const name of unlinked) console.error(`  docs/${name} is linked from nothing in README.md`);
if (unlinked.length > 0) failed = true;
console.log(`  ${docs.length} documents in docs/, ${docs.length - unlinked.length} linked from the README`);

// ── 3. The policy is findable ───────────────────────────────────────────────────────────────────────
if (!readme.includes('SECURITY.md')) {
  console.error('  SECURITY.md exists and README.md does not mention it — a policy nobody finds is not one');
  failed = true;
} else {
  console.log('  SECURITY.md is listed in the README');
}

if (failed) {
  console.error('\n  the documents disagree with themselves\n');
  process.exit(1);
}
console.log('  every count true, every document linked\n');

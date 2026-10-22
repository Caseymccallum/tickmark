/**
 * Exported names nothing refers to: dead code, or the only route into a module from a tool.
 *
 *   node tools/find-unused.mjs
 *
 * Worth having as a tool rather than doing by eye, because "is this used" is exactly the question a person gets
 * wrong — during the audit that produced this file I claimed three dead things and two of them were live.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return read(path);
      return entry.isFile() && /\.(js|mjs)$/.test(entry.name)
        ? [[path, readFileSync(path, 'utf8')]]
        : [];
    });

const source = read('src');
const corpus = [...source, ...read('test'), ...read('tools'), ...read('web')]
  .map(([, text]) => text)
  .join('\n');

const declared = [];
for (const [file, text] of source) {
  for (const match of text.matchAll(/export (?:async )?(?:function|const|class) ([A-Za-z_$][\w$]*)/g)) {
    declared.push([match[1], file]);
  }
}

// Exports kept deliberately with nothing referring to them — each name here is a decision, not a
// silence. Keep this empty unless a stable external entry point requires an otherwise-unused name.
const ADMITTED = [];

let dead = 0;
for (const [name, file] of declared) {
  // The declaration itself is the first hit; anything more means something refers to it.
  const uses = corpus.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) ?? [];
  if (uses.length <= 1 && !ADMITTED.includes(name)) {
    console.log(`  ${name}  — exported from ${file}, referenced nowhere else`);
    dead += 1;
  }
}
console.log(`\n${declared.length} exports checked, ${dead} unused`);

// A check that cannot fail is not a check: this is a gate in CI now, so an export nothing refers to
// stops the build until it is either used or admitted below with its reason. (The list is empty today.
// It existed in spirit before — four dead exports sat in it for a release — and gates are cheaper than
// memories.)
process.exit(dead === 0 ? 0 : 1);

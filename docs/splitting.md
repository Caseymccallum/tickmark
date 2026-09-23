# Splitting `app.js`: the recipe, and what is left

`src/app.js` was one file of 7,173 lines. It is 1,084 today, and this records how the rest comes out — because the
recipe is now known, and the only thing that made it hard the first time was not knowing it.

The reasoning for splitting at all is in `docs/audit.md` §3, and the story of the twelve modules that have already left
— including the four mistakes, and what caught them — is in `CHANGELOG.md` under *The split*. This file is the practical
half: what to do, in what order, and what is left to do it to.

## The recipe

Six steps per module. They are in this order because each one is cheap and the expensive ones are last.

1. **Measure the boundaries in the file as it is now.** Find the section's first and last line, print them with a few
   neighbours, and read them. *This is the step that was skipped once, and it cost an hour:* line numbers measured
   before an earlier edit shifted the file produced a module that began inside a doc comment and a section that ended
   inside the function after it. Nothing was lost — `git checkout` restored the file, the half-written module was
   deleted, and the move was redone with re-measured boundaries — but the rule is worth the sentence: **measure the
   boundaries in the file you are about to edit, not in the one you measured an hour ago.**
2. **Analyse it over every top-level declaration, not just the exports.** Recreate the tool below, set `RANGES`, and
   run it. It reports what the moving code needs from the rest of `app.js` (`MUST IMPORT`), what the rest of `app.js`
   needs from it (`MUST EXPORT`), what is private to it, and — the list that matters most — **names that look like code
   and are accounted for by nothing.** That last list is how `CLIENT_SAYS` would have been caught before a test caught
   it: it is a module-level constant that no import list mentions, so an analysis of *exports* cannot see it.
3. **Give the shared helpers a home first.** A helper needed on both sides of a new seam becomes a circular import, so
   it has to move before the section does. Fifteen have moved so far, and the destinations say what they were:
   `views.js` takes anything that answers a request or names a state; `http.js` anything about the shape of what a
   browser sent; `store.js` limits and the words a column may hold; `clock.js` time arithmetic; `auth.js` credentials;
   `notices.js` letters; and `blobs.js` exists for the one thing that reads a stored document. An import that only the
   moving code used should leave `app.js` with it.
4. **Move the bytes with .NET, not by retyping.** Retyping is how a move stops being a move. Read both files with
   `[System.IO.File]::ReadAllLines`, concatenate the ranges, write with `UTF8Encoding($false)` — and put the moved
   lines in the new module *verbatim*, doc comments included. The one edit worth making on the way is a doc comment
   that had drifted from its function: two of those have been reunited so far (`keysPage`'s and `parseItems`'s).
5. **Wire the imports, then check for the ones that are now unused.** `node --check` both files, then run the scan in
   the tool below over all of `src/`. It catches the imports a move orphaned, which nothing else does: Node does not
   warn about an unused import, and `find:unused` only looks at exports.
6. **Run the suite, then the checks.** `npm test` (392 tests), then `find:unused`, `check:style`, `check:docs`,
   `check:nav`, `check:site`, `snapshot` and `check:pages`. A `ReferenceError` from a missing import and a duplicate
   declaration from a stale one both surface at once, and the suite has caught every one of them in this series —
   never the reading, and never a static check.

## The tool

Delete it before committing: it is a refactor aid, not part of the product. Most of it is bookkeeping, and the value
is entirely in the last filter.

```js
// node debug-split.mjs   — set RANGES to the lines that are moving.
import { readFileSync } from 'node:fs';
const lines = readFileSync('src/app.js', 'utf8').split('\n');
const RANGES = [[1, 2]];
const inRange = (line) => RANGES.some(([from, to]) => line >= from && line <= to);
const declarations = new Map();
lines.forEach((line, index) => {
  const fn = line.match(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/);
  const cst = line.match(/^(?:export )?const ([A-Za-z_$][\w$]*)\s*=/);
  if (fn) declarations.set(fn[1], index + 1);
  else if (cst) declarations.set(cst[1], index + 1);
});
const moved = lines.filter((_, i) => inRange(i + 1)).join('\n');
const kept = lines.filter((_, i) => !inRange(i + 1)).join('\n');
const names = (text) => new Set([...text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]));
const inside = [...declarations].filter(([, l]) => inRange(l));
const outside = [...declarations].filter(([, l]) => !inRange(l));
const movedUsed = names(moved);
const keptUsed = names(kept);
console.log('MUST IMPORT:', outside.filter(([n]) => movedUsed.has(n)).map(([n, l]) => `${n} (${l})`).join(', '));
console.log('MUST EXPORT:', inside.filter(([n]) => keptUsed.has(n)).map(([n, l]) => `${n} (${l})`).join(', '));
console.log('PRIVATE:', inside.filter(([n]) => !keptUsed.has(n)).map(([n]) => n).join(', '));
const appJS = readFileSync('src/app.js', 'utf8');
for (const m of appJS.matchAll(/import \{([^}]*)\} from '([^']+)';/g)) {
  const used = m[1].split(',').map((p) => p.trim()).filter((n) => n && movedUsed.has(n));
  if (used.length) console.log(`  '${m[2]}':`, used.join(', '));
}
// The list that matters: names the moved code uses that nothing accounts for.
const appImports = new Set([...appJS.matchAll(/import \{([^}]*)\} from/g)].flatMap((m) => m[1].split(',').map((p) => p.trim())));
const MODULES = ['store', 'views', 'http', 'clock', 'db', 'crypto', 'roles', 'mailer', 'ratelimit', 'auth', 'totp',
  'notices', 'blobs', 'board-views', 'client-portal', 'keys-views', 'members-views', 'chase-views', 'account-views'];
const exported = new Set();
for (const name of MODULES) {
  const source = readFileSync(`src/${name}.js`, 'utf8');
  for (const m of source.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)) exported.add(m[1] ?? m[2]);
}
const insideNames = new Set(inside.map(([n]) => n));
const IGNORE = new Set(('const let var function return if else for while of in do break continue await async try catch ' +
  'finally throw new class extends typeof instanceof delete void this super null undefined true false case switch ' +
  'Math JSON Object Array String Number Boolean Promise Map Set Date Error Buffer console process globalThis URL ' +
  'Uint8Array isNaN parseInt parseFloat Infinity NaN').split(' ').filter(Boolean));
const suspicious = [...movedUsed]
  .filter((n) => !insideNames.has(n) && !exported.has(n) && !appImports.has(n) && !IGNORE.has(n) && !(n in globalThis))
  .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
  .filter((n) => n === n.toUpperCase() || /^[a-z][A-Za-z0-9]*[A-Z]/.test(n) || /(Id|At|Path|Bytes|Days|Size)$/.test(n))
  .sort();
console.log('SUSPICIOUS:', suspicious.join(', ') || '(none)');
```

Read `SUSPICIOUS` rather than trusting it: everything a comment mentions ends up in it. `clientSays`, `open`, `rename`
and `join` have all appeared there and were prose, a `.join()` call, or `item.clientSays`. What it is for is the one
name in it that is a real declaration nobody imports.

Two repairs were needed to the snippet above, and both were found by running it: the declaration regex must accept
`let` as well as `const` — the exports-only lesson from the other side — and an import list may span lines, so the names
are matched with `[\s\S]*?` rather than `[^}]*`. The scan step 5 asks for is this one. It looks the other way, at the
imports a move orphaned:

```js
// Run it over every module after a move. `as` is stripped, because an alias is not the name to count.
import { readdirSync, readFileSync } from 'node:fs';
for (const file of readdirSync('src').filter((n) => n.endsWith('.js'))) {
  const source = readFileSync(`src/${file}`, 'utf8');
  const body = source.replace(/import \{[\s\S]*?\} from '[^']+';/g, '');
  for (const m of source.matchAll(/import \{([\s\S]*?)\} from '[^']+';/g)) {
    for (const phrase of m[1].split(',').map((p) => p.trim()).filter(Boolean)) {
      const name = phrase.split(/\s+as\s+/).pop();
      if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(body)) console.log(`  src/${file}: ${name}`);
    }
  }
}
```

Read it the same way as `SUSPICIOUS`: a comment can account for a name nothing calls — `open`, `now` and `history` were
all reported as used while the word only appeared in prose — so when a name's count is small, grep for the *call*.

## What is left, measured

`app.js` is 1,084 lines as this is written and one section remains: the sign-in pages, from the banner to the end of the
file, so it is still one move. Four of the five have been done: `src/request-actions.js` (737 lines),
`src/clients-views.js` (528), `src/templates-views.js` (394) and `src/bulk-ask-views.js` (403). **The line numbers below
are measured and will have moved by the time you read this, which is precisely why step 1 exists.**

| New module | Lines | What moves |
| --- | --- | --- |
| `signin-views.js` | 455–1084 (~630) | home, the credential forms, sign-up, sign-in, the second factor, sign-out. **Leave `createApp`, `contextFor` and `asset` alone** — that is the dispatcher and the route table, which is what `app.js` should end up as |

After that one, `app.js` is the imports, the dispatcher, the route table — a few hundred lines a reader can hold in
their head, which is where this started out, and the point of arriving back at it is that the *product* is the same and
somebody can now find the part of it they need.

The four moves done since this was written settle something worth knowing about the rest: `request-actions.js` needed
**nothing** from `app.js`, `clients-views.js` needed nothing but the `FILES_PER_PAGE` ceiling that the documents page
was already the only reader of, `templates-views.js` needed nothing at all — `parseItems` was in `http.js`, as
predicted — and `bulk-ask-views.js` needed nothing but `CHASE_BUDGET_MS`, which `chase-views.js` was already exporting.
Every helper a seam had forced out over the earlier moves was already where these wanted it, which is the sign the seams
are in the right places.

One note for whoever does it:

- **The sign-in section is the last one, and it sits against the dispatcher.** `createApp`, `contextFor` and `asset`
  must stay in `app.js` — they are what it should be when the split is done — so the section taken is `home` through
  `signOut`, and nothing above the *The pages* banner.

## Picking this up in a fresh session

Read this file first, then the entries under *The split* in `CHANGELOG.md` — they carry the reasoning, and the three
mistakes with what caught each one. `docs/audit.md` §3 has why the file was split at all.

**Where it stands.** `app.js` is 1,084 lines and 55 KB, down from 7,173 and 357 KB: 85% of it gone, the product
unchanged, 392 tests green and every check passing. Twelve modules have left it — `notices` (405), `client-portal`
(607), `keys-views` (526), `board-views` (1,096), `members-views` (720), `chase-views` (626), `account-views` (261),
`request-actions` (737), `blobs` (30), `clients-views` (528), `templates-views` (394) and `bulk-ask-views` (403) — and
fifteen helpers now live in `views`, `http`, `clock`, `store`, `auth` and `notices`. The last four moves needed no
helper rehomed at all, which is the sign the seams are in the right places.

**Do the last section, and commit it.** Twelve commits have taken the file from 7,173 lines to 1,084; thirteen are not
worse than twelve, and a half-moved section cannot be verified.

**The one thing that has gone wrong four times is an import list disagreeing with the code.** Two were names the
analysis could not report because they were never exported. The third was a name it *did* report and the transcription
got wrong: two import lines merged into one, so `stat` came from `node:fs` — the callback API — instead of
`node:fs/promises`, and every test that served an envelope failed. The fourth was the same seam from the other side:
`clients-views.js`'s six handlers were wired into the route table before they were given `export`, and `app.js` failed
at import time. So copy the analysis's import list **verbatim, one module per line**, and run the unused-import scan
afterwards — in both directions, because prose makes it under-report: `open`, `now` and `history` were all reported as
used when only a comment mentioned the word.

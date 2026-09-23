# Splitting `app.js`: the recipe, and where it ended

`src/app.js` was one file of 7,173 lines. It is 423 today — the imports, the route table, the dispatcher, and nothing
else — and the split is finished. This records how it came out, because the recipe is now known and the only thing that
made it hard the first time was not knowing it.

The reasoning for splitting at all is in `docs/audit.md` §3, and the story of the thirteen modules that left it —
including the four mistakes, and what caught them — is in `CHANGELOG.md` under *The split*. This file is the practical
half: the recipe, the tool, and what the file was reduced to.

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
6. **Run the suite, then the checks.** `npm test` (403 tests), then `find:unused`, `check:style`, `check:docs`,
   `check:nav`, `check:site`, `snapshot`, `check:pages` and `check:gateway`. A `ReferenceError` from a missing import
   and a duplicate declaration from a stale one both surface at once, and the suite has caught every one of them in
   this series — never the reading, and never a static check.

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

## Where it ended, measured

`app.js` is 423 lines: the imports, the constant block and the asset allowlist, the route table, `contextFor`, `asset`
and `createApp`. **Nothing is left to move.** The thirteen modules that left it, in the order they went, are:

| Module | Lines | What left with it |
| --- | --- | --- |
| `notices.js` | 405 | the letters, the arrival draft, and the notification that fires on its own |
| `client-portal.js` | 607 | the page behind a link, and the five things a client can do on it |
| `keys-views.js` | 526 | the key: making one, seeing them, re-encryption, a passphrase |
| `board-views.js` | 1,096 | the board and the request page |
| `members-views.js` | 720 | who is in a practice, joining it, naming it |
| `chase-views.js` | 626 | the chase list and every message it can send |
| `account-views.js` | 261 | this person's password, address and sessions |
| `request-actions.js` | 737 | one request's link, its letters and the documents on it |
| `blobs.js` | 30 | the one place this server reads a stored document |
| `clients-views.js` | 528 | the documents page, the client directory, one client's record |
| `templates-views.js` | 394 | the templates, and the page that closes several at once |
| `bulk-ask-views.js` | 403 | asking everyone at once: the preview, the run, the report |
| `signin-views.js` | 680 | home, sign-up, sign-in, the second factor, sign-out |

The product is the same and 403 tests say so. What changed is that finding a handler is now a search in a few hundred
lines rather than a scroll through seven thousand — which is where this started out.

## If this is ever picked up again

**Where it stands.** The split is finished: `app.js` is 423 lines and 25 KB, down from 7,173 and 357 KB — 94% of the
lines and 93% of the bytes gone — and nothing is left in it but the dispatcher and the table. Every move ended green,
and the product's pages now each live in a `*-views.js` module beside it.

**The recipe above is unchanged and still the way to do a fourteenth**, if a section ever grows back into one file's
worth of work: measure in the file you are about to edit; analyse every top-level declaration; give a shared helper a
home before the section goes; move the bytes with .NET; `node --check` and the unused-import scan; then the suite, then
the checks. One section, one commit, verify before the next — a half-moved section cannot be verified.

**And the warning worth inheriting, because it is the one thing that has gone wrong four times:** an import list
disagreeing with the code. Two were names the analysis could not report because they were never exported. The third was
a name it *did* report and the transcription got wrong: two import lines merged into one, so `stat` came from `node:fs`
— the callback API — instead of `node:fs/promises`, and every test that served an envelope failed. The fourth was the
same seam from the other side: `clients-views.js`'s six handlers were wired into the route table before they were given
`export`, and `app.js` failed at import time. So copy the analysis's import list **verbatim, one module per line**, and
run the unused-import scan afterwards — in both directions, because prose makes it under-report: `open`, `now` and
`history` were all reported as used when only a comment mentioned the word.

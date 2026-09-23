/**
 * Where a page's milliseconds actually go.
 *
 *   node tools/bench-breakdown.mjs [clients]
 *
 * `bench.mjs` says how long a page takes; this says which parts of it take the time, because "the board is 38 ms" is
 * not a finding and "the board is 3 ms of SQL and 35 ms of templating" is. It also separates the two things a
 * question about performance usually means: **is the work necessary**, and **is the work in a bad shape**.
 *
 * Every number here is a median of five runs after one warm-up, on a fixture built by the same code `bench.mjs` uses.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import {
  clientSummaries,
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  itemsOf,
  outstandingForPractice,
  outstandingOf,
  progressForPractice,
  recordUpload,
  requestsFor,
} from '../src/store.js';
import { STYLE } from '../src/style.js';

const wanted = Number(process.argv[2] ?? 500);
const directory = mkdtempSync(join(tmpdir(), 'tickmark-breakdown-'));

const db = openDatabase(join(directory, 'tickmark.db'));
const practiceId = createPractice(db, { name: 'Lodis Accountancy' });
const person = createPractitioner(db, {
  practiceId,
  email: 'sam@bench.example',
  passwordHash: 'off, this never signs in',
  role: 'owner',
});

for (let index = 0; index < wanted; index += 1) {
  const clientId = createClient(db, {
    practiceId,
    createdBy: person,
    name: `Client ${String(index).padStart(4, '0')} Ltd`,
    email: `client${index}@example.test`,
  });
  const requestId = createRequest(db, {
    practiceId,
    createdBy: person,
    clientId,
    title: '2025 return',
    dueAt: '2026-01-31',
    items: ['Bank statements', 'Signed engagement letter', 'Photo ID', 'Trial balance'],
  });
  const [first] = itemsOf(db, requestId);
  recordUpload(db, {
    requestId,
    requestItemId: first.id,
    filename: `statements-${index}.pdf`,
    sizeBytes: 1024,
    sha256: `digest-${index}`,
    storagePath: join(directory, 'blobs', `${index}.bin`),
    at: '2026-01-05T09:00:00.000Z',
  });
}

/** Median of five, after a warm-up, so the first-call costs (statement parsing) are not counted as the cost. */
const time = (label, run) => {
  run();
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const at = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - at) / 1e6);
  }
  samples.sort((a, b) => a - b);
  console.log(`  ${samples[2].toFixed(2).padStart(8)} ms   ${label}`);
  return samples[2];
};

console.log(`fixture: ${wanted} clients, ${wanted * 4} documents requested, ${wanted} files\n`);

console.log('the queries the board makes:');
const progress = time('progressForPractice — every request’s counts, one grouped query', () =>
  progressForPractice(db, practiceId),
);
const list = time('requestsFor — the rows themselves, joined to clients', () => requestsFor(db, practiceId));
// The rows themselves, for the markup measurement below — `time` returns a duration rather than a value.
const boardRows = requestsFor(db, practiceId);
const wanted0 = time('outstandingForPractice — the chase’s documents (not on the board)', () =>
  outstandingForPractice(db, practiceId),
);

console.log('\nthe same for the other pages:');
time('clientSummaries — the client list', () => clientSummaries(db, practiceId));
time('requestsFor, scope: all — the closed tab too', () => requestsFor(db, practiceId, { scope: 'all' }));
const oneRequest = requestsFor(db, practiceId)[0].id;
time('outstandingOf for one request — the request page', () => outstandingOf(db, oneRequest));

console.log('\nwhat is left once the queries are done:');
const css = time('the stylesheet string, as a page assembles it', () => STYLE.length);
const rows = time('building the row markup for every request', () =>
  boardRows
    .map(
      (row) =>
        `<tr><td>${row.client_name}</td><td>${row.title}</td><td>${row.progress.outstanding}</td></tr>`,
    )
    .join(''),
);
console.log(`\n  the stylesheet is ${(STYLE.length / 1024).toFixed(0)} KB of every response, inlined`);
console.log(
  `  SQL ${(progress + list).toFixed(1)} ms · markup ${rows.toFixed(1)} ms · css ${css.toFixed(3)} ms · chase ${wanted0.toFixed(1)} ms`,
);

db.close();
rmSync(directory, { recursive: true, force: true });

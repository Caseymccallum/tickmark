/**
 * How the pages behave with a practice at the size the research describes.
 *
 * The product's own research says manual tracking breaks down past fifty clients, so a practice with a hundred is
 * the shape this has to hold up at — and a page that takes a second at a hundred clients is a page somebody stops
 * opening. This measures rather than guesses, because "there might be an N+1 in the clients page" is a suspicion
 * and a number is a finding.
 *
 *   node tools/bench.mjs [clients]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import {
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  itemsOf,
  recordUpload,
} from '../src/store.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/crypto.js';
import { agent } from '../test/helpers.js';

const wanted = Number(process.argv[2] ?? 100);
const password = 'a long enough password';
const directory = mkdtempSync(join(tmpdir(), 'tickmark-bench-'));

const db = openDatabase(join(directory, 'tickmark.db'));
const practiceId = createPractice(db, { name: 'Lodis Accountancy' });
const person = createPractitioner(db, {
  practiceId,
  email: 'sam@bench.example',
  passwordHash: await hashPassword(password),
  role: 'owner',
});

// A practice the size the research names: N clients, a request each, four documents each, and a file against one
// of them so the pages have states rather than dashes.
const started = Date.now();
for (let index = 0; index < wanted; index += 1) {
  const clientId = createClient(db, {
    practiceId,
    createdBy: person,
    name: `Client ${String(index).padStart(3, '0')} Ltd`,
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
  const file = join(directory, 'blobs', requestId, 'a.bin');
  recordUpload(db, {
    requestId,
    requestItemId: first.id,
    filename: `statements-${index}.pdf`,
    sizeBytes: 1024,
    sha256: `digest-${index}`,
    storagePath: file,
    at: '2026-01-05T09:00:00.000Z',
  });
}
const built = Date.now() - started;

const server = createApp(db, { blobDir: join(directory, 'blobs') });
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const client = agent(base);
await client.post('/signin', { email: 'sam@bench.example', password });
// The sign-in above needs a real hash to work; if it failed, the pages below will answer 303 and the timings would
// be a measurement of redirects. Asserted rather than assumed.
if ((await client.get('/requests')).status !== 200) {
  console.error('the benchmark could not sign in, so the numbers would be meaningless');
  process.exit(1);
}

const time = async (label, path) => {
  const samples = [];
  for (let run = 0; run < 5; run += 1) {
    const at = Date.now();
    const response = await client.get(path);
    samples.push(Date.now() - at);
    if (run === 0 && response.status !== 200) console.error(`  ${label}: answered ${response.status}`);
  }
  samples.sort((a, b) => a - b);
  return { label, median: samples[2], worst: samples[4] };
};

console.log(`fixture: ${wanted} clients, ${wanted * 4} documents requested, ${wanted} files — built in ${built} ms\n`);
const results = [];
for (const [label, path] of [
  ['board', '/requests'],
  ['board, closed tab', '/requests?closed=1'],
  ['board, searched', '/requests?q=client+07'],
  ['clients', '/clients'],
  ['chase', '/chase'],
  ['documents', '/files'],
  ['documents, searched', '/files?q=statements'],
  ['ask everyone', '/ask-everyone'],
  ['CSV of requests', '/requests.csv'],
]) {
  results.push(await time(label, path));
}
for (const row of results) {
  console.log(`  ${String(row.median).padStart(5)} ms median   ${String(row.worst).padStart(5)} ms worst   ${row.label}`);
}

server.close();
db.close();
rmSync(directory, { recursive: true, force: true });

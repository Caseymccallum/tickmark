/**
 * Does a page render run the same query more than once?
 *
 *   node tools/probe-repeats.mjs [clients]
 *
 * This is the question that decides whether the transferable idea from CogniVault — memoising within a request, so
 * repeated lookups cost nothing the second time — is worth anything here. `BuildContext` there indexes arrays once
 * because its analysis functions would otherwise walk the same array many times. Tickmark's equivalent would be a
 * page asking the store the same question twice, and the honest way to find out is to count.
 *
 * The counter hooks the statement cache in `openDatabase`, which is the one place every query passes through.
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

const wanted = Number(process.argv[2] ?? 40);
const password = 'a long enough password';
const directory = mkdtempSync(join(tmpdir(), 'tickmark-repeats-'));

const db = openDatabase(join(directory, 'tickmark.db'));
const practiceId = createPractice(db, { name: 'Lodis Accountancy' });
const person = createPractitioner(db, {
  practiceId,
  email: 'sam@probe.example',
  passwordHash: await hashPassword(password),
  role: 'owner',
});

for (let index = 0; index < wanted; index += 1) {
  const clientId = createClient(db, {
    practiceId,
    createdBy: person,
    name: `Client ${index} Ltd`,
    email: `c${index}@example.test`,
  });
  const requestId = createRequest(db, {
    practiceId,
    createdBy: person,
    clientId,
    title: '2025 return',
    dueAt: '2026-01-31',
    items: ['Bank statements', 'Signed engagement letter', 'Photo ID'],
  });
  const items = itemsOf(db, requestId);
  recordUpload(db, {
    requestId,
    requestItemId: items[0].id,
    filename: `statements-${index}.pdf`,
    sizeBytes: 1024,
    sha256: `d-${index}`,
    storagePath: join(directory, 'blobs', `${index}.bin`),
    at: '2026-01-05T09:00:00.000Z',
  });
}

// ── Count executions per distinct SQL string ────────────────────────────────────────────────────────
const executions = new Map();
const prepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const statement = prepare(sql);
  const counting = new Proxy(statement, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (property === 'run' || property === 'get' || property === 'all' || property === 'iterate') {
          executions.set(sql, (executions.get(sql) ?? 0) + 1);
        }
        return value.apply(target, args);
      };
    },
  });
  return counting;
};

const server = createApp(db, { blobDir: join(directory, 'blobs') });
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const client = agent(base);
await client.post('/signin', { email: 'sam@probe.example', password });

const requestId = db.prepare('SELECT id FROM request LIMIT 1').get().id;
const pages = [
  ['the board', '/requests'],
  ['a request', `/requests/${requestId}`],
  ['the clients list', '/clients'],
  ['the chase', '/chase'],
  ['the documents list', '/files'],
  ['a client’s page', `/clients/${db.prepare('SELECT id FROM client LIMIT 1').get().id}`],
  ['the keys page', '/keys'],
  ['the templates list', '/templates'],
];

let anyRepeats = false;
for (const [what, path] of pages) {
  executions.clear();
  const response = await client.get(path);
  let queries = 0;
  const repeats = [];
  for (const [sql, count] of executions) {
    queries += count;
    if (count > 1) repeats.push([count, sql.replace(/\s+/g, ' ').trim().slice(0, 96)]);
  }
  repeats.sort((a, b) => b[0] - a[0]);
  console.log(`\n${what} (${path}) — ${response.status}, ${queries} queries`);
  if (repeats.length === 0) {
    console.log('  no query ran twice');
  } else {
    anyRepeats = true;
    for (const [count, sql] of repeats) console.log(`  ${count}x  ${sql}`);
  }
}

console.log(
  anyRepeats
    ? '\n→ there IS repeated work inside a rendering, so a per-request memo would save something'
    : '\n→ every page asks each question exactly once, so a per-request memo would save nothing',
);

server.close();
db.close();
rmSync(directory, { recursive: true, force: true });

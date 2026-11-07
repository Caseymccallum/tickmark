/**
 * AUDIT PROBE 3 — is a taken address distinguishable from a free one?
 * Runs against a FRESH copy of the scratch database, so no rate limiter state interferes.
 */
import { copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../../../src/db.js';
import { createApp } from '../../../src/app.js';

const here = resolve('.');
const fresh = resolve(here, 'scratch2');
import { mkdirSync } from 'node:fs';
mkdirSync(fresh, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const from = resolve(here, 'scratch', `tickmark.db${suffix}`);
  if (existsSync(from)) copyFileSync(from, resolve(fresh, `tickmark.db${suffix}`));
}

const db = openDatabase(resolve(fresh, 'tickmark.db'));
const server = createApp(db, { blobDir: resolve(fresh, 'blobs') });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, fields) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
  redirect: 'manual',
});

const out = {};
try {
  const taken = await post('/signup', { email: 'owner@fictional.tickmark.invalid', password: 'averylongpassword123' });
  const takenBody = await taken.text();
  const free = await post('/signup', { email: 'brand-new-person@fictional.invalid', password: 'averylongpassword123' });
  const freeBody = await free.text();
  const strip = (h) => h.replace(/nonce="[^"]+"/g, 'nonce=X').replace(/\d+/g, 'N').replace(/\s+/g, ' ');

  const firstDiff = (() => {
    const a = strip(takenBody); const b = strip(freeBody);
    if (a === b) return null;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return { at: i, taken: a.slice(Math.max(0, i - 220), i + 320), free: b.slice(Math.max(0, i - 220), i + 320) };
  })();

  out.taken = { status: taken.status, bytes: takenBody.length, mentionsCheckEmail: /check your (email|inbox)/i.test(takenBody) };
  out.free = { status: free.status, bytes: freeBody.length, mentionsCheckEmail: /check your (email|inbox)/i.test(freeBody) };
  out.identicalAfterNonceStrip = strip(takenBody) === strip(freeBody);
  out.firstDifference = firstDiff;

  // The same question for a wrong password vs an unknown address on a clean limiter.
  const wrongPassword = await post('/signin', { email: 'owner@fictional.tickmark.invalid', password: 'wrong-but-long' });
  const unknown = await post('/signin', { email: 'nobody-at-all@fictional.invalid', password: 'wrong-but-long' });
  const wrongBody = await wrongPassword.text();
  const unknownBody = await unknown.text();
  out.signin = {
    wrongPassword: { status: wrongPassword.status, bytes: wrongBody.length },
    unknownAddress: { status: unknown.status, bytes: unknownBody.length },
    identicalAfterNonceStrip: strip(wrongBody) === strip(unknownBody),
  };
} finally {
  await new Promise((done) => server.close(done));
  db.close();
}
writeFileSync(resolve(here, 'probe-enumeration.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

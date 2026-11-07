/**
 * AUDIT PROBE 4 — does the sign-up verification link, when the address already has a practice,
 * grant any access to that existing practice? Also: can a second practice be made from it?
 * Fresh copy of the scratch database.
 */
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../../../src/db.js';
import { createApp } from '../../../src/app.js';

const here = resolve('.');
const fresh = resolve(here, 'scratch3');
mkdirSync(fresh, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const from = resolve(here, 'scratch', `tickmark.db${suffix}`);
  if (existsSync(from)) copyFileSync(from, resolve(fresh, `tickmark.db${suffix}`));
}

const db = openDatabase(resolve(fresh, 'tickmark.db'));
const before = {
  practices: db.prepare('SELECT COUNT(*) AS n FROM practice').get().n,
  practitioners: db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n,
  sessions: db.prepare('SELECT COUNT(*) AS n FROM session').get().n,
};
const server = createApp(db, { blobDir: resolve(fresh, 'blobs') });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const out = { before };
let cookie = '';
const req = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookie = set.map((v) => v.split(';')[0]).join('; ');
  return response;
};

try {
  // A stranger asks to sign up with the owner's address.
  const signup = await req('/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'owner@fictional.tickmark.invalid', password: 'stranger-chosen-password-1' }),
  });
  const body = await signup.text();
  const token = /\/verify\/([A-Za-z0-9_-]{20,})/.exec(body)?.[1];
  out.verifyTokenIssuedForTakenAddress = Boolean(token);

  if (token) {
    const page = await req(`/verify/${token}`);
    out.verifyPageStatus = page.status;
    const finish = await req(`/verify/${token}`, { method: 'POST', body: new URLSearchParams({}) });
    out.verifyPostStatus = finish.status;
    out.verifyPostLocation = finish.headers.get('location');
    out.gotSession = cookie.includes('tickmark_session');

    // If a session was minted, can it read the existing practice's records?
    out.sessionCanReadBoard = (await req('/requests')).status;
    out.sessionCanReadMembers = (await req('/members')).status;
  }

  out.after = {
    practices: db.prepare('SELECT COUNT(*) AS n FROM practice').get().n,
    practitioners: db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM session').get().n,
  };
  out.ownerPasswordStillWorks = (await req('/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'owner@fictional.tickmark.invalid', password: process.argv[2] }),
  })).status;
} finally {
  await new Promise((done) => server.close(done));
  db.close();
}
writeFileSync(resolve(here, 'probe-signup-verify.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

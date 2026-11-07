/**
 * AUDIT PROBE 2 — independent adversarial-but-safe checks against an isolated local instance.
 * Own copy of the synthetic scratch database. Nothing destructive; nothing external.
 */
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../../src/db.js';
import { createApp } from '../../../src/app.js';

const here = resolve('.');
const scratch = resolve(here, 'scratch');
const db = openDatabase(resolve(scratch, 'tickmark.db'));
const server = createApp(db, { blobDir: resolve(scratch, 'blobs') });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const out = {};

const jar = (name) => {
  let cookie = '';
  return {
    name,
    async request(path, options = {}) {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
        redirect: 'manual',
      });
      const set = response.headers.getSetCookie();
      if (set.length) cookie = set.map((v) => v.split(';')[0]).join('; ');
      return response;
    },
    post(path, fields) {
      return this.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
      });
    },
    get(path) { return this.request(path); },
    get cookie() { return cookie; },
  };
};

try {
  const requestId = db.prepare('SELECT id FROM request ORDER BY created_at DESC LIMIT 1').get().id;
  const [upload] = db.prepare('SELECT id, request_id FROM upload LIMIT 1').all();

  // --- 1. Unauthenticated reach of practice data -------------------------------
  const anon = jar('anon');
  out.unauthenticated = {};
  for (const path of ['/requests', '/files', '/chase', '/members', '/keys', '/requests.csv', `/requests/${requestId}/files/${upload.id}`]) {
    const r = await anon.get(path);
    out.unauthenticated[path] = { status: r.status, location: r.headers.get('location') };
  }

  // --- 2. Signed in, then try to reach things that should not exist -----------
  const owner = jar('owner');
  const signin = await owner.post('/signin', {
    email: 'owner@fictional.tickmark.invalid',
    password: process.argv[2],
  });
  out.signin = { status: signin.status, cookieFlags: (signin.headers.getSetCookie()[0] ?? '') };

  out.idor = {};
  const guessed = randomUUID();
  for (const path of [
    `/requests/${guessed}`,
    `/requests/${guessed}/edit`,
    `/requests/${guessed}/files/${randomUUID()}`,
    `/clients/${guessed}`,
    `/templates/${guessed}`,
  ]) {
    const r = await owner.get(path);
    out.idor[path] = r.status;
  }

  // --- 3. Path traversal on the asset route -----------------------------------
  out.traversal = {};
  for (const path of [
    '/assets/..%2F..%2Fpackage.json',
    '/assets/%2e%2e%2fpackage.json',
    '/assets/upload.js',
    '/assets/not-a-real-file.js',
    '/assets/../src/db.js',
  ]) {
    const r = await owner.get(path);
    out.traversal[path] = { status: r.status, type: r.headers.get('content-type') };
  }

  // --- 4. Client link token abuse ---------------------------------------------
  out.links = {};
  for (const token of ['x'.repeat(43), 'notatoken']) {
    const r = await anon.get(`/r/${token}`);
    out.links[token.slice(0, 12)] = r.status;
  }

  // --- 5. Upload refusals on the client route with a tampered envelope --------
  const token = process.argv[3];
  const item = db.prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position DESC LIMIT 1').get(requestId);
  out.uploadRefusals = {};
  const forged = Buffer.concat([Buffer.from('TKME'), Buffer.alloc(400, 7)]);
  out.uploadRefusals.forgedEnvelope = (await anon.request(`/r/${token}/items/${item.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'forged.bin' },
    body: forged,
  })).status;
  out.uploadRefusals.itemNotOnThisLink = (await anon.request(`/r/${token}/items/${randomUUID()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'a.bin' },
    body: forged,
  })).status;

  // --- 6. Bad filename in the header ------------------------------------------
  const nasty = await anon.request(`/r/${token}/items/${item.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('../../../../etc/passwd') },
    body: Buffer.from('%PDF-1.4'),
  });
  out.nastyFilename = { status: nasty.status };

  // --- 7. Login rate limiting ---------------------------------------------------
  const attacker = jar('attacker');
  const codes = [];
  for (let attempt = 0; attempt < 13; attempt += 1) {
    const r = await attacker.post('/signin', {
      email: 'owner@fictional.tickmark.invalid',
      password: `wrong-${attempt}`,
    });
    codes.push(r.status);
  }
  out.rateLimit = { statuses: codes, firstBlockedAt: (codes.findIndex((c) => c === 429) + 1) || null };

  // --- 8. Does the sign-in reply distinguish unknown address from wrong password?
  const a = await jar('enum1').post('/signin', { email: 'nobody@fictional.invalid', password: 'x' });
  const b = await jar('enum2').post('/signin', { email: 'owner@fictional.tickmark.invalid', password: 'definitely-wrong' });
  const aBody = await a.text();
  const bBody = await b.text();
  out.enumeration = { unknownAddress: a.status, wrongPassword: b.status, sameLength: aBody.length === bBody.length };

  // --- 9. Sign-up does not disclose whether an address is taken ---------------
  const signup = await jar('newbie').post('/signup', { email: 'owner@fictional.tickmark.invalid', password: 'averylongpassword123' });
  const signupBody = await signup.text();
  out.signupOnExistingAddress = { status: signup.status, saysTaken: /already|taken|exists/i.test(signupBody) };

  // --- 10. CSV export -----------------------------------------------------------
  const csv = await owner.get('/requests.csv');
  out.csv = { status: csv.status, type: csv.headers.get('content-type'), disposition: csv.headers.get('content-disposition') };
} finally {
  await new Promise((done) => server.close(done));
  db.close();
}

writeFileSync(resolve(here, 'probe-adversarial.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

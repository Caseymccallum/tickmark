import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { encryptFile, generatePracticeKey } from '../web/tickmark-crypto.js';

const dataDir = resolve(process.argv[2] ?? 'tmp-synthetic-demo');
mkdirSync(dataDir, { recursive: true });
const db = openDatabase(resolve(dataDir, 'tickmark.db'));
const server = createApp(db, { blobDir: resolve(dataDir, 'blobs') });
const password = randomBytes(18).toString('base64url');
const passphrase = randomBytes(24).toString('base64url');
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
function agent() {
  let cookie = '';
  return {
    async request(path, options = {}) {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
        redirect: 'manual',
      });
      const values = response.headers.getSetCookie();
      if (values.length) cookie = values.map((value) => value.split(';')[0]).join('; ');
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
  };
}
const owner = agent();
try {
  const signup = await owner.post('/signup', { email: 'owner@fictional.tickmark.invalid', password });
  const verifyToken = /\/verify\/([A-Za-z0-9_-]{20,})/.exec(await signup.text())?.[1];
  if (signup.status !== 200 || !verifyToken) throw new Error(`Synthetic owner setup failed (${signup.status})`);
  const verified = await owner.get(`/verify/${verifyToken}`);
  const finished = await owner.post(`/verify/${verifyToken}`, {});
  if (verified.status !== 200 || finished.status !== 303) throw new Error('Synthetic owner verification failed');
  const named = await owner.post('/members/name', { name: 'FICTIONAL — Example Practice' });
  if (named.status !== 303) throw new Error(`Synthetic practice naming failed (${named.status})`);
  const keys = await generatePracticeKey(passphrase);
  const keyResponse = await owner.post('/setup', {
    public_key: JSON.stringify(keys.publicKey), wrapped_private_key: keys.wrappedPrivateKey,
  });
  if (keyResponse.status !== 303) throw new Error(`Synthetic key setup failed (${keyResponse.status})`);
  const staffPassword = randomBytes(18).toString('base64url');
  const invite = await owner.request('/members/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ role: 'assistant' }).toString(),
  });
  const inviteBody = await invite.json();
  if (invite.status !== 201) throw new Error(`Synthetic staff invitation failed (${invite.status})`);
  const staffResponse = await agent().post(`/invite/${inviteBody.token}`, {
    email: 'staff@fictional.tickmark.invalid', password: staffPassword,
  });
  if (staffResponse.status !== 303) throw new Error(`Synthetic staff acceptance failed (${staffResponse.status})`);
  const created = await owner.post('/requests', {
    client: 'FICTIONAL — Rowan Example',
    client_email: 'rowan@example.invalid',
    title: 'FICTIONAL — Demo document checklist',
    items: 'FICTIONAL — Sample bank statement\nFICTIONAL — Sample purchase invoices\nFICTIONAL — Sample signed questionnaire',
  });
  const requestId = created.headers.get('location')?.split('/').pop();
  if (created.status !== 303 || !requestId) throw new Error(`Synthetic request setup failed (${created.status})`);
  const items = db.prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position').all(requestId);
  const linkResponse = await owner.post(`/requests/${requestId}/link`, { days: '30' });
  const token = /\/r\/([A-Za-z0-9_-]{20,})/.exec(await linkResponse.text())?.[1];
  if (linkResponse.status !== 200 || !token) throw new Error('Could not create synthetic client link');
  if (!token) throw new Error('Could not create synthetic client link');
  const pdfText = 'FICTIONAL SYNTHETIC DEMO - NOT A CLIENT DOCUMENT';
  const stream = `BT /F1 12 Tf 20 70 Td (${pdfText}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdfSource = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdfSource));
    pdfSource += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdfSource);
  pdfSource += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdf = Buffer.from(pdfSource);
  for (const item of items.slice(0, 2)) {
    const envelope = await encryptFile(keys.publicKey, pdf);
    const response = await fetch(`${base}/r/${token}/items/${item.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('FICTIONAL-demo.pdf') },
      body: envelope,
    });
    if (!response.ok) throw new Error(`Synthetic upload failed (${response.status})`);
  }
  const reviewed = await owner.post(`/requests/${requestId}/check-all`, {});
  if (reviewed.status !== 303) throw new Error(`Synthetic review failed (${reviewed.status})`);
  console.log('FICTIONAL SYNTHETIC DATA ONLY — local demonstration; no billing or external services.');
  console.log(`Practice: FICTIONAL — Example Practice (owner@fictional.tickmark.invalid)`);
  console.log(`Owner password (generated for this local run): ${password}`);
  console.log(`Staff password (generated for this local run): ${staffPassword}`);
  console.log(`Key passphrase (generated for this local run): ${passphrase}`);
  console.log(`Request after starting the local app: http://localhost:3000/requests/${requestId}`);
  console.log(`Client link after starting the local app: http://localhost:3000/r/${token}`);
  console.log(`Start it with: $env:TICKMARK_DATA='${resolve(dataDir, 'tickmark.db')}'; npm start`);
  console.log(`Staff invitation: FICTIONAL assistant staff@fictional.tickmark.invalid (accepted in the demo)`);
  console.log(`Data directory: ${dataDir}`);
  console.log('Two fictional PDF uploads are encrypted; one checklist item remains outstanding.');
} catch (error) {
  await new Promise((done) => server.close(done));
  db.close();
  throw error;
}
await new Promise((done) => server.close(done));
db.close();

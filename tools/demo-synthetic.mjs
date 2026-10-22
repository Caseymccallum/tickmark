import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { encryptFile, generatePracticeKey } from '../web/tickmark-crypto.js';
import { createDemoDirectory, createDemoDirectoryAt, markDemoDirectory, removeDemoDirectory, validateDemoDirectory } from './demo-safety.mjs';

function syntheticPdf(label) {
  const escaped = `FICTIONAL TRAINING DOCUMENT - NO REAL FINANCIAL DATA - ${label}`.replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 13 Tf 25 80 Td (${escaped}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 440 140] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

function agent(base) {
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

async function bodyToken(response, pattern) {
  const match = pattern.exec(await response.text());
  if (!response.ok || !match) throw new Error('The local fictional demo setup did not return its expected link.');
  return match[1];
}

/** Seed a fresh demo directory only through the real application HTTP workflow. */
export async function seedDemo(path = createDemoDirectory()) {
  const ready = existsSync(path) ? validateDemoDirectory(path) : createDemoDirectoryAt(path);
  if (readdirSync(ready).length !== 0) throw new Error('Refusing to seed a non-empty folder. Choose a new Tickmark demo directory.');
  const dataDir = markDemoDirectory(ready);
  const db = openDatabase(join(dataDir, 'tickmark.db'));
  const server = createApp(db, { blobDir: join(dataDir, 'blobs'), mailer: null, sms: null });
  const password = randomBytes(18).toString('base64url');
  const staffPassword = randomBytes(18).toString('base64url');
  const passphrase = randomBytes(24).toString('base64url');
  let result;
  let seeded = false;
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const owner = agent(base);
    const signup = await owner.post('/signup', { email: 'owner@fictional.tickmark.invalid', password });
    const verifyToken = await bodyToken(signup, /\/verify\/([A-Za-z0-9_-]{20,})/);
    if ((await owner.get(`/verify/${verifyToken}`)).status !== 200 || (await owner.post(`/verify/${verifyToken}`, {})).status !== 303) {
      throw new Error('Fictional owner verification failed.');
    }
    if ((await owner.post('/members/name', { name: 'FICTIONAL — Cedar & Finch Practice' })).status !== 303) throw new Error('Fictional practice setup failed.');
    const keys = await generatePracticeKey(passphrase);
    if ((await owner.post('/setup', {
      public_key: JSON.stringify(keys.publicKey), wrapped_private_key: keys.wrappedPrivateKey,
    })).status !== 303) throw new Error('Fictional encryption key setup failed.');

    const invite = await owner.request('/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ role: 'assistant' }),
    });
    const inviteData = await invite.json();
    if (invite.status !== 201) throw new Error('Fictional assistant invitation failed.');
    const staff = agent(base);
    if ((await staff.post(`/invite/${inviteData.token}`, {
      email: 'staff@fictional.tickmark.invalid', password: staffPassword,
    })).status !== 303) throw new Error('Fictional assistant setup failed.');
    if ((await owner.post('/templates', {
      name: 'FICTIONAL — Year-end bookkeeping checklist',
      items: 'FICTIONAL — Bank statements\nFICTIONAL — Purchase invoices\nFICTIONAL — Signed questionnaire',
      note: 'Training example only.',
    })).status !== 303) throw new Error('Fictional template setup failed.');

    const samples = join(dataDir, 'samples');
    mkdirSync(samples, { recursive: false });
    const examples = [
      ['Fictional-bank-statement.pdf', 'SAMPLE BANK STATEMENT — Morgan Meadow'],
      ['Fictional-purchase-invoices.pdf', 'SAMPLE PURCHASE INVOICES — Cedar & Finch'],
      ['Fictional-signed-questionnaire.pdf', 'SAMPLE SIGNED QUESTIONNAIRE — Northstar'],
    ].map(([filename, label]) => ({ filename, bytes: syntheticPdf(label) }));
    for (const sample of examples) writeFileSync(join(samples, sample.filename), sample.bytes, { flag: 'wx', mode: 0o600 });

    const createRequest = async ({ client, email, title, due, items }) => {
      const response = await owner.post('/requests', {
        client: `FICTIONAL — ${client}`, client_email: email,
        title: `FICTIONAL — ${title}`, due,
        client_note: 'Training data only. No real financial documents are included.',
        items: items.map((item) => `FICTIONAL — ${item}`).join('\n'),
      });
      const requestId = response.headers.get('location')?.split('/').pop();
      if (response.status !== 303 || !requestId) throw new Error(`Fictional request creation failed (${response.status}).`);
      const ids = db.prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position').all(requestId).map((row) => row.id);
      const link = await owner.post(`/requests/${requestId}/link`, { days: '30' });
      const token = await bodyToken(link, /\/r\/([A-Za-z0-9_-]{20,})/);
      return { requestId, ids, token };
    };
    const upload = async (token, itemId, sample) => {
      const envelope = await encryptFile(keys.publicKey, sample.bytes);
      const response = await fetch(`${base}/r/${token}/items/${itemId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(sample.filename) },
        body: envelope,
      });
      if (!response.ok) throw new Error(`Fictional encrypted upload failed (${response.status}).`);
    };

    const interactive = await createRequest({
      client: 'Morgan Meadow', email: 'morgan@fictional.tickmark.invalid', title: 'Autumn bookkeeping pack',
      due: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
      items: ['Bank statement — September', 'Purchase invoices', 'Signed questionnaire'],
    });
    const review = await createRequest({
      client: 'Rowan Northstar', email: 'rowan@fictional.tickmark.invalid', title: 'Quarterly records', due: '',
      items: ['Bank statement — Q3', 'Expense receipts'],
    });
    await upload(review.token, review.ids[0], examples[0]);

    const completed = await createRequest({
      client: 'Alder & Finch', email: 'alder@fictional.tickmark.invalid', title: 'Completed sample pack', due: '',
      items: ['Purchase invoices', 'Signed questionnaire'],
    });
    await upload(completed.token, completed.ids[0], examples[1]);
    await upload(completed.token, completed.ids[1], examples[2]);
    if ((await owner.post(`/requests/${completed.requestId}/check-all`, {})).status !== 303) throw new Error('Fictional review seed failed.');

    const overdue = await createRequest({
      client: 'Juniper Ledger', email: 'juniper@fictional.tickmark.invalid', title: 'Past-due records',
      due: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
      items: ['Payroll summary', 'Bank statement'],
    });
    await upload(overdue.token, overdue.ids[0], examples[1]);
    if ((await owner.post(`/requests/${overdue.requestId}/items/${overdue.ids[0]}/attention`, {
      attention_note: 'FICTIONAL — sample is marked as the wrong period; please choose a replacement.',
    })).status !== 303) throw new Error('Fictional replacement scenario setup failed.');

    result = {
      dataDir,
      database: join(dataDir, 'tickmark.db'),
      blobs: join(dataDir, 'blobs'),
      samples,
      ownerEmail: 'owner@fictional.tickmark.invalid', password, staffEmail: 'staff@fictional.tickmark.invalid', staffPassword,
      passphrase,
      paths: {
        guide: '/demo', board: '/requests', clientUpload: `/r/${interactive.token}`,
        review: `/requests/${review.requestId}`, completed: `/requests/${completed.requestId}`,
        overdue: `/requests/${overdue.requestId}`, chase: '/chase', templates: '/templates', newRequest: '/requests/new',
      },
      samplesList: examples.map(({ filename }) => filename),
      providerState: 'mail and SMS disabled; no Stripe or hosted gateway is started',
    };
    seeded = true;
  } finally {
    await new Promise((done) => server.close(done));
    db.close();
    if (!seeded) {
      try { removeDemoDirectory(dataDir); } catch { /* Preserve any tree that fails the deletion safety checks. */ }
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2] ? resolve(process.argv[2]) : createDemoDirectory();
  const demo = await seedDemo(path);
  console.log('FICTIONAL TRAINING DATA ONLY — local private demo, no live billing or external providers.');
  console.log(`Data directory: ${demo.dataDir}`);
  console.log(`Owner: ${demo.ownerEmail} / ${demo.password}`);
  console.log(`Assistant: ${demo.staffEmail} / ${demo.staffPassword}`);
  console.log(`Practice key passphrase: ${demo.passphrase}`);
  console.log('Seed only: for a running loopback-only demonstration, start a fresh instance with npm run demo.');
  console.log(`Reset: npm run demo:reset -- '${demo.dataDir}'`);
}

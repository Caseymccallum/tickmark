/**
 * AUDIT PROBE — read-only inspection of a running Tickmark instance.
 * Seeds nothing; reads the synthetic scratch database created by tools/demo-synthetic.mjs,
 * walks the practice and client pages, and records what the wire actually says.
 * Writes evidence only, inside the audit directory. No product code is touched.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../../../src/db.js';
import { createApp } from '../../../src/app.js';

const here = resolve('.');
const scratch = resolve(here, 'scratch');
const out = resolve(here, 'pages');
mkdirSync(out, { recursive: true });

const db = openDatabase(resolve(scratch, 'tickmark.db'));
const server = createApp(db, { blobDir: resolve(scratch, 'blobs') });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const report = { base, steps: [], headers: {}, blobs: [], findings: [] };

let cookie = '';
async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
  });
  const values = response.headers.getSetCookie();
  if (values.length) cookie = values.map((v) => v.split(';')[0]).join('; ');
  return response;
}
const step = async (name, path, options) => {
  const response = await request(path, options);
  const body = await response.text();
  report.steps.push({ name, path, status: response.status, bytes: body.length });
  return { response, body };
};

try {
  // 1. Security headers on a public page.
  const home = await step('home', '/');
  report.headers = Object.fromEntries(home.response.headers);
  report.csp = home.response.headers.get('content-security-policy');
  report.hsts = home.response.headers.get('strict-transport-security');
  report.xcto = home.response.headers.get('x-content-type-options');
  report.frame = home.response.headers.get('x-frame-options');
  report.referrer = home.response.headers.get('referrer-policy');
  report.cspNoncePresent = /script-src[^;]*'nonce-/.test(report.csp ?? '');
  writeFileSync(resolve(out, 'home.html'), home.body);

  // 2. Health check.
  const health = await step('healthz', '/healthz');
  report.healthBody = health.body.slice(0, 400);
  report.healthHeaders = Object.fromEntries(health.response.headers);

  // 3. Sign in as the seeded owner.
  const signin = await step('signin', '/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'owner@fictional.tickmark.invalid', password: process.argv[2] }),
  });
  report.signedIn = signin.response.status;

  // 4. Practice pages.
  for (const [name, path] of [
    ['board', '/requests'],
    ['files', '/files'],
    ['chase', '/chase'],
    ['keys', '/keys'],
    ['members', '/members'],
    ['templates', '/templates'],
    ['account-sessions', '/account/sessions'],
    ['integrations', '/integrations'],
  ]) {
    const { body, response } = await step(name, path);
    writeFileSync(resolve(out, `${name}.html`), body);
    if (response.status !== 200) report.findings.push(`${name} returned ${response.status}`);
  }

  // 5. The request page the screenshot shows.
  const requestId = db.prepare('SELECT id FROM request ORDER BY created_at DESC LIMIT 1').get()?.id;
  report.requestId = requestId;
  if (requestId) {
    const view = await step('request', `/requests/${requestId}`);
    writeFileSync(resolve(out, 'request.html'), view.body);
    report.requestPageMentions = {
      passphrase: /passphrase/i.test(view.body),
      encryption: /encrypt/i.test(view.body),
      progress: /progress/i.test(view.body),
      unreviewed: /not checked|to check|unreviewed/i.test(view.body),
    };
  }

  // 6. The client's page, with the seeded link token.
  const token = process.argv[3];
  if (token) {
    const client = await step('client-page', `/r/${token}`);
    writeFileSync(resolve(out, 'client.html'), client.body);
    report.clientPage = {
      status: client.response.status,
      hasUploadScript: /\/assets\/upload\.js/.test(client.body),
      hasCryptoScript: /\/assets\/tickmark-crypto\.js/.test(client.body),
      hasPreflight: /\/assets\/preflight\.js/.test(client.body),
      asksForAccount: /password|sign in|sign up|register/i.test(client.body),
      viewportMeta: /name="viewport"/.test(client.body),
      langAttr: /<html[^>]*lang=/.test(client.body),
    };

    // Logged-out access to a practice page must not be readable.
    const saved = cookie;
    cookie = '';
    const anonymous = await step('anonymous-files', '/files');
    report.anonymousFilesStatus = anonymous.response.status;
    report.anonymousRedirect = anonymous.response.headers.get('location');
    cookie = saved;

    // The client upload route must refuse a non-envelope body.
    const item = db.prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position DESC LIMIT 1').get(requestId);
    const plaintext = await request(`/r/${token}/items/${item.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'plain.txt' },
      body: Buffer.from('%PDF-1.4 plaintext should be refused'),
    });
    report.plaintextUpload = { status: plaintext.status, body: (await plaintext.text()).slice(0, 250) };
  }

  // 7. What is actually on disk: every blob must be an envelope, and no plaintext must appear.
  const blobRoot = resolve(scratch, 'blobs');
  for (const entry of readdirSync(blobRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(resolve(blobRoot, entry.name));
    report.blobs.push({
      name: entry.name,
      bytes: bytes.length,
      magic: bytes.subarray(0, 4).toString('latin1'),
      isEnvelope: bytes.subarray(0, 4).toString('latin1') === 'TKME',
      containsPdfMagic: bytes.includes(Buffer.from('%PDF')),
      containsPlaintext: bytes.includes(Buffer.from('FICTIONAL SYNTHETIC DEMO')),
    });
  }

  // 8. Is the client link token or a session token stored in the clear?
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  report.tables = tables;
  report.tableCount = tables.length;
  if (process.argv[3]) {
    const needle = process.argv[3];
    const leaked = [];
    for (const table of tables) {
      const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name);
      for (const column of columns) {
        try {
          const hit = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE CAST("${column}" AS TEXT) LIKE ?`).get(`%${needle}%`);
          if (hit.n > 0) leaked.push(`${table}.${column}`);
        } catch { /* not a text column */ }
      }
    }
    report.linkTokenStoredInClear = leaked;
  }
} finally {
  await new Promise((done) => server.close(done));
  db.close();
}

writeFileSync(resolve(here, 'probe-live.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

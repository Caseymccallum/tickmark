/**
 * Seed a realistic (fictional) practice onto the running instance at :3010 so screenshots
 * show real product states: overdue, waiting-on-client, files-to-check, ready-to-work-on.
 * Uses the real HTTP routes; reads only the practice's PUBLIC key from the database.
 */
import { resolve } from 'node:path';
import { openDatabase } from '../../../src/db.js';
import { encryptFile } from '../../../web/tickmark-crypto.js';

const BASE = 'http://127.0.0.1:3010';
const EMAIL = 'owner@fictional.tickmark.invalid';
const PASSWORD = process.argv[2];
const DATA = resolve('scratch/tickmark.db');

const db = openDatabase(DATA);
const row = db.prepare('SELECT public_key FROM practice_key ORDER BY created_at DESC LIMIT 1').get();
const publicKey = JSON.parse(row.public_key);

let cookie = '';
async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookie = set.map((v) => v.split(';')[0]).join('; ');
  return response;
}
const post = (path, fields) => request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

const signin = await post('/signin', { email: EMAIL, password: PASSWORD });
if (signin.status !== 303) throw new Error(`sign-in failed: ${signin.status}`);
console.log('signed in');

const spec = [
  {
    client: 'Lodge & Co', email: 'accounts@lodge.example.invalid',
    title: '2025 annual accounts', due: '2026-10-15',
    items: ['Bank statements — all accounts, April 2025 to March 2026', 'Signed engagement letter', 'Photo ID for both directors', 'Trial balance at year end'],
    upload: 0, check: false,
  },
  {
    client: 'Juniper Trading', email: 'books@juniper.example.invalid',
    title: 'Quarterly bookkeeping — Q3', due: '2026-11-20',
    items: ['Q3 purchase invoices', 'Q3 sales invoices', 'Bank reconciliation for September'],
    upload: 1, check: false,
  },
  {
    client: 'Willow Workshop', email: 'hello@willow.example.invalid',
    title: 'Year-end checklist 2025', due: '2026-12-01',
    items: ['Bank statements, full year', 'Payroll summary P60s', 'Stock valuation at 31 March'],
    upload: 3, check: true,
  },
];

for (const entry of spec) {
  const created = await post('/requests', {
    client: entry.client, client_email: entry.email, title: entry.title,
    due: entry.due, items: entry.items.join('\n'),
  });
  const id = created.headers.get('location')?.split('/').pop();
  if (created.status !== 303 || !id) throw new Error(`create failed for ${entry.client}: ${created.status}`);

  const linkResponse = await post(`/requests/${id}/link`, { days: '30' });
  const token = /\/r\/([A-Za-z0-9_-]{20,})/.exec(await linkResponse.text())?.[1];
  if (!token) throw new Error(`no link for ${entry.client}`);

  const items = db.prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position').all(id);
  const pdf = Buffer.from(`%PDF-1.4\n${entry.client} fictional statement\n%%EOF\n`);
  for (const item of items.slice(0, entry.upload)) {
    const envelope = await encryptFile(publicKey, pdf);
    const upload = await fetch(`${BASE}/r/${token}/items/${item.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(`${entry.client.split(' ')[0].toLowerCase()}-statement.pdf`) },
      body: envelope,
    });
    if (!upload.ok) throw new Error(`upload failed for ${entry.client}: ${upload.status}`);
  }
  if (entry.check) {
    const checked = await post(`/requests/${id}/check-all`, {});
    if (checked.status !== 303) throw new Error(`check-all failed for ${entry.client}: ${checked.status}`);
  }
  console.log(`${entry.client}: request ${id}, ${entry.upload}/${items.length} uploaded, checked=${entry.check}, link=${token}`);
}

// Keep the single handle open; the running server uses its own connection.
console.log('requests in db:', db.prepare('SELECT COUNT(*) AS n FROM request').get().n);
console.log('clients in db:', db.prepare('SELECT COUNT(*) AS n FROM client').get().n);
db.close();

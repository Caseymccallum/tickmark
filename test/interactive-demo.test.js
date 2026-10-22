import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { uploadsOf, requestProgress } from '../src/store.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { demoGuide } from '../tools/demo-guide.mjs';
import { createDemoDirectory, markDemoDirectory, removeDemoDirectory, validateDemoDirectory } from '../tools/demo-safety.mjs';
import { seedDemo } from '../tools/demo-synthetic.mjs';

test('the interactive demo is fictional, isolated, pre-seeded through real workflows, and resettable', async () => {
  const demo = await seedDemo();
  try {
    assert.match(demo.dataDir, /[\\/]tickmark-demo-/i);
    assert.match(demo.ownerEmail, /@fictional\.tickmark\.invalid$/);
    assert.match(demo.staffEmail, /@fictional\.tickmark\.invalid$/);
    assert.ok(demo.password.length >= 24, 'owner credential is freshly generated');
    assert.ok(demo.staffPassword.length >= 24, 'staff credential is freshly generated');
    assert.ok(demo.passphrase.length >= 32, 'practice key passphrase is freshly generated');
    assert.equal(demo.providerState, 'mail and SMS disabled; no Stripe or hosted gateway is started');
    assert.ok(existsSync(join(demo.dataDir, '.tickmark-demo.json')), 'cleanup marker is inside the private temp directory');
    assert.ok(existsSync(join(demo.samples, 'Fictional-bank-statement.pdf')));
    assert.match(readFileSync(join(demo.samples, 'Fictional-bank-statement.pdf')).toString('utf8'), /FICTIONAL TRAINING DOCUMENT/);
    assert.ok(!demo.database.startsWith(process.cwd()), 'database is outside the repository checkout');

    const db = openDatabase(demo.database);
    let server;
    try {
      const requests = db.prepare('SELECT id FROM request').all();
      assert.equal(requests.length, 4, 'four separate example requests exercise multiple states');
      const byRequest = new Map(requests.map(({ id }) => [id, requestProgress(db, id)]));
      assert.ok([...byRequest.values()].some((state) => state.toCheck > 0), 'one request has an arrival awaiting review');
      assert.ok([...byRequest.values()].some((state) => state.state === 'ready'), 'one request is fully reviewed');
      assert.ok([...byRequest.values()].some((state) => state.needsAttention > 0), 'one request demonstrates replacement needed');
      assert.ok([...byRequest.values()].some((state) => state.outstanding > 0), 'one request remains interactive and incomplete');
      const uploads = requests.flatMap(({ id }) => uploadsOf(db, id));
      assert.ok(uploads.length >= 4, "arrivals go through the application's encrypted upload endpoint");
      for (const upload of uploads) {
        const stored = db.prepare('SELECT storage_path FROM upload WHERE id = ?').get(upload.id);
        const ciphertext = readFileSync(resolve(stored.storage_path));
        assert.ok(ciphertext.subarray(0, 4).toString('ascii') === 'TKME', 'blob has Tickmark encrypted envelope');
        assert.ok(!ciphertext.includes(Buffer.from('FICTIONAL TRAINING DOCUMENT')), 'stored blob contains no sample PDF plaintext');
      }

      server = createApp(db, { blobDir: demo.blobs, mailer: null, sms: null, preHandle: demoGuide(demo.paths), log: () => {} });
      await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const guide = await fetch(`${base}${demo.paths.guide}`);
      assert.equal(guide.status, 200);
      assert.match(await guide.text(), /FICTIONAL DATA · PRIVATE LOCAL DEMO/);
      const client = await fetch(`${base}${demo.paths.clientUpload}`);
      assert.equal(client.status, 200, 'the printed bearer link opens the real client portal');
      assert.match(await client.text(), /Choose one or more documents to send/);
      assert.equal((await fetch(`${base}/assets/preflight.js`)).status, 200, 'client page dependency is served by the application');
    } finally {
      if (server?.listening) await new Promise((done) => server.close(done));
      db.close();
    }

    assert.throws(() => validateDemoDirectory(process.cwd()), /unsafe demo path/);
    assert.throws(() => removeDemoDirectory(join(demo.dataDir, '..')), /unsafe demo path/);
    removeDemoDirectory(demo.dataDir);
    assert.ok(!existsSync(demo.dataDir), 'reset removes only the validated, explicitly named demo directory');
  } finally {
    if (existsSync(demo.dataDir)) removeDemoDirectory(demo.dataDir);
  }
});

test('reset refuses a running demo process and succeeds after the demo lock is released', () => {
  const path = createDemoDirectory();
  markDemoDirectory(path);
  const lock = join(path, '.tickmark-demo.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  assert.throws(() => removeDemoDirectory(path), /demo is still running/);
  assert.ok(existsSync(path), 'refusal leaves the running demo data untouched');
  unlinkSync(lock);
  removeDemoDirectory(path);
  assert.ok(!existsSync(path), 'after stopping, exact-path cleanup succeeds');
});

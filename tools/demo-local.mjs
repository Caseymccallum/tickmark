import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { demoGuide } from './demo-guide.mjs';
import { acquireDemoLock, createDemoDirectory, releaseDemoLock, removeDemoDirectory } from './demo-safety.mjs';
import { seedDemo } from './demo-synthetic.mjs';

const dataDir = createDemoDirectory();
let demo;
let db;
let server;
let finished = false;
let locked = false;
try {
  demo = await seedDemo(dataDir);
  db = openDatabase(demo.database);
  server = createApp(db, {
    blobDir: demo.blobs,
    mailer: null,
    sms: null,
    preHandle: demoGuide(demo.paths),
  });
  const port = Number(process.env.TICKMARK_DEMO_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TICKMARK_DEMO_PORT must be between 1 and 65535.');
  acquireDemoLock(dataDir);
  locked = true;
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  console.log('FICTIONAL TRAINING DATA ONLY — private local demo; no live billing, mail or SMS providers.');
  console.log(`Open: http://127.0.0.1:${server.address().port}${demo.paths.guide}`);
  console.log(`Owner: ${demo.ownerEmail} / ${demo.password}`);
  console.log(`Assistant: ${demo.staffEmail} / ${demo.staffPassword}`);
  console.log(`Practice key passphrase: ${demo.passphrase}`);
  console.log(`Client upload: http://127.0.0.1:${server.address().port}${demo.paths.clientUpload}`);
  console.log(`Sample PDFs: ${demo.samplesList.map((name) => join(demo.samples, name)).join('; ')}`);
  console.log(`Demo data: ${demo.dataDir}`);
  console.log('Stop with Ctrl+C. Reset only after stopping: npm run demo:reset -- "<exact demo data path>"');
  const shutdown = () => {
    if (finished) return;
    finished = true;
    server.close(() => {
      db.close();
      releaseDemoLock(dataDir);
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  if (server?.listening) await new Promise((done) => server.close(done));
  db?.close();
  if (locked) {
    try { releaseDemoLock(dataDir); } catch { /* Leave a lock that cannot be verified for manual recovery. */ }
  }
  if (demo?.dataDir) {
    try { removeDemoDirectory(demo.dataDir); } catch { /* Preserve an unsafe/modified tree for manual inspection. */ }
  }
  console.error(`Tickmark local demo could not start: ${error.message}`);
  process.exitCode = 1;
}

/**
 * R1 restore drill: does a document that went in through the app come back out of a backup?
 *
 * The audit could not answer that, and "the database opens" is not an answer. This seeds a practice over HTTP — a
 * real key posted the way the setup page posts one, a real encrypted upload posted the way the client page posts one —
 * takes a backup with `tools/backup.mjs`, verifies it with the same tool, restores it into a fresh directory, and then
 * reads the practice key **out of the restored database**, unwraps it with the passphrase, and decrypts the file
 * **out of the restored blob directory**. If any link in that chain is missing the drill fails rather than reporting a
 * green light.
 *
 * Everything happens in `os.tmpdir()`. No real data, no real practice, no production path is touched.
 *
 * Run it with:  node docs/reviews/evidence/r1-restore-drill.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createHash } from 'node:crypto';

import { createApp } from '../../../src/app.js';
import { openDatabase } from '../../../src/db.js';
import { decryptEnvelope, unwrapPracticeKey } from '../../../web/tickmark-crypto.js';
import { PASSPHRASE, agent, createLink, practiceWithRequest, upload } from '../../../test/helpers.js';

const SECRET = 'Restore drill: bank statement Q1 2025, closing balance 12,345.67';
const root = mkdtempSync(join(tmpdir(), 'tickmark-drill-'));
const dataDir = join(root, 'data');
const backupDir = join(root, 'backup');
const restoredDir = join(root, 'restored');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Every file under `dir`, relative, so a copy can be compared rather than eyeballed. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

let server = null;
try {
  // --- 1. a practice, a key and an encrypted document, all through the app ---------------------------
  const db = openDatabase(join(dataDir, 'tickmark.db'));
  server = createApp(db, { blobDir: join(dataDir, 'blobs') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const practice = await practiceWithRequest({ agent: () => agent(base), db });
  const { token } = await createLink(practice.client, practice.requestId);
  const { response: sent } = await upload({
    base,
    token,
    itemId: practice.itemIds[0],
    publicKey: practice.keys.publicKey,
    plaintext: Buffer.from(SECRET),
    filename: 'bank statements.pdf',
  });
  check('a document was accepted by the running app', sent.status === 201 || sent.status === 303, `HTTP ${sent.status}`);

  // `storage_path` is the blob's absolute path on disk; the row also records the SHA-256 of the ciphertext.
  const uploadRow = db.prepare('SELECT id, storage_path FROM upload ORDER BY rowid DESC LIMIT 1').get();
  const originalBlob = readFileSync(uploadRow.storage_path);
  const originalDigest = createHash('sha256').update(originalBlob).digest('hex');
  check(
    'what the server stored is ciphertext, not the document',
    !originalBlob.toString('latin1').includes('12,345.67'),
    `${originalBlob.length} bytes`,
  );

  const before = {
    practitioners: db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n,
    requests: db.prepare('SELECT COUNT(*) AS n FROM request').get().n,
    uploads: db.prepare('SELECT COUNT(*) AS n FROM upload').get().n,
    keys: db.prepare('SELECT COUNT(*) AS n FROM practice_key').get().n,
  };
  db.close();
  await new Promise((resolve) => server.close(resolve));
  server = null;

  // --- 2. back it up, with the operator's own tool ---------------------------------------------------
  const backup = spawnSync(process.execPath, ['tools/backup.mjs', '--data', dataDir, '--to', backupDir], {
    encoding: 'utf8',
  });
  check('tools/backup.mjs took a backup', backup.status === 0, (backup.stderr || backup.stdout || '').trim().split('\n').pop() ?? '');

  const verify = spawnSync(process.execPath, ['tools/backup.mjs', '--verify', backupDir], { encoding: 'utf8' });
  check('and its own --verify accepts it', verify.status === 0, (verify.stdout || '').trim().split('\n').pop() ?? '');

  // --- 3. restore it the way the documentation says: put the copy back --------------------------------
  const backedUpDb = walk(backupDir).find((file) => file.endsWith('tickmark.db'));
  check('the backup contains a database', Boolean(backedUpDb), backedUpDb ?? 'not found');
  const backedUpRoot = dirname(join(backupDir, String(backedUpDb)));
  mkdirSync(restoredDir, { recursive: true });
  // Copy what is inside the backup, entry by entry, rather than the directory itself — "put the copy back" is a
  // statement about the contents of a data directory, not about nesting one inside another.
  for (const entry of readdirSync(backedUpRoot)) {
    cpSync(join(backedUpRoot, entry), join(restoredDir, entry), { recursive: true });
  }
  check('the backup contains the blob directory', existsSync(join(restoredDir, 'blobs')), join(restoredDir, 'blobs'));

  // The one step a restore to a *different* directory needs, and the reason it is a step rather than a surprise:
  // `upload.storage_path` holds an absolute path from the machine the backup was taken on (the `--verify` code says
  // so too, and compares only the last two segments). Put the files back at the same path and nothing is needed;
  // put them somewhere else and the rows still point at the old place, so every document read would fail while the
  // database looked perfectly healthy. This is the statement `docs/operations.md` now gives the operator.
  const restored = openDatabase(join(restoredDir, 'tickmark.db'));
  const rebased = restored
    .prepare('UPDATE upload SET storage_path = ? || substr(storage_path, ?) WHERE storage_path LIKE ?')
    .run(`${restoredDir}${sep}blobs${sep}`, `${join(dataDir, 'blobs')}`.length + 1, `${join(dataDir, 'blobs')}%`);
  check('the absolute blob paths were rebased onto the new directory', rebased.changes === before.uploads, `${rebased.changes} rows`);

  // --- 4. and the only question that matters: does the document come back out? ------------------------
  const after = {
    practitioners: restored.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n,
    requests: restored.prepare('SELECT COUNT(*) AS n FROM request').get().n,
    uploads: restored.prepare('SELECT COUNT(*) AS n FROM upload').get().n,
    keys: restored.prepare('SELECT COUNT(*) AS n FROM practice_key').get().n,
  };
  check('every row came back', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

  const restoredUpload = restored
    .prepare('SELECT storage_path, filename, size_bytes FROM upload ORDER BY rowid DESC LIMIT 1')
    .get();
  const restoredPath = restoredUpload.storage_path;
  check('the client’s file is in the restored blob directory', existsSync(restoredPath), restoredUpload.filename);

  const restoredBlob = readFileSync(restoredPath);
  check(
    'and it is byte-identical to what was backed up',
    createHash('sha256').update(restoredBlob).digest('hex') === originalDigest,
    `${restoredBlob.length} bytes`,
  );

  // The key custody chain, in full: the wrapped private key out of the *restored* database, unwrapped with the
  // passphrase the practice would type, used to open the file out of the *restored* blob directory.
  const wrapped = restored.prepare('SELECT wrapped_private_key FROM practice_key ORDER BY created_at DESC LIMIT 1').get();
  const privateKey = await unwrapPracticeKey(wrapped.wrapped_private_key, PASSPHRASE);
  const plaintext = new TextDecoder().decode(await decryptEnvelope(privateKey, new Uint8Array(restoredBlob)));
  check('the restored document decrypts with the practice’s own passphrase', plaintext === SECRET, `${plaintext.length} chars`);
  restored.close();

  // --- 5. and the honest negative: a wrong passphrase opens nothing ----------------------------------
  const wrong = await unwrapPracticeKey(wrapped.wrapped_private_key, 'not the passphrase').then(() => null, (e) => e);
  check('a wrong passphrase does not open the restored key', wrong !== null, wrong?.message ?? 'it opened');
} catch (error) {
  check('the drill ran to completion', false, error.message);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  // Windows keeps a handle on a database file for a moment after it is closed, so a drill that has already failed
  // should not also fail to tidy up.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    console.log(`(left ${root} behind — Windows had not released it)`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ' — SEE FAILURES ABOVE' : ''}`);
  process.exitCode = failed ? 1 : 0;
}

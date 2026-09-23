/**
 * The restore drill.
 *
 * `docs/operations.md` says what a restore involves — and says honestly that there is no `--restore`
 * command, deliberately, and that the proof a backup is usable is *decrypting one document out of it*.
 * That proof is thirty seconds of clicking on the one day somebody needs it. So this test does it on
 * every run:
 *
 *   1. a real encrypted document goes in through the running server, and the backup is taken while it
 *      is running — the headline claim of `tools/backup.mjs`;
 *   2. `--verify` passes, because a backup nobody checked is a hope;
 *   3. the original data directory disappears — the backup is all that is left;
 *   4. the documented restore: the copy's `tickmark.db` and `blobs/` into a new directory, keeping the
 *      layout, then the database opened the way the server would;
 *   5. and one document decrypted out of it — the key, the envelope and the bytes all came across.
 *
 * Step 5 is what a checksum cannot do: `--verify` proves every row's file is *present*; only decrypting
 * proves the bytes are the right ones. (The envelope's own `sha256` in the row checks the bytes too —
 * both, because both are cheap.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db.js';
import { decryptEnvelope } from '../web/tickmark-crypto.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

const TOOL = join(fileURLToPath(new URL('..', import.meta.url)), 'tools', 'backup.mjs');
const backup = (...args) => execFileSync(process.execPath, [TOOL, ...args, '--quiet'], { encoding: 'utf8' });

test('a backup taken while the server is running restores, and one document decrypts out of it', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'tickmark-drill-'));
  let closeRestored = () => {};
  // One hook, one order: on Windows a directory cannot be removed while the restored database still
  // holds a file open inside it, so the close happens before the sweep and never relies on hook order.
  t.after(() => {
    closeRestored();
    rmSync(scratch, { recursive: true, force: true });
  });
  const taken = join(scratch, 'backup');
  const restored = join(scratch, 'restored');

  const caught = {};
  await withServer(async ({ base, db, blobDir, agent }) => {
    const dataDir = dirname(blobDir);
    const { client, requestId, itemIds, keys, privateKey } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    const plaintext = new TextEncoder().encode('the engagement letter, in the clear');
    await upload({ base, token, itemId: itemIds[0], publicKey: keys.publicKey, plaintext, filename: 'letter.pdf' });

    caught.row = db.prepare('SELECT * FROM upload').get();
    caught.privateKey = privateKey;
    caught.plaintext = plaintext;

    backup('--data', dataDir, '--to', taken);
    backup('--verify', taken);
  });
  // The original is gone now — withServer deleted it. The backup is all that is left.

  // The documented restore, steps 3 and 4: the copy's database and documents into a new directory,
  // keeping the layout, then open the database the way the server would (which runs any migrations).
  mkdirSync(restored, { recursive: true });
  copyFileSync(join(taken, 'tickmark.db'), join(restored, 'tickmark.db'));
  cpSync(join(taken, 'blobs'), join(restored, 'blobs'), { recursive: true });
  const db = openDatabase(join(restored, 'tickmark.db'));
  closeRestored = () => db.close();

  const row = db.prepare('SELECT * FROM upload').get();
  assert.ok(row, 'the record of the document came across');
  assert.equal(row.id, caught.row.id, 'and it is the same document');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request').get().n, 1, 'the request is whole');

  const bytes = readFileSync(join(restored, 'blobs', row.request_id, `${row.id}.bin`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256, 'the bytes hash to what the record promised');

  // Step 5, automated: one document decrypted out of the backup.
  const opened = await decryptEnvelope(caught.privateKey, bytes);
  assert.deepEqual(Buffer.from(opened), Buffer.from(caught.plaintext), 'the key, the envelope and the bytes all came across');
});

test('--verify has teeth, and backups are never overwritten', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'tickmark-drill-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const taken = join(scratch, 'backup');

  let victim = null;
  await withServer(async ({ base, db, blobDir, agent }) => {
    const dataDir = dirname(blobDir);
    const { client, requestId, itemIds, keys } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);
    await upload({ base, token, itemId: itemIds[0], publicKey: keys.publicKey, plaintext: new TextEncoder().encode('x') });
    victim = db.prepare('SELECT * FROM upload').get();

    backup('--data', dataDir, '--to', taken);
    // Backups are never overwritten: a second take into the same directory is refused rather than
    // silently replacing the first copy somebody took.
    assert.throws(() => backup('--data', dataDir, '--to', taken), 'a backup is never overwritten');
  });

  // And the check that counts has teeth: a copy whose document is missing is refused, because a backup
  // missing every blob would pass a database checksum happily.
  rmSync(join(taken, 'blobs', victim.request_id, `${victim.id}.bin`));
  assert.throws(() => backup('--verify', taken), 'a copy missing its documents is not a backup');
});
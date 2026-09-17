#!/usr/bin/env node
/**
 * Open a stored envelope with the practice's passphrase.
 *
 * This exists because the browser-side *download* and decryption is not built yet, and without
 * something like it the files a client sends would be unreadable by everyone. It is a bridge,
 * and it says so here rather than being discovered later.
 *
 * It is not a second implementation of anything: the cryptography is imported from the same
 * module the browser loads, so an envelope this cannot open is a bug in one place rather than a
 * disagreement between two.
 *
 *   node tools/decrypt.mjs <data-directory> <upload-id> [-o output-file]
 *   node tools/decrypt.mjs <data-directory> --list
 *
 * The passphrase is read from `TICKMARK_PASSPHRASE` or from `--passphrase-file <path>`, and is
 * never taken as a command-line argument: a passphrase in `argv` is a passphrase in the shell's
 * history and in the process list.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decryptWithKeys, unwrapPracticeKey } from '../web/tickmark-crypto.js';

const USAGE = `usage:
  node tools/decrypt.mjs <data-directory> --list
  node tools/decrypt.mjs <data-directory> <upload-id> [-o output-file]

The passphrase comes from TICKMARK_PASSPHRASE, or from --passphrase-file <path>.`;

function fail(message, code = 64) {
  console.error(`tickmark decrypt: ${message}`);
  console.error(USAGE);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) fail('nothing to do');

const dataDir = argv[0];
const outputFlag = argv.indexOf('-o');
const output = outputFlag === -1 ? null : argv[outputFlag + 1];
const passphraseFileFlag = argv.indexOf('--passphrase-file');

if (argv.includes('--passphrase')) {
  fail('a passphrase cannot be given on the command line: it would be kept in your shell history', 64);
}

const positionals = argv.slice(1).filter((value, index) => {
  const before = argv.slice(1)[index - 1];
  return !value.startsWith('-') && before !== '-o' && before !== '--passphrase-file';
});
const mode = positionals[0];

const db = new DatabaseSync(join(dataDir, 'tickmark.db'));

if (mode === '--list' || positionals.length === 0) {
  const rows = db
    .prepare(
      `SELECT u.id, u.filename, u.size_bytes, u.uploaded_at, i.label, r.title
         FROM upload u
         JOIN request_item i ON i.id = u.request_item_id
         JOIN request r ON r.id = i.request_id
        ORDER BY u.uploaded_at`,
    )
    .all();
  if (rows.length === 0) {
    console.log('no uploads have arrived yet');
    process.exit(0);
  }
  console.log(`${rows.length} upload(s):`);
  for (const row of rows) {
    console.log(`  ${row.id}  ${row.size_bytes} bytes  ${row.filename}  (${row.title} / ${row.label})`);
  }
  process.exit(0);
}

const uploadId = mode;
const row = db
  .prepare(
    `SELECT u.storage_path, u.filename, r.practitioner_id
       FROM upload u
       JOIN request_item i ON i.id = u.request_item_id
       JOIN request r ON r.id = i.request_id
      WHERE u.id = ?`,
  )
  .get(uploadId);

if (!row) fail(`there is no upload with the id ${uploadId}`, 66);

const wrappedKeys = db
  .prepare('SELECT id, wrapped_private_key FROM practice_key WHERE practitioner_id = ? ORDER BY created_at DESC, rowid DESC')
  .all(row.practitioner_id);
if (wrappedKeys.length === 0) fail('this practice has no key on this server yet', 66);

let passphrase = process.env.TICKMARK_PASSPHRASE;
if (passphraseFileFlag !== -1) {
  const file = argv[passphraseFileFlag + 1];
  if (!file) fail('--passphrase-file needs a path');
  passphrase = (await readFile(file, 'utf8')).split(/\r?\n/)[0];
}
if (!passphrase) {
  fail('no passphrase was given. Set TICKMARK_PASSPHRASE or use --passphrase-file.', 64);
}

// Every key the practice holds, because a file sent before a rotation is encrypted to an older one.
// A passphrase that opens none of them is a wrong passphrase; one that opens some is reported, so
// that "this file will not open with that passphrase" is distinguishable from "none of these will".
const privateKeys = [];
const failures = [];
for (const key of wrappedKeys) {
  try {
    privateKeys.push(await unwrapPracticeKey(key.wrapped_private_key, passphrase));
  } catch (error) {
    failures.push(error.message);
  }
}
if (privateKeys.length === 0) fail(failures[0] ?? 'no key could be opened with that passphrase', 65);
if (privateKeys.length < wrappedKeys.length) {
  console.error(
    `tickmark decrypt: that passphrase opened ${privateKeys.length} of ${wrappedKeys.length} keys; files sent under the others will not open`,
  );
}

const envelope = await readFile(row.storage_path);
let plaintext;
try {
  plaintext = await decryptWithKeys(privateKeys, envelope);
} catch (error) {
  fail(`the stored file could not be opened: ${error.message}. It may have been altered, or it may be encrypted to a key whose passphrase you did not give.`, 65);
}

const target = output ?? row.filename;
await writeFile(target, plaintext);
console.log(`wrote ${target} (${plaintext.length} bytes, from an envelope of ${envelope.length})`);
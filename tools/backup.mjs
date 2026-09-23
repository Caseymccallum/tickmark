/**
 * A backup you can take while the server is running, and check afterwards.
 *
 *   node tools/backup.mjs --data data --to backups/2026-09-22
 *   node tools/backup.mjs --verify backups/2026-09-22
 *
 * ### Why this exists, and why it exists *now*
 *
 * Until this release the documented way to back up was `cp -r data`, and that was true: with a rollback
 * journal, a stopped server's directory is a complete copy of the product. Two things changed that, and they
 * changed together on purpose.
 *
 * 1. The database is now in **WAL mode**, which is what lets an operator tool read a live database at all. WAL
 *    keeps recent commits in a `-wal` sidecar, so a copy of `data/*.db` on its own can silently miss everything
 *    since the last checkpoint. The copy looks fine. That is the worst kind of wrong.
 * 2. The product's promise is *your data, on your hardware* — and that promise is only worth as much as being
 *    able to get it back.
 *
 * So the honest answer is `VACUUM INTO`, which takes a transactionally consistent snapshot of a live database
 * and reads correctly through the WAL. It has been in SQLite since 3.27. This tool wraps it in the two things
 * it does not do: the documents on disk, and a way to know afterwards that the copy is whole.
 *
 * ### The order matters, and the reason is a rule rather than a preference
 *
 * **The database snapshot is taken first, then the files.** Every row in that snapshot points at a blob written
 * before the snapshot existed, so every row has a file to find. Copying the files first would leave a window
 * where a document exists on disk but its row is not yet in the snapshot — an orphan, which is harmless — while
 * the reverse leaves **a row pointing at a file that is not there**, which is a document a practice believes it
 * has.
 *
 * The cost of this order is that files written *during* the copy may also be captured without a row. Those are
 * orphans in the backup, and verification counts them rather than ignoring them.
 *
 * ### Verified rather than trusted
 *
 * `--verify` re-reads the manifest and then does the only check that matters: it opens the copy's database and
 * confirms that **every upload row's file is present in the copy**. A backup that opens is not the same as a
 * backup that contains the documents, and the difference is invisible until the day somebody needs it.
 */
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { openDatabase } from '../src/db.js';

const { values } = parseArgs({
  options: {
    // No `default` on the strings: `parseArgs` requires a default to match the declared type, and both of these
    // are meant to be absent in the mode that does not use them.
    data: { type: 'string' },
    to: { type: 'string' },
    verify: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
});

const say = (line) => {
  if (!values.quiet) console.log(line);
};

/** sha256 of a file, streamed so a large blob never has to fit in memory. */
function digestOf(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Every file under a directory, as paths relative to it, with forward slashes. */
function filesUnder(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Take the backup.
 *
 * The database goes first, then the documents, and the manifest last — so a manifest is only ever written for a
 * copy that finished. An interrupted backup therefore leaves a directory with no manifest, which `--verify`
 * refuses, rather than a manifest describing something that is not there.
 */
async function takeBackup(dataDir, to) {
  const database = join(dataDir, 'tickmark.db');
  const blobs = join(dataDir, 'blobs');
  if (!existsSync(database)) {
    console.error(`There is no database at ${database}. Point --data at the directory that holds tickmark.db.`);
    process.exit(1);
  }
  if (existsSync(to) && readdirSync(to).length > 0) {
    console.error(`${to} already has something in it. Backups are never overwritten — choose a new directory.`);
    process.exit(1);
  }
  mkdirSync(to, { recursive: true });

  // **`VACUUM INTO`, not a file copy.** This is a transactionally consistent snapshot of a live database: it
  // reads through the write-ahead log, so nothing committed is missed, and a client uploading during the copy
  // cannot produce a torn one. A plain copy of the file would be both.
  const target = join(to, 'tickmark.db');
  const db = openDatabase(database);
  const counts = {
    practices: db.prepare('SELECT COUNT(*) AS n FROM practice').get().n,
    people: db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n,
    clients: db.prepare('SELECT COUNT(*) AS n FROM client').get().n,
    requests: db.prepare('SELECT COUNT(*) AS n FROM request').get().n,
    uploads: db.prepare('SELECT COUNT(*) AS n FROM upload').get().n,
  };
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  say(`database   ${counts.practices} practices, ${counts.requests} requests, ${counts.uploads} files`);

  // The documents, after the rows that point at them. See the note at the top of this file for why that order
  // is the one that cannot lose a document.
  const blobFiles = filesUnder(blobs);
  let bytes = 0;
  for (const name of blobFiles) {
    const from = join(blobs, name);
    const copy = join(to, 'blobs', name);
    mkdirSync(dirname(copy), { recursive: true });
    const contents = readFileSync(from);
    writeFileSync(copy, contents);
    bytes += contents.length;
  }
  say(`documents  ${blobFiles.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  const manifest = {
    at: new Date().toISOString(),
    from: dataDir,
    database: { file: 'tickmark.db', bytes: readFileSync(target).length, sha256: await digestOf(target) },
    blobs: { files: blobFiles.length, bytes },
    counts,
  };
  writeFileSync(join(to, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  say(`manifest   ${join(to, 'manifest.json')}`);
  say(`\nTaken. To check it:\n  node tools/backup.mjs --verify ${to}`);
}

/**
 * Check the backup, and check the thing that matters.
 *
 * Hashing the database proves the copy has not changed since it was written. It says nothing about whether the
 * documents are in it — and a backup missing every blob would pass a checksum happily. So the check that counts
 * is the last one: **every row that names a file has that file present.**
 */
async function verifyBackup(to) {
  const manifestFile = join(to, 'manifest.json');
  if (!existsSync(manifestFile)) {
    console.error(`${to} has no manifest.json, so it is not a finished backup. Nothing is verified.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const problems = [];

  const database = join(to, manifest.database.file);
  if (!existsSync(database)) {
    problems.push(`the database is missing: ${database}`);
  } else if ((await digestOf(database)) !== manifest.database.sha256) {
    problems.push('the database has changed since the backup was taken');
  } else {
    say(`database   intact (${(manifest.database.bytes / 1024 / 1024).toFixed(1)} MB, taken ${manifest.at})`);
  }

  if (problems.length === 0) {
    const db = openDatabase(database);
    const rows = db.prepare('SELECT storage_path, filename FROM upload').all();
    const present = new Set(filesUnder(join(to, 'blobs')));
    const missing = [];
    for (const row of rows) {
      // The stored path is absolute and belongs to the machine it was taken on, so what is compared is the last
      // two segments — the request id and the upload id — which are exactly what the copy preserves.
      const parts = String(row.storage_path).split(/[\\/]/).slice(-2).join('/');
      if (!present.has(parts)) missing.push(`${row.filename} (${parts})`);
    }
    const named = rows.length;
    db.close();

    if (missing.length > 0) {
      problems.push(
        `${missing.length} of ${named} documents are not in this backup. The rows that name them are, so a ` +
          `restore would look complete and be missing files. First few: ${missing.slice(0, 5).join(', ')}`,
      );
    } else {
      say(`documents  every one of the ${named} rows has its file present`);
    }

    const orphans = present.size - named;
    if (orphans > 0) {
      say(`note       ${orphans} file${orphans === 1 ? '' : 's'} with no row — written during the backup, and`);
      say('           harmless: a restore carries them and nothing reads them.');
    }
  }

  if (problems.length > 0) {
    console.error('\nThis backup has problems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nVerified. See docs/operations.md for how to restore it, and for what a restore means.');
}

if (values.verify) {
  await verifyBackup(values.verify);
} else if (values.to) {
  await takeBackup(values.data ?? 'data', values.to);
} else {
  console.error(
    'Usage:\n' +
      '  node tools/backup.mjs --data data --to backups/2026-09-22   take one\n' +
      '  node tools/backup.mjs --verify backups/2026-09-22           check one\n' +
      '\n' +
      'Back up somewhere that is not the machine the data is on. A copy beside the original is not a backup.',
  );
  process.exit(2);
}

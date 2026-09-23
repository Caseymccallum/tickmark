/**
 * A backup you can take while the server is running, and check afterwards.
 *
 *   node tools/backup.mjs --data data --to backups/2026-09-22
 *   node tools/backup.mjs --verify backups/2026-09-22
 *
 * ### Why this exists, and why it exists *now*
 *
 * Until this release the documented way to back up was `cp -r data`, and that was true: with a rollback journal, a
 * stopped server's directory is a complete copy of the product. Two things changed that, and they changed together
 * on purpose.
 *
 * 1. The database is now in **WAL mode**, which is what lets an operator tool read a live database at all. WAL keeps
 *    recent commits in a `-wal` sidecar, so a copy of `data/*.db` on its own can silently miss everything since the
 *    last checkpoint. The copy looks fine. That is the worst kind of wrong.
 * 2. The product's promise is *your data, on your hardware* — and that promise is only worth as much as being able
 *    to get it back.
 *
 * So the honest answer is `VACUUM INTO`, which takes a transactionally consistent snapshot of a live database and
 * reads correctly through the WAL. It has been in SQLite since 3.27. This tool wraps it in the two things it does
 * not do: the documents on disk, and a way to know afterwards that the copy is whole.
 *
 * ### The mechanism is one file over, because there is a second caller
 *
 * The order the copy happens in and the check that proves it are both in `tools/backup-lib.mjs`, shared with
 * `tools/backup-all.mjs` — which takes a whole tenants root, one practice at a time. This file stays the shape an
 * operator has used since the beginning: one installation, one command, one line of output. The reasoning for the
 * order belongs with the code implementing it, and lives at the top of the library.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';

import { FLEET_FILE, takeBackup, verifyBackup, verifyFleetBackup } from './backup-lib.mjs';

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

if (values.verify) {
  const target = values.verify;
  try {
    // A directory holding `fleet.json` is a whole-fleet backup, and checks itself the same way from the top. An
    // operator should not have to remember which of the two tools checks which; one `--verify` does both.
    if (!existsSync(`${target}/manifest.json`) && existsSync(`${target}/${FLEET_FILE}`)) {
      const fleet = await verifyFleetBackup(target, { say });
      if (fleet.failures.length > 0) {
        console.error('\nThis fleet backup has problems:');
        for (const failure of fleet.failures) {
          console.error(`  - ${failure.label} (${failure.id})`);
          for (const problem of failure.problems) console.error(`      ${problem}`);
        }
        process.exit(1);
      }
      console.log(`\nVerified: ${fleet.practices.length} practices and the registry. See docs/operations.md.`);
      process.exit(0);
    }
    await verifyBackup(target, { say });
  } catch (error) {
    console.error('\nThis backup has problems:');
    for (const problem of error.problems ?? [error.message]) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nVerified. See docs/operations.md for how to restore it, and for what a restore means.');
} else if (values.to) {
  const dataDir = values.data ?? 'data';
  const to = values.to;
  try {
    await takeBackup(dataDir, to, { say });
  } catch (error) {
    console.error(`tickmark backup: ${error.message}`);
    process.exit(1);
  }
  say(`manifest   ${to}/manifest.json`);
  say(`\nTaken. To check it:\n  node tools/backup.mjs --verify ${to}`);
} else {
  console.error(
    'Usage:\n' +
      '  node tools/backup.mjs --data data --to backups/2026-09-22   take one\n' +
      '  node tools/backup.mjs --verify backups/2026-09-22           check one\n' +
      '  node tools/backup.mjs --verify backups/2026-09-22           check a whole fleet too, if it is one\n' +
      '\n' +
      'Back up somewhere that is not the machine the data is on. A copy beside the original is not a backup.\n' +
      'For every practice on a multi-tenant install at once, use `node tools/backup-all.mjs`.',
  );
  process.exit(2);
}

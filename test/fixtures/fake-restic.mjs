import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const statePath = process.env.RESTIC_TEST_STATE;
const state = statePath && readFileSync(statePath, 'utf8') ? JSON.parse(readFileSync(statePath, 'utf8')) : { commands: [], snapshots: [] };
const [command, ...args] = process.argv.slice(2);
state.commands.push({ command, args });
if (command === process.env.RESTIC_TEST_FAIL_COMMAND) {
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(9);
}
if (command === 'backup') {
  state.snapshots.push({ id: '1234567890abcdef', short_id: '12345678', time: new Date().toISOString(), tags: ['tickmark-hosted'] });
}
writeFileSync(statePath, JSON.stringify(state));
if (command === 'snapshots') process.stdout.write(JSON.stringify(state.snapshots));
if (command === 'dump') {
  const snapshotMap = process.env.RESTIC_TEST_SNAPSHOT_MAP ? JSON.parse(process.env.RESTIC_TEST_SNAPSHOT_MAP) : null;
  const file = snapshotMap?.[args[0]] ?? process.env.RESTIC_TEST_LEDGER_FILE ?? join(process.env.RESTIC_TEST_RESTORE_ROOT, 'fleet.json');
  process.stdout.write(readFileSync(file, 'utf8'));
}
if (command === 'restore') {
  const target = args[args.indexOf('--target') + 1];
  for (const entry of readdirSync(process.env.RESTIC_TEST_RESTORE_ROOT)) {
    cpSync(join(process.env.RESTIC_TEST_RESTORE_ROOT, entry), join(target, entry), { recursive: true });
  }
}

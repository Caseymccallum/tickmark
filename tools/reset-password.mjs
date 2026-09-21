/**
 * Set a replaced password, from the command line.
 *
 *   node tools/reset-password.mjs --email sam@example.com --password 'a new long password'
 *   node tools/reset-password.mjs --email sam@example.com                    # generate one instead
 *   node tools/reset-password.mjs --data /srv/tickmark/data --list
 *
 * This is the honest answer for a self-hosted install, and it is deliberately a tool rather than a page.
 *
 * **Why not an emailed reset link.** For a hosted deployment that is the right feature, and `docs/saas.md`
 * has it on the list. For a practice running this themselves, an emailed link assumes a mail server is
 * configured — and the one moment somebody needs to get back into their own software is a poor time to
 * discover that it is not. Whoever can run this command can already read the database, so it grants them
 * nothing they did not have; it just saves them writing SQL against a scrypt hash they would have to
 * generate correctly.
 *
 * **Why it ends that person's sessions.** If the password was changed because it was known to somebody else,
 * leaving their sessions alive would make the change pointless: a live session does not care what the
 * password is. Every session for the account is ended, and so is every remembered token.
 *
 * **What it cannot do, and says so.** It cannot touch the passphrase that unwraps the encryption key, because
 * that is the design: nobody — not this tool, not the operator, not the practice — can recover a lost
 * passphrase. A member who has forgotten theirs can still sign in; they just cannot open what arrived until
 * somebody who holds a copy of the key re-wraps it for them.
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { hashPassword } from '../src/crypto.js';
import { practitionerByEmail } from '../src/store.js';
import { endAllSessions, MIN_PASSWORD } from '../src/auth.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: process.env.TICKMARK_DATA ?? 'data' },
    email: { type: 'string' },
    password: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
});

const file = join(values.data, 'tickmark.db');
const db = openDatabase(file);

if (values.list) {
  const people = db
    .prepare('SELECT email, created_at, removed_at FROM practitioner ORDER BY email')
    .all();
  if (people.length === 0) console.log(`${file}: no accounts yet`);
  for (const person of people) {
    console.log(`${person.email}${person.removed_at ? ' (removed)' : ''}  — joined ${person.created_at.slice(0, 10)}`);
  }
  db.close();
  process.exit(0);
}

if (!values.email) {
  console.error('Which account?  --email someone@example.com  (or --list to see them)');
  db.close();
  process.exit(2);
}

const person = practitionerByEmail(db, values.email.toLowerCase());
if (!person) {
  console.error(`No account for ${values.email} in ${file}. Use --list to see who is there.`);
  db.close();
  process.exit(1);
}

// A generated password when none is given, because the alternative is somebody choosing "password1" at
// eleven at night. Base64url of 12 bytes: 16 characters, no shell-quoting surprises.
const password = values.password ?? randomBytes(12).toString('base64url');
if (password.length < MIN_PASSWORD) {
  console.error(`That password is ${password.length} characters. This product requires at least ${MIN_PASSWORD}.`);
  db.close();
  process.exit(2);
}

db.prepare('UPDATE practitioner SET password_hash = ? WHERE id = ?').run(await hashPassword(password), person.id);
const ended = endAllSessions(db, person.id);
db.close();

console.log(`Password set for ${person.email}.`);
if (!values.password) console.log(`Generated password: ${password}`);
console.log(
  `${ended} session${ended === 1 ? '' : 's'} ended, so anyone already signed in as them is signed out.`,
);
console.log(
  'The passphrase that unwraps the encryption key was not touched, and cannot be recovered by anything —\n' +
    'see docs/encryption.md. If they have also forgotten that, somebody holding a copy of the key has to\n' +
    're-wrap it for them: docs/members.md.',
);

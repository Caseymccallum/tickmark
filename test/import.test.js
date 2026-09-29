/**
 * Bringing a practice's clients across — the front door of switching, and the pipe every integration
 * will pour into.
 *
 * The research is unambiguous that a practice will not move unless its client book moves easily, so
 * this is the feature the switch lives or dies on. It is built as one ingestion pipeline — parse,
 * map, classify, import — that a CSV drives and that Xero Practice Manager and QuickBooks will drive
 * next. If the pipeline is honest and idempotent, every source inherits that for free.
 *
 * The three properties that make it trustworthy: the dry run reports exactly what the run will do
 * without touching a row; re-importing creates nothing twice (name is the identity, case-insensitive);
 * and no row is ever dropped silently — the summary counts created, updated, unchanged and invalid
 * separately, so "imported 40" cannot quietly hide "skipped 200 you already had".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { clientRowsFromCsv, parseCsv } from '../src/http.js';
import {
  booksBehind,
  createPractice,
  createPractitioner,
  describeFilingProfile,
  filingProfileOf,
  importClients,
  previewClientImport,
  suggestRequest,
} from '../src/store.js';
import { practiceWithRequest, withServer } from './helpers.js';

test('a CSV reads the way a spreadsheet writes it', () => {
  // "Smith, Jones & Co" is one name and must not split on its comma; a doubled quote is an escaped
  // quote; a break inside a quoted cell is one break. Excel hands over a BOM, CRLF and blank lines.
  const grid = parseCsv(
    '\ufeffClient,Address\r\n"Smith, Jones & Co",sam@smith.test\r\n"Say ""hi""",x@y.test\r\n\r\n"Line\r\nbreak",z@w.test\r\n',
  );
  assert.deepEqual(grid, [
    ['Client', 'Address'],
    ['Smith, Jones & Co', 'sam@smith.test'],
    ['Say "hi"', 'x@y.test'],
    ['Line\nbreak', 'z@w.test'],
  ]);
});

test('the columns are found by name, so a file from anywhere imports', () => {
  // Tickmark's own export calls them "Client" and "Email address"; most tools say "Name" and "Email"; a
  // pasted two-column sheet has no header at all. All three become the same rows.
  assert.deepEqual(
    clientRowsFromCsv('Client,Address,Open requests\nSmith & Co,sam@smith.test,3\nJones,j@j.test,0\n'),
    [
      { name: 'Smith & Co', email: 'sam@smith.test' },
      { name: 'Jones', email: 'j@j.test' },
    ],
  );
  assert.deepEqual(clientRowsFromCsv('Name,Email\nSmith,sam@smith.test\n'), [
    { name: 'Smith', email: 'sam@smith.test' },
  ]);
  assert.deepEqual(clientRowsFromCsv('Smith,sam@smith.test\nJones,\n'), [
    { name: 'Smith', email: 'sam@smith.test' },
    { name: 'Jones', email: '' },
  ]);
});

function practice() {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-import-'));
  const db = openDatabase(join(directory, 'tickmark.db'));
  const practiceId = createPractice(db, { name: 'Lodis Accountancy' });
  const importer = createPractitioner(db, {
    practiceId,
    email: 'sam@example.test',
    passwordHash: 'scrypt$placeholder',
  });
  return { directory, db, practiceId, importer };
}

test('the preview says what an import would do, and changes nothing', async (t) => {
  const { directory, db, practiceId, importer } = practice();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  importClients(db, practiceId, importer, [
    { name: 'Smith & Co', email: 'old@smith.test' },
    { name: 'Jones', email: 'j@j.test' },
  ]);

  const before = previewClientImport(db, practiceId, [
    { name: 'Smith & Co', email: 'new@smith.test' }, // exists, email differs -> update
    { name: 'Jones', email: 'j@j.test' }, // exists, same -> unchanged
    { name: 'New Co', email: 'n@n.test' }, // absent -> create
    { name: '', email: 'x@x.test' }, // no name -> invalid
  ]);
  assert.equal(before.create, 1);
  assert.equal(before.update, 1);
  assert.equal(before.unchanged, 1);
  assert.equal(before.invalid, 1);
  // The dry run computed the run but did not perform it: Smith keeps the old address, and no client
  // has appeared yet.
  assert.equal(
    db.prepare('SELECT email FROM client WHERE practice_id = ? AND name = ?').get(practiceId, 'Smith & Co').email,
    'old@smith.test',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client WHERE practice_id = ?').get(practiceId).n, 2);
  db.close();
});

test('importing twice creates nothing twice, and fills in addresses', async (t) => {
  const { directory, db, practiceId, importer } = practice();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = importClients(db, practiceId, importer, [
    { name: 'Smith & Co', email: '' },
    { name: 'Jones', email: 'j@j.test' },
  ]);
  assert.equal(first.created, 2);
  assert.equal(first.updated, 0);
  assert.equal(first.unchanged, 0);

  // Re-import: the same names are found rather than duplicated, and Smith's blank address is filled.
  const second = importClients(db, practiceId, importer, [
    { name: 'Smith & Co', email: 'sam@smith.test' }, // case-insensitive match, email now set -> update
    { name: 'jones', email: 'j@j.test' }, // case-insensitive match, same -> unchanged
    { name: 'New Co', email: '' }, // absent -> create
    { name: '', email: '' }, // no name -> invalid
  ]);
  assert.equal(second.created, 1);
  assert.equal(second.updated, 1);
  assert.equal(second.unchanged, 1);
  assert.equal(second.invalid, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client WHERE practice_id = ?').get(practiceId).n, 3);
  assert.equal(
    db.prepare('SELECT email FROM client WHERE practice_id = ? AND name = ?').get(practiceId, 'Smith & Co').email,
    'sam@smith.test',
  );
  db.close();
});

test('the import page previews first, then imports, and never writes before the confirm', async () => {
  await withServer(async ({ agent, db }) => {
    // The practice already has "Northwind Ltd" (with its address) from the helper, so this file has
    // one genuinely new client and one that is already there.
    const { client } = await practiceWithRequest({ agent, db });
    const csv = 'Client,Address\nNew Co,n@new.example\nNorthwind Ltd,accounts@northwind.example\n';

    const form = await client.get('/clients/import');
    assert.equal(form.status, 200);
    assert.match(await form.text(), /Preview the import/);

    // The preview reports what would happen and changes nothing.
    const preview = await client.post('/clients/import', { csv });
    assert.equal(preview.status, 200);
    const previewText = await preview.text();
    assert.match(previewText, /Nothing has been changed yet/);
    assert.match(previewText, /Do the import/);
    assert.match(previewText, /already there/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client WHERE name = ?').get('New Co').n, 0);

    // The confirm does it, and says so.
    const run = await client.post('/clients/import', { csv, run: '1' });
    assert.equal(run.status, 200);
    assert.match(await run.text(), /Clients imported/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client WHERE name = ?').get('New Co').n, 1);
    // And the already-there client was not duplicated by the run.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client WHERE name = ?').get('Northwind Ltd').n, 1);
  });
});

test('an import brings the client’s filing profile along with their name', async (t) => {
  const { directory, db, practiceId, importer } = practice();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // A Xero organisation's profile rides the row and lands on the client with the name.
  importClients(db, practiceId, importer, [
    { name: 'Northwind Ltd', email: '', filingProfile: { entityType: 'COMPANY', yearEnd: { day: 31, month: 3 }, taxNumber: 'GB123' } },
  ]);
  const id = db.prepare('SELECT id FROM client WHERE practice_id = ? AND name = ?').get(practiceId, 'Northwind Ltd').id;
  assert.equal(filingProfileOf(db, id).entityType, 'COMPANY', 'the profile came with the name');
  assert.deepEqual(filingProfileOf(db, id).yearEnd, { day: 31, month: 3 });

  // A re-import that carries no profile (a CSV) must not erase one a connection already read.
  importClients(db, practiceId, importer, [{ name: 'Northwind Ltd', email: 'n@n.test' }]);
  assert.equal(filingProfileOf(db, id).entityType, 'COMPANY', 'and a source without one leaves it alone');

  // A fresh profile does overwrite: a re-read from the connection is the newer truth.
  importClients(db, practiceId, importer, [{ name: 'Northwind Ltd', email: '', filingProfile: { entityType: 'TRUST' } }]);
  assert.equal(filingProfileOf(db, id).entityType, 'TRUST');
  db.close();
});

test('a filing profile reads as one honest line, inventing nothing', () => {
  assert.equal(
    describeFilingProfile({ entityType: 'COMPANY', yearEnd: { day: 31, month: 3 }, taxNumber: 'GB123' }),
    'limited company · year end 31 March · tax GB123',
  );
  // QuickBooks states a month alone, so the day is absent and no number is put in front of the month.
  assert.equal(
    describeFilingProfile({ entityType: 'SOLETRADER', yearEnd: { day: null, month: 12 } }),
    'sole trader · year end December',
  );
  assert.equal(describeFilingProfile({}), '', 'a profile with nothing in it says nothing');
  assert.equal(describeFilingProfile(null), '');
});

test('books are flagged behind on a pile of unreconciled lines, or on silence', () => {
  const today = new Date('2026-09-28');
  assert.equal(booksBehind(null, today), false, 'no signal is not behind');
  assert.equal(booksBehind({ unreconciled: 0, lastActivityAt: '2026-09-20' }, today), false, 'nothing outstanding is not behind');
  assert.equal(booksBehind({ unreconciled: 2, lastActivityAt: '2026-09-20' }, today), false, 'a couple of lines is ordinary');
  assert.equal(booksBehind({ unreconciled: 5, lastActivityAt: '2026-09-20' }, today), true, 'a pile is a cue to ask for records');
  // Nothing moving for a quarter is behind even with a clean reconciliation.
  assert.equal(booksBehind({ unreconciled: 0, lastActivityAt: '2026-01-01' }, today), true, 'and so is a long silence');
});

test('a request is suggested from the client’s own books', () => {
  const suggestion = suggestRequest(
    { entityType: 'COMPANY', yearEnd: { day: 31, month: 3 }, taxNumber: 'GB123' },
    new Date(2026, 8, 29),
  );
  assert.equal(suggestion.title, 'Documents for the year ending 31 March 2027', 'the next 31 March, named');
  assert.equal(suggestion.dueAt, '2027-04-30', 'due a little after the year-end, for they will adjust it');
  assert.ok(suggestion.items.includes('Statutory accounts'), 'a limited company’s checklist');
  assert.ok(suggestion.items.includes('Corporation tax computation'));

  // A 30 September year-end is tomorrow, so the request is for this year, not next.
  const september = suggestRequest({ entityType: 'SOLETRADER', yearEnd: { day: 30, month: 9 } }, new Date(2026, 8, 29));
  assert.equal(september.title, 'Documents for the year ending 30 September 2026');
  assert.ok(september.items.includes('Income and expenses records'), 'a sole trader’s checklist');
});

test('a suggestion never invents a date it was not given', () => {
  assert.equal(suggestRequest(null), null, 'no profile is no suggestion');
  // QuickBooks states a month alone: the checklist still comes, but no day is put in the title.
  const undated = suggestRequest({ entityType: 'TRUST', yearEnd: { month: 12 } }, new Date(2026, 8, 29));
  assert.equal(undated.title, 'Documents for the year ending December 2026', 'the month is kept, no day invented');
  assert.equal(undated.dueAt, '2026-12-31', 'and the date is built from the month alone');
  assert.ok(undated.items.includes('Trust accounts'));
  const dateless = suggestRequest({ entityType: 'PARTNERSHIP' }, new Date(2026, 8, 29));
  assert.equal(dateless.title, null, 'no year-end at all, no title naming one');
  assert.equal(dateless.dueAt, null);
});
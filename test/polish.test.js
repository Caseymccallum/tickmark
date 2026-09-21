/**
 * The four things a practice needs that the product did not have: correcting a document's wording, closing a
 * season in one go, reading dates on their own calendar, and getting back in when a password is lost.
 *
 * The last one is a command-line tool rather than a page, for a reason the test states: an emailed reset link
 * assumes a mail server is configured, and the moment somebody needs to get back into their own software is a
 * poor time to discover that it is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { createPractice, createPractitioner, itemsOf } from '../src/store.js';
import { createSession } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';
import { dateIn, knownZone, todayIn } from '../src/clock.js';
import { PASSWORD, createLink, practiceWithRequest, signUp, upload, withServer } from './helpers.js';

// --- correcting a document's wording -----------------------------------------------------------

test('a document\u2019s wording can be corrected without withdrawing and re-asking', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
    const [first] = itemsOf(db, requestId);
    assert.equal(first.label, 'Bank statements', 'the checklist starts as typed');

    const renamed = await client.post(`/requests/${requestId}/items/${itemIds[0]}/relabel`, {
      label: 'Bank statements, all accounts',
      note: 'Every account, please',
    });
    assert.equal(renamed.status, 303);

    const after = itemsOf(db, requestId)[0];
    assert.equal(after.label, 'Bank statements, all accounts', 'the words are corrected');
    assert.equal(after.note, 'Every account, please', 'and so is the note');
    assert.equal(after.id, first.id, 'with the same id, so nothing about the record forks');

    // The client never sees a withdrawn-and-readded document: one item, corrected.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request_item WHERE request_id = ?').get(requestId).n,
      3,
      'still three documents, not four',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request_item WHERE withdrawn_at IS NOT NULL').get().n,
      0,
      'and none of them was withdrawn to get here',
    );

    const [event] = db.prepare("SELECT kind, detail FROM event WHERE kind = 'item.edited'").all();
    assert.ok(event, 'the correction is recorded');
    assert.match(event.detail, /Bank statements → Bank statements, all accounts/, 'saying what it was and what it became');
  });
});

test('a correction that changes nothing is not an event, and an empty name is refused', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId, itemIds } = await practiceWithRequest({ agent, db });
    const before = db.prepare('SELECT COUNT(*) AS n FROM event').get().n;

    const same = await client.post(`/requests/${requestId}/items/${itemIds[0]}/relabel`, { label: 'Bank statements' });
    assert.equal(same.status, 404, 'nothing to do reads as "not found", because nothing changed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event').get().n, before, 'and nothing was written');

    const blank = await client.post(`/requests/${requestId}/items/${itemIds[0]}/relabel`, { label: '   ' });
    assert.equal(blank.status, 404, 'a document cannot be left nameless');
    assert.equal(itemsOf(db, requestId)[0].label, 'Bank statements', 'and the words are untouched');
  });
});

// --- the practice's own calendar ----------------------------------------------------------------

test('the date a practice reads is their own, not Greenwich\u2019s', () => {
  // 2026-03-31T13:00Z: still the 31st in London, already the 1st of April in Auckland, still the 31st in
  // Honolulu. The one comparison this product makes about time is "is this due date past?", and answering it
  // in UTC is wrong for part of every day at both ends of the world.
  const when = new Date('2026-03-31T13:00:00Z');
  assert.equal(dateIn('Europe/London', when), '2026-03-31');
  assert.equal(dateIn('Pacific/Auckland', when), '2026-04-01');
  assert.equal(dateIn('America/Los_Angeles', when), '2026-03-31');
  assert.equal(dateIn('Asia/Kolkata', when), '2026-03-31');

  // Late evening UTC is already tomorrow across the date line, and still today in the Americas.
  const late = new Date('2026-03-31T23:30:00Z');
  assert.equal(dateIn('Pacific/Auckland', late), '2026-04-01');
  assert.equal(dateIn('America/New_York', late), '2026-03-31');
});

test('an unknown zone falls back to UTC rather than breaking the page, and is refused when set', () => {
  assert.equal(dateIn('Mars/Olympus', new Date('2026-03-31T13:00:00Z')), '2026-03-31', 'the fallback is UTC');
  assert.equal(dateIn(null, new Date('2026-03-31T13:00:00Z')), '2026-03-31', 'and so is no setting at all');
  assert.equal(knownZone('Europe/London'), true);
  assert.equal(knownZone('Mars/Olympus'), false);
  assert.equal(knownZone(''), true, 'empty means "not saying", which is UTC rather than an error');

  // Daylight saving is the reason a zone is stored instead of an offset: an offset is wrong twice a year, in
  // exactly the weeks an accountant is busy.
  assert.equal(dateIn('Europe/London', new Date('2026-01-15T12:00:00Z')), '2026-01-15');
  assert.equal(dateIn('Europe/London', new Date('2026-07-15T12:00:00Z')), '2026-07-15');
  assert.equal(todayIn('Europe/London', new Date('2026-07-15T12:00:00Z')), '2026-07-15');
});

test('a practice can set where it is, and a nonsense zone is refused rather than ignored', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });

    const members = await (await client.get('/members')).text();
    assert.match(members, /name="timezone"/, 'the setting is on the practice\u2019s own page');
    assert.match(members, /Pacific\/Auckland/, 'as a list of real zones, not a text field');

    const saved = await client.post('/members/name', { name: 'Northwind Books', timezone: 'Pacific/Auckland' });
    assert.equal(saved.status, 303);
    assert.equal(
      db.prepare('SELECT timezone FROM practice').get().timezone,
      'Pacific/Auckland',
      'and it is stored',
    );

    const refused = await client.post('/members/name', { name: 'Northwind Books', timezone: 'Mars/Olympus' });
    assert.equal(refused.status, 400, 'a zone the runtime does not know is refused');
    assert.equal(
      db.prepare('SELECT timezone FROM practice').get().timezone,
      'Pacific/Auckland',
      'so a typo cannot silently put the practice back on UTC',
    );
  });
});

// --- getting back in ----------------------------------------------------------------------------

test('a lost password is replaced from the command line, and every session with it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-reset-'));
  try {
    const db = openDatabase(join(directory, 'tickmark.db'));
    const practiceId = createPractice(db, { name: 'Lodis Accountancy' });
    const person = createPractitioner(db, {
      practiceId,
      email: 'sam@example.test',
      passwordHash: await hashPassword('the original password'),
    });
    createSession(db, person);
    createSession(db, person);
    db.close();

    const tool = join(process.cwd(), 'tools', 'reset-password.mjs');

    const listed = execFileSync('node', [tool, '--data', directory, '--list'], { encoding: 'utf8' });
    assert.match(listed, /sam@example\.test/, 'the operator can see who is there before touching anything');

    const generated = execFileSync('node', [tool, '--data', directory, '--email', 'sam@example.test'], {
      encoding: 'utf8',
    });
    const password = /Generated password: (\S+)/.exec(generated)?.[1];
    assert.ok(password, 'a password is generated when none is given, rather than leaving it to be chosen badly');
    assert.ok(password.length >= 12, 'and it is long enough for the product\u2019s own rule');
    assert.match(generated, /2 sessions ended/, 'and being signed in elsewhere stops working');

    const reopened = openDatabase(join(directory, 'tickmark.db'));
    assert.equal(
      reopened.prepare('SELECT COUNT(*) AS n FROM session').get().n,
      0,
      'every remembered token is gone — a live session does not care what the password is',
    );
    const stored = reopened.prepare('SELECT password_hash FROM practitioner WHERE email = ?').get('sam@example.test');
    reopened.close();

    // The generated password is the one that works, checked against the same verifier sign-in uses.
    const { verifyPassword } = await import('../src/crypto.js');
    assert.equal(await verifyPassword(password, stored.password_hash), true, 'and it opens the account');

    // An account that does not exist is refused, with a non-zero exit code so a script notices.
    let code = 0;
    try {
      execFileSync('node', [tool, '--data', directory, '--email', 'nobody@example.test', '--password', 'x'.repeat(14)], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      code = error.status;
    }
    assert.equal(code, 1, 'a typo in the address is an error, not a silent nothing');
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      console.warn(`left behind: ${directory}`);
    }
  }
});

test('signing up still enforces the length the reset tool enforces', async (t) => {
  await withServer(async ({ agent }) => {
    const tooShort = await signUp(agent(), 'sam@practice.example', 'eleven char');
    assert.equal(tooShort.status, 400, 'eleven characters is not enough, wherever the password comes from');
    assert.match(await tooShort.text(), /at least 12 characters/);

    const fine = await signUp(agent(), 'sam@practice.example', PASSWORD);
    assert.equal(fine.status, 303, 'and twelve is enough');
  });
});

test('several requests can be closed at once, and unfinished ones are the practice\u2019s call', async (t) => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const client = practice.client;

    // A request that is genuinely *finished* by the product's definition: every document sent, and looked at.
    // A brand-new request is not finished — nothing has arrived — which is the distinction this page is built
    // on, so the fixture has to make the distinction real rather than assume it.
    const done = await client.post('/requests', { client: 'Lodis Ltd', title: '2025 filing', items: 'Accounts' });
    const doneId = done.headers.get('location').split('/').pop();
    const doneItem = db.prepare('SELECT id FROM request_item WHERE request_id = ?').get(doneId).id;
    const { token } = await createLink(client, doneId);
    const anonymous = agent();
    const sent = await upload({
      base,
      token,
      itemId: doneItem,
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('the accounts'),
      filename: 'accounts.pdf',
    });
    assert.ok(sent.response.ok, 'the document arrived');
    await client.post(`/requests/${doneId}/items/${doneItem}/check`, {});
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request WHERE closed_at IS NULL').get().n,
      2,
      'both requests are open when the page is asked for',
    );

    const listed = await (await client.get('/requests/close')).text();
    assert.match(listed, /Close several at once/, 'there is a page for it');
    assert.match(listed, /Still owed something/, 'requests with documents outstanding are separated out');

    const ticked = [...listed.matchAll(/value="([0-9a-f-]{36})" checked/g)].map((m) => m[1]);
    assert.deepEqual(ticked, [doneId], 'the finished one is ticked already, and the unfinished one is not');

    const closed = await client.post('/requests/close', { request_id: [doneId] });
    assert.equal(closed.status, 303);
    assert.equal(closed.headers.get('location'), '/requests/close?closed=1', 'and it says how many it did');

    const after = await (await client.get('/requests/close?closed=1')).text();
    assert.match(after, /<strong>1 closed\.<\/strong>/, 'the page confirms rather than doing it quietly');
    assert.equal(
      db.prepare('SELECT closed_at FROM request WHERE id = ?').get(doneId).closed_at !== null,
      true,
      'that request is closed',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request WHERE closed_at IS NULL').get().n,
      1,
      'and the one still owed something is untouched',
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'request.closed'").get().n,
      1,
      'and it recorded its own event, through the single-request path rather than a second implementation',
    );
  });
});

test('closing nothing says so instead of looking like it worked', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });

    const nothing = await client.post('/requests/close', {});
    assert.equal(nothing.status, 303);
    assert.equal(nothing.headers.get('location'), '/requests/close?nothing=1');

    const page = await (await client.get('/requests/close?nothing=1')).text();
    assert.match(page, /Nothing was ticked/, 'it says nothing happened');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM request WHERE closed_at IS NOT NULL').get().n,
      0,
      'and nothing was closed',
    );
  });
});

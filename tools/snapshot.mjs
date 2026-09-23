/**
 * Render every page to a file, so the look can be checked without clicking through a browser.
 *
 * A development aid, not part of the product: it drives the real server over HTTP exactly as a
 * person would — the same helpers the tests use — and writes what came back to `tmp-snapshot/`,
 * with an `INDEX.txt` naming each page and its status. `npm test` never runs this, and nothing in
 * `src/` knows it exists.
 *
 *   node tools/snapshot.mjs [outdir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLink, practiceWithRequest, upload, withServer } from '../test/helpers.js';

const out = process.argv[2] ?? 'tmp-snapshot';
mkdirSync(out, { recursive: true });

const pages = [];
let anonymous = null;

/** Fetch one page, write it, and remember it for the index. */
async function save(name, path, client) {
  const response = await client.get(path);
  const text = await response.text();
  const file = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`;
  writeFileSync(join(out, file), text);
  pages.push(`${String(response.status).padEnd(4)} ${name.padEnd(28)} ${path} -> ${file}`);
  return { status: response.status, text };
}

await withServer(async ({ base, agent, db }) => {
  // A practice with a key, a client and a request — the shape a real one has.
  const practice = await practiceWithRequest({ agent, db }, 'sam@acme.example');
  const client = practice.client;
  const clientId = db.prepare('SELECT id FROM client ORDER BY created_at LIMIT 1').get().id;
  anonymous = agent();

  await save('landing, signed out', '/', anonymous);
  await save('sign-in form', '/signin', anonymous);
  await save('sign-up form', '/signup', anonymous);
  await save('board', '/requests', client);
  await save('board, closed tab', '/requests?closed=1', client);
  await save('clients', '/clients', client);
  await save('client', `/clients/${clientId}`, client);
  await save('request', `/requests/${practice.requestId}`, client);
  await save('edit request', `/requests/${practice.requestId}/edit`, client);
  await save('close several', '/requests/close', client);

  // A saved list, created the way a practice creates one, so the templates pages and the bulk-send page are
  // captured with real content rather than as empty states.
  const made = await client.post('/templates', {
    name: 'Sole trader — annual accounts',
    items: 'Photo ID\nBank statements, all accounts\nLast year’s return',
    note: 'Please send these by the end of the month.',
  });
  const templateId = made.headers.get('location')?.split('/').pop();
  await save('templates', '/templates', client);
  if (templateId) await save('template', `/templates/${templateId}`, client);
  await save('ask everyone', templateId ? `/ask-everyone?template=${templateId}` : '/ask-everyone', client);
  await save('new request', '/requests/new', client);
  await save('new request, duplicated', `/requests/new?from=${practice.requestId}`, client);
  await save('keys', '/keys', client);
  await save('members', '/members', client);
  await save('setup, key already made', '/setup', client);
  await save('chase', '/chase', client);
  await save('mail test', '/admin/test-email', client);

  // The page a client sees — the only one a client ever sees.
  const { token } = await createLink(client, practice.requestId);
  if (!token) throw new Error('the snapshot could not create a link, so the client page was not captured');

  const before = await save('client page', `/r/${token}`, anonymous);
  const itemId = new RegExp(`/r/${token}/items/([0-9a-f-]{36})`).exec(before.text)?.[1];
  if (!itemId) throw new Error('the client page offered nowhere to put a file');

  // One document sent, so the client page and the practice's page show a state rather than columns
  // of dashes — which is the whole reason there is a screenshot at all.
  const sent = await upload({
    base,
    token,
    itemId,
    publicKey: practice.keys.publicKey,
    plaintext: Buffer.from('the 2025 bank statements'),
    filename: 'statements-2025.pdf',
  });
  if (!sent.response.ok) throw new Error(`the snapshot upload was refused: ${sent.response.status}`);

  await save('client page, one sent', `/r/${token}`, anonymous);
  await save('request, one received', `/requests/${practice.requestId}`, client);

  // A contact recorded by hand: the form, the confirmation, and the line that says when they were last in touch.
  // This is the state a practice is in after phoning somebody, and it is the state the chase cadence reads.
  const contacted = await client.post(`/requests/${practice.requestId}/contact`, {
    note: 'Phoned — Sarah says the statements are with the bank',
  });
  if (contacted.status !== 303) throw new Error(`the snapshot could not record a contact: ${contacted.status}`);
  await save('request, a call recorded', `/requests/${practice.requestId}?contacted=1`, client);

  // The practice looks at what arrived, so the request is no longer "files to check"...
  const checked = await client.post(`/requests/${practice.requestId}/items/${itemId}/check`, {});
  if (checked.status !== 303) throw new Error(`the snapshot could not check the item: ${checked.status}`);

  // ...and then the client answers about one of the others, which is a state of its own: the request is no longer
  // waiting on the client, it is waiting on a decision. Captured because a state nobody can see a picture of is a
  // state nobody can check.
  const answered = await anonymous.post(`/r/${token}/items/${practice.itemIds[1]}/says`, { says: 'do-not-have' });
  if (answered.status !== 303) throw new Error(`the client answer was refused: ${answered.status}`);
  await save('client page, one answered', `/r/${token}`, anonymous);
  await save('board, with an answer to read', '/requests', client);
  await save('request, client answered', `/requests/${practice.requestId}`, client);
  await save('link that does not exist', '/r/not-a-real-token-at-all', anonymous);

  // A request with a note to the client, which is the newest thing on the client's page and the
  // easiest to get wrong — it is the practice's own words, so it must escape and keep its breaks.
  const withNote = await client.post('/requests', {
    client: 'Lodis Ltd',
    client_email: 'accounts@lodis.example',
    title: '2026 corporate tax filing',
    client_note: 'Hi Sarah,\n\nHere is the list for your 2026 corporate tax filing. Please upload these by Friday.',
    items: 'Accounts for the year\nCorporation tax return\nDirector loan statement',
  });
  const notingId = (withNote.headers.get('location') ?? '').split('/').pop();
  const notingLink = await createLink(client, notingId);
  if (notingLink.token) {
    await save("client page, with the practice's note", `/r/${notingLink.token}`, anonymous);
  }

  // The three ways a client speaks, on the page where they do it: a message, a document nobody asked for, and
  // the practice's own contact details. Captured here rather than after the due-ask block below, because a
  // closed request suppresses most of what is worth looking at.
  await client.post('/members/name', {
    name: 'Lodge & Co',
    contact_email: 'hello@lodgeandco.example',
    contact_phone: '0161 496 0000',
  });
  if (notingLink.token) {
    await anonymous.post(`/r/${notingLink.token}/message`, {
      body: 'The accounts are in the post — the bank said five working days. I will send the return myself.',
    });
    await save('client page, after writing a message', `/r/${notingLink.token}?said=1`, anonymous);
    await save('client page, message sent', `/r/${notingLink.token}`, anonymous);
    await save('request, with a message from the client', `/requests/${notingId}`, client);
  }

  // The year coming round, captured **last** — and the ordering is the whole reason it is here.
  //
  // Showing it means backdating the first request by a year and closing it, because that is what "due an ask"
  // means: nothing open, last asked in this month of an earlier year. A closed request suppresses most of the
  // states worth looking at — the review prose, the bulk-check button, the contact form's context — so while this
  // block sat in the middle, every client-page and request-page screenshot after it was quietly a picture of a
  // closed request, and the bulk-check button appeared in none of them.
  const lastYear = new Date();
  lastYear.setFullYear(lastYear.getFullYear() - 1);
  db.prepare('UPDATE request SET created_at = ? WHERE id = ?').run(lastYear.toISOString(), practice.requestId);
  db.prepare('UPDATE request SET closed_at = ? WHERE id = ?').run(lastYear.toISOString(), practice.requestId);
  await save('clients, due to be asked', '/clients?due=1', client);
  await save('ask everyone, due pre-ticked', '/ask-everyone?due=1', client);
  // The half that lived only on the clients page until now: the board saying the year has come round.
  await save('board, the season coming round', '/requests', client);

  // Two-factor, captured **last of all**, because arming it changes how this fixture signs in — and every
  // screenshot above needs the ordinary single-step sign-in that the rest of the tool assumes.
  //
  // The secret is read from the database rather than scraped off the page: the page shows it in readable groups
  // for a human, and a test that parsed those back would be testing the display instead of the protocol.
  await save('two-factor, not set up', '/account/two-factor', client);
  await client.post('/account/two-factor/start', {});
  await save('two-factor, half done', '/account/two-factor', client);

  const { twoFactorState } = await import('../src/auth.js');
  const { codeAt, counterAt } = await import('../src/totp.js');
  const rows = db.prepare('SELECT id FROM practitioner ORDER BY created_at LIMIT 1').all();
  const armed = twoFactorState(db, rows[0].id);
  if (armed.state === 'unconfirmed' && rows.length === 1) {
    const confirmed = await client.post('/account/two-factor/confirm', {
      code: codeAt(armed.secret, counterAt()),
    });
    await writeFileSync(join(out, 'two-factor-recovery-codes.html'), await confirmed.text());
    pages.push(`200  two-factor, recovery codes      /account/two-factor (post) -> two-factor-recovery-codes.html`);
    await save('two-factor, on', '/account/two-factor', client);
  }
});

writeFileSync(join(out, 'INDEX.txt'), `${pages.join('\n')}\n`);
console.log(`wrote ${pages.length} pages to ${out}\n\n${pages.join('\n')}`);

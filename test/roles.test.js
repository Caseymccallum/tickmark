/**
 * Who may do what, and the two things that make this a permission rather than a promise.
 *
 * The first is that the check is in the dispatcher, not in the handlers — so the whole model can be read off
 * the route table, and the test below walks that table and fails when a sensitive address has no role beside
 * it. The second is that an assistant genuinely cannot open anything: their role is enforced by the server
 * *and* by the absence of a wrapped copy of the practice key, and a demotion takes that copy away rather
 * than merely hiding a button.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROUTES } from '../src/app.js';
import { createPractitioner } from '../src/store.js';
import { hashPassword } from '../src/crypto.js';
import { holdsKey, isSensitive, refusalFor, roleMeets } from '../src/roles.js';
import { PASSWORD, agent, createLink, practiceWithRequest, signUp, upload, withServer } from './helpers.js';

/** Add a colleague with a chosen role, and hand back an agent signed in as them. */
async function colleague(base, db, role, email = `${role}@practice.example`) {
  const practiceId = db.prepare('SELECT id FROM practice').get().id;
  createPractitioner(db, { practiceId, email, passwordHash: await hashPassword(PASSWORD), role });
  const signedIn = agent(base);
  const response = await signedIn.post('/signin', { email, password: PASSWORD });
  assert.equal(response.status, 303, `${role} can sign in`);
  return signedIn;
}

// --- the invariant that keeps this maintainable -------------------------------------------------

test('every sensitive route declares who may use it', () => {
  // This is the test that makes the rest of the model survivable. A new route under `/members` or `/keys`
  // cannot be added without somebody making a decision about it, because this refuses to pass until they
  // have. Without it, the way to find out what an assistant can do would be to read every handler and hope.
  const untagged = ROUTES.filter(([, pattern, , needed]) => isSensitive(pattern) && !needed);
  assert.deepEqual(
    untagged.map(([, pattern]) => String(pattern)),
    [],
    'these addresses are in a sensitive area but name no role',
  );

  // And the roles it names are real ones, so a typo cannot quietly become "no permission at all".
  for (const [, pattern, handler, needed] of ROUTES) {
    if (!needed) continue;
    assert.ok(['owner', 'accountant', 'assistant'].includes(needed), `${String(pattern)} names a real role`);
    assert.equal(typeof handler, 'function', `${String(pattern)} has a handler`);
  }
});

test('the model reads the way it says it does', () => {
  assert.equal(roleMeets(null, 'owner'), true, 'an absent role reads as what every member had before roles');
  assert.equal(roleMeets('owner', 'accountant'), true, 'an owner can do an accountant\u2019s work');
  assert.equal(roleMeets('accountant', 'owner'), false, 'and not the other way round');
  assert.equal(roleMeets('assistant', 'accountant'), false, 'an assistant does not hold the key');

  assert.equal(holdsKey('assistant'), false, 'which is exactly what holdsKey answers');
  assert.equal(holdsKey('accountant'), true);
  assert.equal(holdsKey(null), true, 'and a role that predates roles holds one, because it did');

  // The refusal names the reason rather than a code, because the reason is not a secret — it tells them
  // whose job it is and what to ask for.
  assert.match(refusalFor('accountant', 'assistant'), /copy/);
});

// --- enforcement, at the server ------------------------------------------------------------------

test('an assistant is refused the keys, the members, and the mail relay', async () => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const helper = await colleague(base, db, 'assistant');

    for (const path of ['/members', '/keys', '/admin/test-email', '/setup']) {
      const refused = await helper.get(path);
      assert.equal(refused.status, 403, `${path} is refused`);
      assert.match(await refused.text(), /owner|passphrase/i, 'and says why in words a person can act on');
    }

    assert.equal((await practice.client.get('/members')).status, 200, 'the owner still reaches the members page');
  });
});

test('an assistant is refused a client document, and told what that means', async () => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const itemId = db.prepare('SELECT id FROM request_item WHERE request_id = ?').get(practice.requestId).id;
    const sent = await upload({
      base,
      token,
      itemId,
      publicKey: practice.keys.publicKey,
      plaintext: Buffer.from('bank statements'),
      filename: 'statements.pdf',
    });
    assert.ok(sent.response.ok, 'a document arrived');

    const helper = await colleague(base, db, 'assistant');
    const requestPage = await helper.get(`/requests/${practice.requestId}`);
    assert.equal(requestPage.status, 200, 'an assistant can open the request');
    const page = await requestPage.text();
    assert.match(page, /you cannot open/, 'and is told plainly that they cannot open what arrived');
    assert.ok(!page.includes('/assets/download.js'), 'and is not handed a control that would refuse them');

    // The address itself refuses, which is the part that matters: hiding a button is not a permission.
    const uploadRow = db.prepare('SELECT id FROM upload LIMIT 1').get();
    const refused = await helper.get(`/requests/${practice.requestId}/files/${uploadRow.id}`);
    assert.equal(refused.status, 403, 'the document address refuses an assistant at the server');
    assert.equal(
      (await practice.client.get(`/requests/${practice.requestId}/files/${uploadRow.id}`)).status,
      200,
      'and serves it to somebody who holds the key',
    );
  });
});

test('an assistant can still do the job they were given', async () => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const helper = await colleague(base, db, 'assistant');

    // The board, the client list, the request itself, and the chase: the whole of an assistant's work.
    for (const path of ['/requests', '/clients', '/chase', `/requests/${practice.requestId}`]) {
      assert.equal((await helper.get(path)).status, 200, `${path} is theirs`);
    }
    // Asking a client for a document, and recording that it happened, are both coordination.
    assert.ok((await helper.post(`/requests/${practice.requestId}/link`, { days: '30' })).ok, 'they can issue a link');
    assert.equal(
      (await helper.post(`/requests/${practice.requestId}/contact`, { note: 'rang the office' })).status,
      303,
      'and record a phone call',
    );
    // Saying a document has been looked at is not coordination, and is refused where the action is known.
    const itemId = db.prepare('SELECT id FROM request_item WHERE request_id = ?').get(practice.requestId).id;
    const check = await helper.post(`/requests/${practice.requestId}/items/${itemId}/check`, {});
    assert.equal(check.status, 403, 'but they cannot say a file has been checked');
  });
});

// --- changing a role, and the guard on the last owner -------------------------------------------

test('moving somebody to assistant takes the key away rather than hiding it', async () => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    // Somebody who holds a copy of the key, the way a colleague who has been here a while does.
    const helper = await colleague(base, db, 'owner', 'helper@practice.example');
    const memberId = db.prepare('SELECT id FROM practitioner WHERE email = ?').get('helper@practice.example').id;
    const founderId = db.prepare('SELECT id FROM practitioner WHERE email <> ? LIMIT 1').get('helper@practice.example').id;

    // Give them a wrapped copy of the practice key — what a colleague who has been here a while holds, and
    // the thing the demotion below is supposed to take away. Without this the test would pass on a fiction:
    // a member with nothing to lose cannot show that something was taken from them.
    const practiceKey = db.prepare('SELECT id FROM practice_key LIMIT 1').get();
    db.prepare(
      'INSERT INTO key_wrapping (id, key_id, practitioner_id, wrapped_private_key, created_at) VALUES (?,?,?,?,?)',
    ).run('w-helper', practiceKey.id, memberId, 'pbkdf2$sha-256$copy', new Date().toISOString());
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM key_wrapping WHERE practitioner_id = ?').get(memberId).n,
      1,
      'they hold a copy to begin with',
    );

    assert.equal((await helper.get('/members')).status, 200, 'the new owner can manage members');

    const moved = await practice.client.post(`/members/${memberId}/role`, { role: 'assistant' });
    assert.equal(moved.status, 303, 'the change is accepted');
    assert.equal(
      db.prepare('SELECT role FROM practitioner WHERE id = ?').get(memberId).role,
      'assistant',
      'and stored',
    );

    // The part that makes it real: their copy of the key is gone, not merely unmentioned.
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM key_wrapping WHERE practitioner_id = ?').get(memberId).n,
      0,
      'their wrapped copy was destroyed',
    );
    assert.equal((await helper.get('/keys')).status, 403, 'and they can no longer reach the keys');

    // The other member's copy is untouched — this takes one person's key, not the practice's.
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM key_wrapping WHERE practitioner_id = ?').get(founderId).n,
      1,
      'nobody else lost anything',
    );
  });
});

test('the last owner cannot be moved or removed, and a practice cannot be left without one', async () => {
  await withServer(async ({ base, agent, db }) => {
    const practice = await practiceWithRequest({ agent, db });
    const me = db.prepare('SELECT id FROM practitioner LIMIT 1').get().id;

    const refused = await practice.client.post(`/members/${me}/role`, { role: 'assistant' });
    assert.equal(refused.status, 400, 'the only owner cannot demote themselves');
    assert.match(await refused.text(), /only owner/, 'and is told what to do instead');
    assert.equal(
      db.prepare('SELECT role FROM practitioner WHERE id = ?').get(me).role,
      null,
      'nothing was changed',
    );

    // A second owner makes it possible, which is the point of the guard rather than a wall.
    const second = await colleague(base, db, 'owner', 'second@practice.example');
    const secondId = db.prepare('SELECT id FROM practitioner WHERE email = ?').get('second@practice.example').id;
    assert.equal((await practice.client.post(`/members/${secondId}/role`, { role: 'accountant' })).status, 303);
    assert.equal((await second.get('/members')).status, 403, 'and the demoted one loses the members page');

    // A role that is not one of the three is refused rather than stored, and so is a member who is not here.
    assert.equal((await practice.client.post(`/members/${secondId}/role`, { role: 'superuser' })).status, 400);
    assert.equal((await practice.client.post('/members/nobody/role', { role: 'owner' })).status, 404);
  });
});

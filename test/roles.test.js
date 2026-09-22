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
// --- inviting somebody straight in as an assistant ----------------------------------------------

test('an assistant is invited without a key, and arrives with nothing that opens a file', async () => {
  await withServer(async ({ base, agent, db }) => {
    const firm = await practiceWithRequest({ agent, db });
    const link = await createLink(firm.client, firm.requestId);
    const sent = await upload({
      base,
      token: link.token,
      itemId: firm.itemIds[0],
      publicKey: firm.keys.publicKey,
      plaintext: Buffer.from('a bank statement'),
      filename: 'statement.pdf',
    });
    assert.ok(sent.response.ok, 'a document is waiting for them');

    // What the inviter's browser does when the picker says "assistant": no key is unwrapped and nothing is
    // sealed, so the request carries a role and no blob at all.
    const made = await firm.client.request('/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ role: 'assistant' }).toString(),
    });
    assert.equal(made.status, 201);
    const body = await made.json();
    assert.equal(body.keyed, false, 'the server says plainly that no key was handed over');

    const row = db.prepare('SELECT key_id, sealed_key, role FROM invite').get();
    assert.equal(row.key_id, null, 'no key');
    assert.equal(row.sealed_key, null, 'and nothing sealed');
    assert.equal(row.role, 'assistant', 'and the role the inviter chose was actually recorded');

    // The invitation must resolve. This is the bug the LEFT JOIN fixed: an inner join on `practice_key`
    // reported a keyless invitation as an *unknown address*, which would have told somebody holding a
    // perfectly good link that there was nothing at theirs.
    const page = await agent().get(`/invite/${body.token}`);
    assert.equal(page.status, 200, 'the invitation page opens');
    const html = await page.text();
    assert.match(html, /You will not be able to open the documents themselves/, 'and says what they are not getting');
    assert.match(html, /Nothing on this page needs JavaScript/, 'and needs none, because there is no key to open');
    assert.ok(!/id="passphrase"/.test(html), 'and asks for no passphrase, because there is no key to protect');

    // They accept it, and arrive with a login and no key.
    const accepted = await agent().post(`/invite/${body.token}`, {
      email: 'chaser@practice.example',
      password: PASSWORD,
    });
    assert.equal(accepted.status, 303, 'they join');
    const chaser = db.prepare('SELECT id, role FROM practitioner WHERE email = ?').get('chaser@practice.example');
    assert.equal(chaser.role, 'assistant', 'as an assistant');
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM key_wrapping WHERE practitioner_id = ?').get(chaser.id).n,
      0,
      'holding nothing that opens anything — which is the whole point, and is a fact rather than a rule',
    );

    // And the fact is enforced where it matters: the document itself.
    const asAssistant = agent(base);
    await asAssistant.post('/signin', { email: 'chaser@practice.example', password: PASSWORD });
    const fileId = db.prepare('SELECT id FROM upload WHERE filename = ?').get('statement.pdf').id;
    const refused = await asAssistant.get(`/requests/${firm.requestId}/files/${fileId}`);
    assert.equal(refused.status, 403, 'the file is refused');
    assert.match(await refused.text(), /do not hold a copy/, 'and the reason given is the true one');

    // While the work they were invited to do is theirs.
    assert.equal((await asAssistant.get('/requests')).status, 200, 'they can see the board');
    assert.equal((await asAssistant.get('/clients')).status, 200, 'and the clients');

test('an assistant invitation cannot smuggle a key, and a keyed one still carries one', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await practiceWithRequest({ agent, db });

    // The role and the blob disagree, which is the one thing the schema's CHECK also refuses. The server
    // says so at the door rather than silently discarding a key the browser went to the trouble of sealing.
    const smuggled = await firm.client.request('/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ role: 'assistant', sealed_key: 'invite$sha-256$nonsense' }).toString(),
    });
    assert.equal(smuggled.status, 400);
    assert.match((await smuggled.json()).error, /does not carry a key/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM invite').get().n, 0, 'and nothing was recorded');

    // The keyed path is unchanged, including the role it now writes — which it computed and dropped before.
    const keyed = await firm.client.request('/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        role: 'accountant',
        key_id: db.prepare('SELECT id FROM practice_key').get().id,
        sealed_key: 'invite$sha-256$whatever',
      }).toString(),
    });
    assert.equal(keyed.status, 201, 'a keyed invitation still needs a key the inviter holds');
    assert.equal((await keyed.json()).keyed, true);
    const row = db.prepare('SELECT role, sealed_key FROM invite').get();
    assert.equal(row.role, 'accountant', 'and records the chosen role rather than dropping it on the floor');
    assert.equal(row.sealed_key, 'invite$sha-256$whatever', 'and the blob');
  });
});

test('a member who joins with a key is told the opposite thing, on a page that has the fields', async () => {
  await withServer(async ({ agent, db }) => {
    const firm = await practiceWithRequest({ agent, db });
    const keyId = db.prepare('SELECT id FROM practice_key').get().id;
    const made = await firm.client.request('/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ role: 'accountant', key_id: keyId, sealed_key: 'invite$sha-256$whatever' }).toString(),
    });
    const { token } = await made.json();

    const html = await (await agent().get(`/invite/${token}`)).text();
    assert.match(html, /you will be able to open the documents clients have already sent/, 'the keyed promise');
    assert.match(html, /id="passphrase"/, 'and the field that makes it true');
    assert.ok(!/You will not be able to open the documents/.test(html), 'and not the assistant sentence');

    // The members page offers the choice, because a capability nobody can reach is not a capability.
    const members = await (await firm.client.get('/members')).text();
    assert.match(members, /id="invite-role"/, 'the picker is on the form');
    assert.match(members, /value="assistant"/, 'including the role that carries no key');
  });
});

  });
});

    assert.equal((await practice.client.post('/members/nobody/role', { role: 'owner' })).status, 404);
  });
});

/**
 * A role that this code does not recognise must never be read as the owner.
 *
 * `src/roles.js` used to answer an unrecognised value with owner privileges, reasoning that failing closed
 * would silently strip a member of access. That was wrong in the one direction that matters: an
 * unrecognised value can only arrive by editing the database, a bad import or a damaged restore, and the
 * answer to "I do not know what this person is" cannot be "then they are the owner". It also disagreed with
 * the SQL: `ownersOf` counts only `role = 'owner' OR role IS NULL`, so the database already thought the row
 * was not an owner while the application thought it was.
 *
 * The legacy reading is *kept*, because it is a documented contract rather than corruption: a null role
 * means "created before roles existed", and that still reads as owner. Both halves are tested here, because
 * keeping one and losing the other would be the way this change goes wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPractitioner, createInvite, setRole, uploadsOf } from '../src/store.js';
import { hashPassword } from '../src/crypto.js';
import {
  ROLES, assertKnownRole, holdsKey, isKnownRole, isUnrecognisedRole, roleMeets, roleName,
} from '../src/roles.js';
import { PASSWORD, agent, withServer, practiceWithRequest } from './helpers.js';

/** Put a value into the column the way somebody with a SQL prompt would. */
function corruptRole(db, email, value) {
  const row = db.prepare('SELECT id FROM practitioner WHERE email = ?').get(email);
  assert.ok(row, `expected a member at ${email}`);
  db.prepare('UPDATE practitioner SET role = ? WHERE id = ?').run(value, row.id);
  return row.id;
}

// --- the model, on its own ----------------------------------------------------------------------

test('an unrecognised role is denied, not promoted', () => {
  for (const value of ['superuser', 'Owner', 'OWNER', 'admin', 'owner ', '', 'null', 0, 1, true, {}, []]) {
    assert.equal(roleMeets(value, 'owner'), false, `${JSON.stringify(value)} must not meet owner`);
    assert.equal(roleMeets(value, 'accountant'), false, `${JSON.stringify(value)} must not meet accountant`);
    assert.equal(holdsKey(value), false, `${JSON.stringify(value)} must not hold the key`);
    assert.equal(roleName(value), 'unknown', `${JSON.stringify(value)} is shown as unrecognised`);
    assert.equal(isKnownRole(value), false);
    assert.equal(isUnrecognisedRole(value), true);
  }

  // A missing practitioner is `undefined`, and that is a signed-out request rather than a corrupt row —
  // denied too, which is what sends the visitor to sign in.
  assert.equal(roleMeets(undefined, 'owner'), false, 'signed out is not owner');
});

test('the documented legacy value still reads as owner', () => {
  // null means "this row predates roles", and every member had owner powers at the time. That contract is
  // kept deliberately: changing it would silently take access away from real people on a real upgrade.
  assert.equal(roleMeets(null, 'owner'), true);
  assert.equal(holdsKey(null), true);
  assert.equal(roleName(null), 'owner');
  assert.equal(isKnownRole(null), true, 'null is understood, so it is not "unrecognised"');
  assert.equal(isUnrecognisedRole(null), false);
});

test('the three real roles are unchanged', () => {
  assert.deepEqual(ROLES, ['assistant', 'accountant', 'owner']);
  assert.equal(roleMeets('owner', 'owner'), true);
  assert.equal(roleMeets('accountant', 'accountant'), true);
  assert.equal(roleMeets('accountant', 'owner'), false);
  assert.equal(roleMeets('assistant', 'assistant'), true);
  assert.equal(roleMeets('assistant', 'accountant'), false);
  assert.equal(holdsKey('accountant'), true);
  assert.equal(holdsKey('assistant'), false);
  for (const role of ROLES) assert.equal(roleName(role), role);
});

test('an unrecognised role cannot be written through the store', async () => {
  assert.throws(() => assertKnownRole('root'), TypeError);
  assert.equal(assertKnownRole(null), null, 'legacy null is still writable');
  assert.equal(assertKnownRole('assistant'), 'assistant');

  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const practiceId = db.prepare('SELECT id FROM practice').get().id;
    const passwordHash = await hashPassword(PASSWORD);

    assert.throws(
      () => createPractitioner(db, { practiceId, email: 'x@example.test', passwordHash, role: 'root' }),
      TypeError,
      'a member cannot be created with an invented role',
    );
    assert.throws(
      () => createInvite(db, {
        practiceId, createdBy: null, tokenHash: 'a'.repeat(64), expiresAt: new Date().toISOString(), role: 'root',
      }),
      TypeError,
      'an invitation cannot carry an invented role',
    );

    // Null is accepted on both, because that is the documented legacy contract rather than corruption.
    const id = createPractitioner(db, { practiceId, email: 'legacy@example.test', passwordHash, role: null });
    assert.equal(db.prepare('SELECT role FROM practitioner WHERE id = ?').get(id).role, null);
    assert.throws(() => setRole(db, practiceId, id, 'root'), TypeError, 'a role change cannot store an invented role');
    assert.equal(practice.requestId.length > 0, true);
  });
});

// --- what the denial means over HTTP --------------------------------------------------------------

test('a member whose stored role is unrecognised is denied everything gated', async () => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const [stored] = uploadsOf(db, practice.requestId);

    // A real member first, so the only thing that differs from a working assistant is the column value.
    const memberId = createPractitioner(db, {
      practiceId: db.prepare('SELECT id FROM practice').get().id,
      email: 'corrupt@practice.example',
      passwordHash: await hashPassword(PASSWORD),
      role: 'assistant',
    });
    // Then corrupt it the way a bad restore or a hand edit would — the store refuses to do this itself,
    // which is the point of the guard above.
    db.prepare('UPDATE practitioner SET role = ? WHERE id = ?').run('superuser', memberId);

    const signedIn = agent(base);
    assert.equal((await signedIn.post('/signin', { email: 'corrupt@practice.example', password: PASSWORD })).status, 303);

    // The three surfaces a corrupt value used to reach as the owner, and must now not.
    assert.equal((await signedIn.get('/keys')).status, 403, 'the practice key is not theirs');
    assert.equal((await signedIn.get('/members')).status, 403, 'nor is the member list');
    if (stored) {
      assert.equal(
        (await signedIn.get(`/requests/${practice.requestId}/files/${stored.id}`)).status,
        403,
        'nor is a client document — and a 403 rather than a 404, because the route is gated by role',
      );
    }

    // Signed in is still signed in: they see the board, which is what an assistant sees too.
    assert.equal((await signedIn.get('/requests')).status, 200);
  });
});

test('a member whose role is null keeps the access every member had before roles', async () => {
  await withServer(async ({ base, db, agent }) => {
    await practiceWithRequest({ agent, db });
    const practiceId = db.prepare('SELECT id FROM practice').get().id;
    // A row inserted the way the pre-roles schema left it: the column unset.
    const id = createPractitioner(db, {
      practiceId, email: 'legacy@practice.example', passwordHash: await hashPassword(PASSWORD), role: null,
    });
    db.prepare('UPDATE practitioner SET role = NULL WHERE id = ?').run(id);

    const signedIn = agent(base);
    assert.equal((await signedIn.post('/signin', { email: 'legacy@practice.example', password: PASSWORD })).status, 303);
    assert.equal((await signedIn.get('/keys')).status, 200, 'the legacy row is still an owner');
    assert.equal((await signedIn.get('/members')).status, 200);
  });
});

test('the members page names an unrecognised role instead of mislabelling it', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    createPractitioner(db, {
      practiceId: db.prepare('SELECT id FROM practice').get().id,
      email: 'broken@practice.example',
      passwordHash: await hashPassword(PASSWORD),
      role: 'accountant',
    });
    corruptRole(db, 'broken@practice.example', 'accountnt');

    const rendered = await (await practice.client.get('/members')).text();
    assert.match(rendered, /a role this version does not recognise/, 'the page says what is wrong');
    assert.match(rendered, /broken@practice\.example/, 'and names the row that needs fixing');
    assert.match(rendered, /permission at all/, 'and what it is being treated as');
    assert.match(rendered, /Unrecognised/, 'the picker shows the value honestly');
  });
});

test('a clean practice shows no such warning', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const rendered = await (await practice.client.get('/members')).text();
    assert.doesNotMatch(rendered, /does not recognise/);
  });
});

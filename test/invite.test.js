/**
 * Invitations: the thing that makes a second member possible.
 *
 * The store-level tests here, and the whole flow through HTTP in `invite-flow.test.js`. The claim that
 * matters is in the second test: **a member who accepts an invitation can open a document that arrived
 * before they existed.** Everything else is states and refusals.
 *
 * The tokens are built with the real `newToken`/`hashToken`, so what is stored is a digest and what is
 * handed out is a token — the same shape a client link has, and the reason a stolen database is not a
 * set of working invitations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db.js';
import { hashToken, newToken } from '../src/crypto.js';
import {
  addPracticeKey,
  claimInvite,
  createInvite,
  createPractice,
  createPractitioner,
  inviteByToken,
  invitesOf,
  membersOf,
  practiceKeys,
} from '../src/store.js';
import {
  decryptEnvelope,
  encryptFile,
  generatePracticeKey,
  openInviteBytes,
  privateKeyBytesForTransfer,
  sealPrivateKey,
  unwrapPracticeKey,
  wrapBytesForInvite,
} from '../web/tickmark-crypto.js';

const ADA = 'ada passphrase long enough';
const SAM = 'sam passphrase long enough';
const ENVELOPE_TEXT = 'Northwind bank statement, Q1';

/** A practice with one member and a key, and a document already sealed to that key. */
async function firmWithHistory(db) {
  const practiceId = createPractice(db, { name: 'Two partners' });
  const ada = createPractitioner(db, { practiceId, email: 'ada@firm.example', passwordHash: 'x' });
  const key = await generatePracticeKey(ADA);
  const keyId = addPracticeKey(db, practiceId, {
    publicKey: key.publicKey,
    wrappedPrivateKey: key.wrappedPrivateKey,
    createdBy: ada,
  });
  const envelope = await encryptFile(key.publicKey, new TextEncoder().encode(ENVELOPE_TEXT));
  return { practiceId, ada, keyId, key, envelope };
}

/** Issue an invitation the way the browser will: seal the key under a secret only the link carries. */
async function invite(db, { practiceId, createdBy, keyId, wrappedPrivateKey, token = newToken(), days = 7, at = new Date() }) {
  const secret = newToken();
  const sealedKey = await wrapBytesForInvite(
    await privateKeyBytesForTransfer(wrappedPrivateKey, ADA),
    secret,
  );
  createInvite(db, {
    practiceId,
    createdBy,
    keyId,
    sealedKey,
    tokenHash: hashToken(token),
    expiresAt: new Date(at.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    at: at.toISOString(),
  });
  return { token, secret, sealedKey };
}

test('an invitation is open, and shows the practice and the sealed key to whoever holds the link', async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const firm = await firmWithHistory(db);
  const { token, sealedKey } = await invite(db, {
    practiceId: firm.practiceId,
    createdBy: firm.ada,
    keyId: firm.keyId,
    wrappedPrivateKey: firm.key.wrappedPrivateKey,
  });

  const found = inviteByToken(db, token);
  assert.equal(found.state, 'open');
  assert.equal(found.invite.practice_name, 'Two partners', 'so the page can say whose practice this is');
  assert.equal(found.invite.sealed_key, sealedKey, 'and the browser gets the blob to open with the fragment');
  assert.equal(found.invite.key_id, firm.keyId, 'attached to the key it carries a copy of');

  // What is stored is a digest. The token itself is not in the database.
  const stored = db.prepare('SELECT token_hash FROM invite').get().token_hash;
  assert.equal(stored, hashToken(token));
  assert.notEqual(stored, token, 'the token is not stored');
  assert.equal(inviteByToken(db, 'not-a-real-token').state, 'unknown', 'and a wrong token is unknown');
  assert.equal(inviteByToken(db, '').state, 'unknown');
});

test('the member who accepts can open a document that arrived before they did', async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const firm = await firmWithHistory(db);
  const { token, secret } = await invite(db, {
    practiceId: firm.practiceId,
    createdBy: firm.ada,
    keyId: firm.keyId,
    wrappedPrivateKey: firm.key.wrappedPrivateKey,
  });

  // The new member's browser: open the blob with the secret from the fragment, re-seal the same key
  // under their own passphrase, and send only that.
  const openedBlob = await openInviteBytes(inviteByToken(db, token).invite.sealed_key, secret);
  const theirRecord = await sealPrivateKey(openedBlob, SAM);

  const claimed = claimInvite(db, {
    token,
    email: 'sam@firm.example',
    passwordHash: 'scrypt$placeholder',
    wrappedPrivateKey: theirRecord,
  });
  assert.equal(claimed.state, 'joined');
  assert.equal(claimed.practiceId, firm.practiceId, 'in the inviting practice, not a new one');

  // The firm now has two members.
  assert.deepEqual(
    membersOf(db, firm.practiceId).map((person) => person.email).sort(),
    ['ada@firm.example', 'sam@firm.example'],
  );

  // And the file that predates Sam opens with Sam's own passphrase.
  const samKey = await unwrapPracticeKey(
    practiceKeys(db, firm.practiceId, claimed.practitionerId)[0].wrappedPrivateKey,
    SAM,
  );
  assert.equal(
    new TextDecoder().decode(await decryptEnvelope(samKey, firm.envelope)),
    ENVELOPE_TEXT,
    'the document from before they joined',
  );

  // Sam's own copy is his, not a colleague's, and Ada's is untouched.
  const samCopy = practiceKeys(db, firm.practiceId, claimed.practitionerId)[0].wrappedPrivateKey;
  assert.equal(samCopy, theirRecord);
  assert.equal(practiceKeys(db, firm.practiceId, firm.ada)[0].wrappedPrivateKey, firm.key.wrappedPrivateKey);
  assert.notEqual(samCopy, firm.key.wrappedPrivateKey, 'two members, two different sealed copies');
});
test('an invitation works once, and the second attempt says so rather than looking wrong', async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const firm = await firmWithHistory(db);
  const { token, secret } = await invite(db, {
    practiceId: firm.practiceId,
    createdBy: firm.ada,
    keyId: firm.keyId,
    wrappedPrivateKey: firm.key.wrappedPrivateKey,
  });
  const record = await sealPrivateKey(await openInviteBytes(inviteByToken(db, token).invite.sealed_key, secret), SAM);

  assert.equal(
    claimInvite(db, { token, email: 'first@firm.example', passwordHash: 'x', wrappedPrivateKey: record }).state,
    'joined',
  );
  assert.equal(inviteByToken(db, token).state, 'used', 'a used link is a state, not a deletion');

  const second = claimInvite(db, { token, email: 'second@firm.example', passwordHash: 'x', wrappedPrivateKey: record });
  assert.equal(second.state, 'used', 'and the second attempt is told what happened');

  const emails = membersOf(db, firm.practiceId).map((person) => person.email);
  assert.equal(emails.length, 2, 'nobody was created by the second attempt — two people, not three');
  assert.ok(!emails.includes('second@firm.example'), 'including the one who tried');
});

test('an expired invitation is refused, and creates nobody', async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const firm = await firmWithHistory(db);
  const { token } = await invite(db, {
    practiceId: firm.practiceId,
    createdBy: firm.ada,
    keyId: firm.keyId,
    wrappedPrivateKey: firm.key.wrappedPrivateKey,
    days: 7,
    at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  });

  assert.equal(inviteByToken(db, token).state, 'expired', 'the link expired a day ago');
  const refused = claimInvite(db, {
    token,
    email: 'late@firm.example',
    passwordHash: 'x',
    wrappedPrivateKey: 'pbkdf2$sha-256$600000$AA$AA$AA',
  });
  assert.equal(refused.state, 'expired');
  assert.equal(membersOf(db, firm.practiceId).length, 1, 'still one member');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM key_wrapping').get().n, 1, 'and one sealed copy');
});

test('an invitation belongs to one practice and cannot put a member in another', async (t) => {
  const db = openDatabase();
  t.after(() => db.close());

  const firm = await firmWithHistory(db);
  const other = createPractice(db, { name: 'Somebody else' });
  const stranger = createPractitioner(db, { practiceId: other, email: 'theirs@firm.example', passwordHash: 'x' });

  const { token, secret } = await invite(db, {
    practiceId: firm.practiceId,
    createdBy: firm.ada,
    keyId: firm.keyId,
    wrappedPrivateKey: firm.key.wrappedPrivateKey,
  });
  const record = await sealPrivateKey(await openInviteBytes(inviteByToken(db, token).invite.sealed_key, secret), SAM);
  claimInvite(db, { token, email: 'sam@firm.example', passwordHash: 'x', wrappedPrivateKey: record });

  assert.equal(membersOf(db, other).length, 1, 'the other practice still has just its own member');
  assert.equal(membersOf(db, other)[0].id, stranger);
  assert.equal(membersOf(db, firm.practiceId).length, 2);

  // The new member's sealed copy belongs to the inviting practice's key, so the other practice sees
  // nothing of it.
  const samId = membersOf(db, firm.practiceId).find((person) => person.email === 'sam@firm.example').id;
  assert.equal(practiceKeys(db, other, samId).length, 0, 'nothing of the other practice is visible');
  assert.equal(practiceKeys(db, firm.practiceId, samId).length, 1);
});

test('the members page can list invitations, and who accepted them', async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const firm = await firmWithHistory(db);

  const first = await invite(db, {
    practiceId: firm.practiceId,
    createdBy: firm.ada,
    keyId: firm.keyId,
    wrappedPrivateKey: firm.key.wrappedPrivateKey,
  });
  const record = await sealPrivateKey(
    await openInviteBytes(inviteByToken(db, first.token).invite.sealed_key, first.secret),
    SAM,
  );
  claimInvite(db, { token: first.token, email: 'sam@firm.example', passwordHash: 'x', wrappedPrivateKey: record });

  // A second one nobody has taken yet.
  await invite(db, {
    practiceId: firm.practiceId,
    createdBy: firm.ada,
    keyId: firm.keyId,
    wrappedPrivateKey: firm.key.wrappedPrivateKey,
  });

  const invites = invitesOf(db, firm.practiceId);
  assert.equal(invites.length, 2, 'both invitations are on the record');
  assert.equal(invites.filter((row) => row.used_at === null).length, 1, 'one still outstanding');
  const accepted = invites.find((row) => row.used_at !== null);
  assert.equal(accepted.created_by_email, 'ada@firm.example', 'who sent it');
  assert.equal(accepted.used_by_email, 'sam@firm.example', 'and who accepted it');
  assert.equal(invitesOf(db, 'no-such-practice').length, 0);
});
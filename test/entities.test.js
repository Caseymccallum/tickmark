/**
 * One client, several matters — the research's clearest gap.
 *
 * A practice thinks "Jane has a limited company and a partnership", not "Jane is one bucket of
 * everything". So a client is the *contact* (one name, one email) and an entity is a matter under them
 * — a limited company, a personal return, a partnership — each with its own documents. Requests hang
 * off an entity so the work is grouped the way the practice already sees it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import {
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  entitiesFor,
  findOrCreateEntity,
  requestsForClient,
} from '../src/store.js';

function practice() {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-entity-'));
  const db = openDatabase(join(directory, 'tickmark.db'));
  const practiceId = createPractice(db, { name: 'Lodis Accountancy' });
  const createdBy = createPractitioner(db, {
    practiceId,
    email: 'sam@example.test',
    passwordHash: 'scrypt$placeholder',
  });
  const clientId = createClient(db, { practiceId, createdBy, name: 'Jane Smith', email: 'jane@example.test' });
  return { directory, db, practiceId, createdBy, clientId };
}

test('a client gathers several entities, and a name finds the same one twice', async (t) => {
  const { directory, db, practiceId, clientId } = practice();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const ltd = findOrCreateEntity(db, { practiceId, clientId, name: "Jane's Consulting Ltd" });
  const partnership = findOrCreateEntity(db, { practiceId, clientId, name: 'Smith Partnership' });
  assert.notEqual(ltd, partnership);

  // The name is the identity: typing it again finds the same entity rather than making a second.
  assert.equal(findOrCreateEntity(db, { practiceId, clientId, name: "Jane's Consulting Ltd" }), ltd);
  assert.equal(findOrCreateEntity(db, { practiceId, clientId, name: "JANE'S CONSULTING LTD" }), ltd);

  const all = entitiesFor(db, practiceId, clientId);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((row) => row.name), ["Jane's Consulting Ltd", 'Smith Partnership']);
  db.close();
});

test('requests hang off an entity, and the client page groups them that way', async (t) => {
  const { directory, db, practiceId, createdBy, clientId } = practice();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const ltd = findOrCreateEntity(db, { practiceId, clientId, name: 'Ltd' });
  const personal = findOrCreateEntity(db, { practiceId, clientId, name: 'Personal return' });

  createRequest(db, { practiceId, createdBy, clientId, entityId: ltd, title: 'Ltd accounts 2025' });
  createRequest(db, { practiceId, createdBy, clientId, entityId: personal, title: 'SA100 2025' });
  createRequest(db, { practiceId, createdBy, clientId, title: 'Engagement letter' }); // no entity

  const rows = requestsForClient(db, practiceId, clientId);
  assert.equal(rows.length, 3);
  const byTitle = Object.fromEntries(rows.map((row) => [row.title, row]));
  assert.equal(byTitle['Ltd accounts 2025'].entity, 'Ltd');
  assert.equal(byTitle['SA100 2025'].entity, 'Personal return');
  assert.equal(byTitle['Engagement letter'].entity, null, 'a request with no entity is ungrouped, not wrong');
  db.close();
});

test('an entity belongs to one client, never another', async (t) => {
  const { directory, db, practiceId, createdBy, clientId } = practice();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const other = createClient(db, { practiceId, createdBy, name: 'Other Co', email: 'o@example.test' });

  findOrCreateEntity(db, { practiceId, clientId, name: 'Ltd' });
  // The other client has no "Ltd" — entities are per-client, so the name means nothing here.
  assert.equal(entitiesFor(db, practiceId, other).length, 0);
  db.close();
});
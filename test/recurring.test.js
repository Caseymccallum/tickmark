/**
 * "The same as last year" — the repeat the research said was the biggest cost of all.
 *
 * Every January a practice rebuilt the same checklist from scratch. This is the missing *operation*,
 * not a missing feature: "do this again" brings the same client, the same matter, the same list
 * (notes and all) forward to a new request, with the title's year rolled on and the deadline left for
 * a new one to be set. One action, not a retyping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemsOf, requestFor } from '../src/store.js';
import { practiceWithRequest, withServer } from './helpers.js';

test('raising the same request again brings the list forward and rolls the year', async () => {
  await withServer(async ({ agent, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const practiceId = db.prepare('SELECT id FROM practice').get().id;
    const source = requestFor(db, practiceId, requestId);
    assert.equal(source.title, '2025 return');
    const before = itemsOf(db, requestId).length;

    const again = await client.post(`/requests/${requestId}/again`, {});
    assert.equal(again.status, 303, 'it lands on the new request');
    const newId = again.headers.get('location').split('/').pop().split('?')[0];

    const copy = requestFor(db, practiceId, newId);
    assert.equal(copy.client_id, source.client_id, 'the same client');
    assert.equal(copy.entity_id, source.entity_id, 'the same matter');

    // The year rolls to at least next year or the current one, whichever is later.
    const year = Math.max(2026, new Date().getFullYear());
    assert.equal(copy.title, `${year} return`, "the title's year rolls on");

    assert.equal(copy.due_at, null, 'a new year has a new deadline to set, so the date is not carried');
    assert.equal(itemsOf(db, newId).length, before, 'and the whole checklist came with it');

    // The original is untouched — a re-raise copies, it never moves or edits.
    assert.equal(requestFor(db, practiceId, requestId).title, '2025 return');
    assert.equal(itemsOf(db, requestId).length, before);
  });
});
/**
 * The one rule about "outstanding", checked against itself from every direction.
 *
 * This file exists because the product had **two** definitions of that word in one release and they disagreed: the
 * board's count said `0` beside a request the chase was listing as owing a document, because the count omitted the
 * flagged item that the list included. Both were computed from the same items table and both looked right in
 * isolation, which is exactly why nothing failed.
 *
 * So the assertions here are not "is this number correct" — they are **"do these ways of asking agree"**, over a
 * fixture deliberately full of the cases that pull them apart: withdrawn documents, flagged ones, ones a client has
 * answered, several files against one document, documents nobody has ever sent, an extra file that answers nothing,
 * and a closed request in the middle of it all.
 *
 * The list pages now compute their counts in one query instead of one per row, so the risk these guard against is no
 * longer two code paths — it is that the *fast* path drifts from what the slow one returned. A test that checked the
 * fast path against a hard-coded number would not notice that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db.js';
import {
  clientSummaries,
  closeRequest,
  createClient,
  createPractice,
  createPractitioner,
  createRequest,
  itemsOf,
  outstandingOf,
  progressForPractice,
  recordUpload,
  requestProgress,
  requestsFor,
  requestsForClient,
  setClientSays,
  setItemAttention,
  setItemReviewed,
  setItemWithdrawn,
} from '../src/store.js';

/**
 * A practice built to be awkward, and a second one to prove none of it leaks.
 *
 * Every request below is a different shape on purpose, and the assertions walk all of them rather than naming the
 * cases, so a shape nobody thought of is still checked.
 */
function messy(t) {
  const db = openDatabase();
  t.after(() => db.close());

  const practiceId = createPractice(db, { name: 'Lodis' });
  const person = createPractitioner(db, { practiceId, email: 'a@lodis.test', passwordHash: 'x' });

  const clientFor = (name) =>
    createClient(db, { practiceId, createdBy: person, name, email: `${name.toLowerCase()}@x.test` });

  const addRequest = (name, title, items, { closed = false } = {}) => {
    const requestId = createRequest(db, {
      practiceId,
      createdBy: person,
      clientId: clientFor(name),
      title,
      items,
    });
    if (closed) closeRequest(db, practiceId, requestId);
    return requestId;
  };

  const send = (requestId, itemId, filename = 'file.pdf') =>
    recordUpload(db, {
      requestId,
      requestItemId: itemId,
      filename,
      sizeBytes: 10,
      sha256: `digest-${requestId}-${itemId}-${filename}`,
      storagePath: `/tmp/${filename}`,
    });

  const check = (requestId, itemId) => setItemReviewed(db, practiceId, requestId, itemId, true);

  // 1. Nothing sent yet.
  const untouched = addRequest('Alpha', 'nothing sent', ['Statements', 'ID']);

  // 2. Everything sent, nothing looked at.
  const toCheck = addRequest('Bravo', 'all in, unchecked', ['Statements']);
  send(toCheck, itemsOf(db, toCheck)[0].id);

  // 3. Everything sent and looked at, so genuinely ready to work on.
  const ready = addRequest('Charlie', 'finished', ['Statements']);
  const readyItem = itemsOf(db, ready)[0].id;
  send(ready, readyItem);
  check(ready, readyItem);

  // 4. Everything sent and looked at, but one flagged as unusable — the case the two definitions disagreed about.
  //    This is the one that must count as outstanding.
  const flagged = addRequest('Delta', 'flagged', ['Statements', 'ID']);
  const flaggedItems = itemsOf(db, flagged);
  for (const item of flaggedItems) send(flagged, item.id);
  for (const item of flaggedItems) check(flagged, item.id);
  setItemAttention(db, practiceId, flagged, flaggedItems[0].id, { note: 'unreadable' });

  return { db, practiceId, person, addRequest, send, check, untouched, toCheck, ready, flagged, flaggedItems };
}

/** The rest of the awkward shapes, built on the same practice so one assertion can walk all of them. */
function alsoMessy(fixture) {
  const { db, practiceId, addRequest, send, check } = fixture;

  // 5. A client who explained themselves on one document and sent the other.
  const answered = addRequest('Echo', 'part answered', ['Statements', 'Signed letter']);
  const answeredItems = itemsOf(db, answered);
  send(answered, answeredItems[0].id);
  setClientSays(db, practiceId, answered, answeredItems[1].id, 'still with the previous accountant');

  // 6. Withdrawn documents, two files against one document, and an extra nobody asked for.
  const tangled = addRequest('Foxtrot', 'tangled', ['Statements', 'ID', 'Letter']);
  const tangledItems = itemsOf(db, tangled);
  send(tangled, tangledItems[0].id, 'a.pdf');
  send(tangled, tangledItems[0].id, 'b.pdf');
  setItemWithdrawn(db, practiceId, tangled, tangledItems[1].id, true);
  recordUpload(db, {
    requestId: tangled,
    requestItemId: null, // an extra: belongs to the request, answers no document
    filename: 'vat-return.pdf',
    sizeBytes: 10,
    sha256: 'extra-1',
    storagePath: '/tmp/extra-1.pdf',
  });

  // 7. Closed with something still owed — a season closed over an unfinished request.
  const closed = addRequest('Golf', 'closed early', ['Statements', 'ID'], { closed: true });
  send(closed, itemsOf(db, closed)[0].id);

  // 8. A client who sent a document *and* said something about it — both facts on one row.
  const both = addRequest('Hotel', 'sent and explained', ['Statements']);
  const bothItem = itemsOf(db, both)[0].id;
  send(both, bothItem);
  setClientSays(db, practiceId, both, bothItem, 'the bank posted it, arriving Tuesday');

  check(both, bothItem);

  const ids = [
    fixture.untouched,
    fixture.toCheck,
    fixture.ready,
    fixture.flagged,
    answered,
    tangled,
    closed,
    both,
  ];

  // A whole second practice, so a query that forgot its scope shows up as a wrong number rather than passing.
  const otherPractice = createPractice(db, { name: 'Somebody Else' });
  const otherPerson = createPractitioner(db, {
    practiceId: otherPractice,
    email: 'b@other.test',
    passwordHash: 'x',
  });
  const otherClient = createClient(db, {
    practiceId: otherPractice,
    createdBy: otherPerson,
    name: 'Intruder',
    email: 'i@other.test',
  });
  const otherRequest = createRequest(db, {
    practiceId: otherPractice,
    createdBy: otherPerson,
    clientId: otherClient,
    title: 'not mine',
    items: ['Statements', 'ID', 'Letter'],
  });

  return { ...fixture, ids, answered, tangled, closed, both, otherPractice, otherRequest };
}

test('the count on a list agrees with the count for one request, for every shape of request', (t) => {
  const all = alsoMessy(messy(t));
  const batch = progressForPractice(all.db, all.practiceId);

  assert.equal(batch.size, all.ids.length, 'one entry per request, and nothing from anywhere else');
  for (const id of all.ids) {
    const many = batch.get(id);
    assert.ok(many, `${id} is missing from the batch`);
    assert.deepEqual(many, requestProgress(all.db, id), `the batch and the single count disagree about ${id}`);
  }
  assert.equal(batch.has(all.otherRequest), false, 'and the other practice is not in it');
});

test('the number shown is the number of documents the chase is asking for', (t) => {
  const all = alsoMessy(messy(t));

  for (const id of all.ids) {
    const progress = requestProgress(all.db, id);
    const list = outstandingOf(all.db, id);
    assert.equal(
      progress.outstanding,
      list.length,
      `${id}: the board would show ${progress.outstanding}, the chase would list ${list.length}`,
    );

    // The list is genuinely outstanding: nothing withdrawn, and either no file or a flagged one.
    for (const item of list) {
      assert.equal(item.withdrawn, false, `${id}: a withdrawn document is being asked for`);
      assert.ok(item.files === 0 || item.needsAttention, `${id}: ${item.label} is not outstanding at all`);
    }

    // And nothing outstanding was left out — computed here the long way round, deliberately, not from the same query.
    const byHand = itemsOf(all.db, id).filter(
      (item) => !item.withdrawn && (!item.received || item.needsAttention),
    );
    assert.equal(list.length, byHand.length, `${id}: an outstanding document is missing from the chase list`);
  }
});

test('the flagged document is counted, which is the bug this fixture was built for', (t) => {
  const all = alsoMessy(messy(t));
  const progress = requestProgress(all.db, all.flagged);

  assert.equal(progress.items, 2, 'two documents were asked for');
  assert.equal(progress.received, 2, 'both arrived');
  assert.equal(progress.checked, 2, 'both were looked at');
  assert.equal(progress.needsAttention, 1, 'one of them was flagged');
  assert.equal(progress.outstanding, 1, 'so one is still wanted, and the count has to say so');
  assert.notEqual(progress.state, 'ready', 'and the request is not finished');
  assert.equal(outstandingOf(all.db, all.flagged).length, 1, 'the chase agrees');
});

test('every list page agrees with the same counts, and with the documents', (t) => {
  const all = alsoMessy(messy(t));
  const batch = progressForPractice(all.db, all.practiceId);

  for (const row of requestsFor(all.db, all.practiceId, { scope: 'all' })) {
    assert.deepEqual(row.progress, batch.get(row.id), `the board disagrees about ${row.title}`);
  }

  for (const summary of clientSummaries(all.db, all.practiceId)) {
    const open = all.db
      .prepare('SELECT id FROM request WHERE client_id = ? AND closed_at IS NULL')
      .all(summary.id);
    const wanted = open.reduce((total, row) => total + outstandingOf(all.db, row.id).length, 0);
    assert.equal(
      summary.progress.outstanding,
      wanted,
      `${summary.name}: the client list says ${summary.progress.outstanding}, the requests say ${wanted}`,
    );

    for (const row of requestsForClient(all.db, all.practiceId, summary.id)) {
      assert.deepEqual(row.progress, batch.get(row.id), `the client page disagrees about ${row.title}`);
    }
  }
});

test('a closed request keeps its counts but stops being anyone’s problem', (t) => {
  const all = alsoMessy(messy(t));

  assert.equal(requestProgress(all.db, all.closed).outstanding, 1, 'what is still owed is still recorded');
  const summary = clientSummaries(all.db, all.practiceId).find((row) => row.name === 'Golf');
  assert.equal(summary.progress.outstanding, 0, 'but a closed request is not counted against the client');
  assert.equal(summary.open_requests, 0, 'and the client has nothing open');
  assert.equal(summary.closed_requests, 1, 'the history is kept');
});

test('the counts are scoped, so a second practice is invisible', (t) => {
  const all = alsoMessy(messy(t));

  assert.equal(progressForPractice(all.db, all.otherPractice).size, 1, 'the other practice has only its own request');
  assert.deepEqual(
    progressForPractice(all.db, all.otherPractice).get(all.otherRequest),
    requestProgress(all.db, all.otherRequest),
    'and it agrees with itself',
  );
  assert.deepEqual(
    clientSummaries(all.db, all.otherPractice).map((row) => row.name),
    ['Intruder'],
    'the client list is scoped too',
  );
  assert.deepEqual(
    requestsFor(all.db, all.otherPractice).map((row) => row.title),
    ['not mine'],
    'and so is the board',
  );
});

test('a file nobody asked for changes no count', (t) => {
  const all = alsoMessy(messy(t));
  const before = requestProgress(all.db, all.tangled);

  recordUpload(all.db, {
    requestId: all.tangled,
    requestItemId: null,
    filename: 'another-extra.pdf',
    sizeBytes: 10,
    sha256: 'extra-2',
    storagePath: '/tmp/extra-2.pdf',
  });

  assert.deepEqual(requestProgress(all.db, all.tangled), before, 'an extra changed the counts');
  assert.equal(itemsOf(all.db, all.tangled).length, 3, 'the documents asked for are unchanged');
  // The extras *are* there, so this is not passing because the upload failed.
  assert.equal(
    all.db.prepare('SELECT COUNT(*) AS n FROM upload WHERE request_id = ? AND request_item_id IS NULL').get(all.tangled).n,
    2,
    'the extras were stored',
  );
});

test('a request with nothing at all on its list is ready, and says so consistently', (t) => {
  const all = alsoMessy(messy(t));
  const empty = all.addRequest('India', 'nothing asked for', []);

  const progress = requestProgress(all.db, empty);
  assert.equal(progress.items, 0);
  assert.equal(progress.outstanding, 0);
  assert.equal(progress.state, 'ready', 'a request with no documents is not waiting on anybody');
  assert.equal(outstandingOf(all.db, empty).length, 0, 'and the chase asks for nothing');
  assert.deepEqual(
    progressForPractice(all.db, all.practiceId).get(empty),
    progress,
    'the batch agrees about the empty case too',
  );
});

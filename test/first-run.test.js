/**
 * The first hour, which used to say nothing.
 *
 * A new practice lands on an empty board after making a key, and the things standing between them and a client
 * sending a document are invisible from there: make a key, ask for something, and — the one nobody would guess —
 * configure a mail server, or the chase cannot reach anybody.
 *
 * The state is derived rather than stored, which is what these tests are really about: a step is done when the
 * database says so, so the card cannot fall out of step with reality and there is no "onboarded" flag to find.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { practiceWithRequest, setUpKey, signUp, withServer } from './helpers.js';

test('a new practice is told what to do first', async (t) => {
  await withServer(async ({ agent }) => {
    // The state a first-time user actually lands in: signed up, and nothing else. Before this, the board said
    // "no requests yet" and left the other three things to be discovered by reading the right page.
    const client = agent();
    await signUp(client, 'sam@practice.example');

    const page = await (await client.get('/requests')).text();
    assert.match(page, /Getting started/, 'the board says what is missing');
    assert.match(page, /Make your encryption key/, 'the key first, because nothing works without it');
    assert.match(page, /Ask a client for documents/, 'then the request, which is also what creates the client');
    assert.match(page, /Set up email/, 'and email, which nothing else in the product would tell them about');
    assert.match(page, /\(optional\)/, 'marked optional, because everything works without it');
    assert.match(page, /href="\/setup"/, 'the key step links to the key page');
    assert.match(page, /href="\/requests\/new"/, 'the request step links to the request form');
    assert.match(page, /href="\/admin\/test-email"/, 'and the mail step to the page that proves a relay works');

    // Deriving the state is what makes the tick appear without anything being acknowledged or reloaded.
    await setUpKey(client);
    const afterKey = await (await client.get('/requests')).text();
    assert.match(afterKey, /Make your encryption key/, 'a done step stays on the list');
    assert.match(afterKey, /class="tick">✓/, 'but is ticked');
    assert.match(afterKey, /3 things left/, 'and the count has gone down: the request, the mail, the invite');
  });
});

test('once the essentials are done the card is gone, and email being unset does not bring it back', async (t) => {
  await withServer(async ({ agent, db }) => {
    const { client } = await practiceWithRequest({ agent, db });
    const set = await (await client.get('/requests')).text();
    assert.ok(!set.includes('Getting started'), 'a practice with a key and a request is not told what to do first');
    // The optional steps are genuinely optional: the card says it leaves when the *first two* are done, and this
    // is the assertion that keeps that sentence true.
    assert.match(set, /2025 return/, 'the board shows the work instead');
  });
});

test('the first-run card never follows somebody into a filtered view', async (t) => {
  await withServer(async ({ agent }) => {
    const client = agent();
    await signUp(client, 'sam@practice.example');

    assert.match(await (await client.get('/requests')).text(), /Getting started/, 'on the home state it shows');
    // The closed tab is a list of finished work, and a checklist is not about any of it. Same reasoning as the
    // season notice: an interruption that follows somebody around stops being a message and becomes furniture.
    assert.ok(
      !(await (await client.get('/requests?closed=1')).text()).includes('Getting started'),
      'but not in the closed tab',
    );
    assert.ok(
      !(await (await client.get('/requests?q=northwind')).text()).includes('Getting started'),
      'nor under a search',
    );
  });
});

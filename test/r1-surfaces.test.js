/**
 * The three surfaces R1 changed that a person actually reads: the health check, the email attachment form, and
 * the heading above the close/repeat controls.
 *
 * Each is small, and each is the kind of thing that silently reverts — a health payload refactored back to
 * "just spread everything", a warning paragraph deleted as verbose, a heading restored from a copy of the file
 * that predates the fix. So each gets an assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PASSWORD, agent, practiceWithRequest, withServer } from './helpers.js';

/** Run `body` with MULTI_TENANT set as given, and always put the environment back. */
async function asHosted(value, body) {
  const before = process.env.MULTI_TENANT;
  if (value === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = before;
  }
}

test('/healthz tells a self-hosted operator which build is running', async () => {
  await asHosted(undefined, () => withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/healthz`)).json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string', 'the operator can see what they are running');
    assert.equal(typeof body.practices, 'number');
  }));
});

test('/healthz on a hosted install discloses nothing but "up"', async () => {
  await asHosted('1', () => withServer(async ({ base }) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200, 'it is still a health check');
    const body = await response.json();
    // A version is a fingerprint and a practice count is somebody's business. Neither is a stranger's.
    assert.deepEqual(body, { ok: true });
    assert.equal('version' in body, false);
    assert.equal('practices' in body, false);
  }));
});

test('the attachment form says the file is not encrypted, before it is sent', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const page = await (await practice.client.post(`/requests/${practice.requestId}/send`, {})).text();

    assert.match(page, /Attach a file/, 'the feature is still offered');
    assert.match(page, /not encrypted by Tickmark/, 'and the boundary is stated where the control is');
    assert.match(page, /mail provider and the recipient's mailbox both keep a copy/);
    assert.match(page, /Send a client's own documents through the request instead/);
  });
});

test('the reminder form says the same thing, because it is the same control', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const page = await (await practice.client.post(`/requests/${practice.requestId}/remind`, {})).text();
    assert.match(page, /not encrypted by Tickmark/);
  });
});

test('the section above the close controls is named for what it does', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const page = await (await practice.client.get(`/requests/${practice.requestId}`)).text();

    assert.match(page, /Close this request, or do it again/);
    // The old heading described nothing in its section, and it is on the screen a practice lives in.
    assert.doesNotMatch(page, /<h2>The file itself<\/h2>/);
    // The controls it heads are unchanged.
    assert.match(page, /Close this request<\/button>/);
    assert.match(page, /Do this again<\/button>/);
  });
});

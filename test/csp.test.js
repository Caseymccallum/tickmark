/**
 * The Content-Security-Policy: one nonce per response, stamped into the header and the markup at the
 * one seam every page passes through.
 *
 * What these defend: the policy is strict enough to matter (`default-src 'none'`, no `unsafe-inline`
 * anywhere), the nonce in the markup is the nonce the header names (or the browser throws the page's
 * styling away), it changes per response (or it is decoration), and — the part a policy silently
 * breaks — nothing the product renders still uses the two things a nonce cannot bless: inline style
 * attributes and inline event handlers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLink, practiceWithRequest, withServer } from './helpers.js';

test('a page carries a policy whose nonce matches its own markup', async (t) => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/signin`);
    const policy = response.headers.get('content-security-policy');
    assert.ok(policy, 'the header is there');
    assert.match(policy, /default-src 'none'/, 'nothing is allowed that is not named');
    assert.match(policy, /frame-ancestors 'none'/, 'and nobody frames it');
    assert.ok(!/unsafe-inline/.test(policy), 'no unsafe-inline anywhere — that would undo the point');

    const nonce = /style-src 'nonce-([A-Za-z0-9_-]+)'/.exec(policy)?.[1];
    assert.ok(nonce && nonce.length >= 20, 'the inline work is blessed by a real nonce');

    const body = await response.text();
    assert.ok(body.includes(`<style nonce="${nonce}">`), 'the markup carries exactly the nonce the header names');
    assert.ok(!body.includes('{{nonce}}'), 'and no placeholder survived the stamping');

    const again = await fetch(`${base}/signin`);
    assert.notEqual(again.headers.get('content-security-policy'), policy, 'the nonce is per response, not per process');
  });
});

test('nothing the product renders uses an inline style attribute or an inline event handler', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    const pages = [
      '/signin',
      '/requests',
      `/requests/${requestId}`,
      '/clients',
      '/files',
      '/templates',
      '/chase',
      '/keys',
      '/members',
      '/account/password',
      '/account/email',
      '/account/sessions',
      `/r/${token}`,
    ];
    for (const path of pages) {
      const body = await (await fetch(`${base}${path}`, { headers: { cookie: client.cookie } })).text();
      assert.ok(!/\sstyle="/.test(body), `${path} has no inline style attribute`);
      assert.ok(
        !/\s(?:on(?:click|load|error|submit|change|focus|blur|input|keydown|keyup|dblclick))="/.test(body),
        `${path} has no inline event handler`,
      );
      assert.ok(!body.includes('{{nonce}}'), `${path} is stamped`);
    }
  });
});

test('the copyable fields select themselves without an inline handler', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const draft = await client.post(`/requests/${requestId}/remind`, { days: '30' });
    const body = await draft.text();
    assert.ok(body.includes('data-select-on-click'), 'the behaviour is an attribute plus one nonced script');
    assert.ok(!body.includes('onclick'), 'and nothing is wired inline');

    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /<script nonce="[A-Za-z0-9_-]+">/, 'the binding script is blessed like everything else inline');
  });
});

test('the browser-side modules still load under the policy', async (t) => {
  await withServer(async ({ agent, base, db }) => {
    const { client, requestId } = await practiceWithRequest({ agent, db });
    const { token } = await createLink(client, requestId);

    const response = await fetch(`${base}/r/${token}`);
    const policy = response.headers.get('content-security-policy');
    // The client page's module is same-origin, which `script-src 'self'` covers; the JSON data blocks
    // beside it need nothing at all, because they never execute.
    assert.match(policy, /script-src 'self'/, 'same-origin modules are allowed');
    const body = await response.text();
    assert.ok(body.includes('/assets/upload.js'), 'the client page asks for its module');
    assert.equal((await fetch(`${base}/assets/upload.js`)).status, 200, 'and the module is served');
  });
});
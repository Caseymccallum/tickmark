import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicOrigin } from '../src/public-urls.js';
import { signupPage, loginCodePage } from '../src/tenancy/views.js';
import { html, page } from '../src/views.js';
import { createLink, practiceWithRequest, upload, withServer } from './helpers.js';

test('public navigation configuration accepts only an explicit HTTPS origin', () => {
  assert.equal(publicOrigin('https://www.example.test/'), 'https://www.example.test');
  for (const value of [null, '', 'broken', '//example.test', 'http://example.test', 'javascript:alert(1)',
    'https://user:password@example.test', 'https://example.test/r/private-token', 'https://example.test/?next=evil', 'https://example.test/#secret']) {
    assert.equal(publicOrigin(value), null, String(value));
  }
});

test('standalone marketing output configures sign-in without enabling paid signup or external assets', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-marketing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['tools/build-marketing.mjs', directory], {
    encoding: 'utf8', env: { ...process.env, TICKMARK_PUBLIC_URL: 'https://app.example.test', TICKMARK_MARKETING_URL: 'https://www.example.test' },
  });
  assert.equal(result.status, 0, result.stderr);
  const page = readFileSync(join(directory, 'index.html'), 'utf8');
  assert.match(page, /href="https:\/\/app\.example\.test\/login" data-app-signin rel="noreferrer"/);
  assert.match(page, /rel="canonical" href="https:\/\/www\.example\.test\/"/);
  assert.doesNotMatch(page, /href="[^" ]*\/signup"|<script|<link[^>]+fonts/);
  assert.match(page, /Fictional preview/);
  const rejected = spawnSync(process.execPath, ['tools/build-marketing.mjs', join(directory, 'bad')], {
    encoding: 'utf8', env: { ...process.env, TICKMARK_PUBLIC_URL: 'https://app.example.test/r/secret' },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /must be an HTTPS origin/);
});

test('gateway presentation preserves signup fields, escaping and inactive billing disclosure', () => {
  const page = signupPage({ values: { practice_name: '<script>bad</script>', email: 'owner@example.test' }, problem: '<b>refused</b>' }).value;
  assert.match(page, /form method="post" action="\/signup"/);
  for (const name of ['practice_name', 'email', 'password']) assert.ok(page.includes(`name="${name}"`));
  assert.match(page, /role="alert">&lt;b&gt;refused&lt;\/b&gt;/);
  assert.match(page, /value="&lt;script&gt;bad&lt;\/script&gt;"/);
  assert.match(page, /Payments are not configured/);
  assert.doesNotMatch(page, /\sstyle="|\sonclick="/);
});

test('hosted challenge retains scoped action and recovery-code explanation after layout changes', () => {
  const page = loginCodePage({ codePath: '/t/example/signin/code', problem: 'Try again' }).value;
  assert.match(page, /form method="post" action="\/t\/example\/signin\/code"/);
  assert.match(page, /name="code" inputmode="text" aria-describedby="code-help"/);
  assert.match(page, /autocomplete="one-time-code"/);
  assert.match(page, /id="code-help"/);
  assert.match(page, /recovery code works once/);
});

test('workspace shell keeps navigation and POST sign-out with an accessible native mobile menu', () => {
  const rendered = page({ title: 'Clients', practitioner: { email: '<owner@example.test>' }, here: '/clients',
    marketingUrl: 'https://www.example.test', body: html`<h1>Clients</h1>` }).value;
  assert.match(rendered, /<details class="mobile-nav"><summary>Workspace menu<\/summary>/);
  assert.match(rendered, /href="\/clients" aria-current="page"/);
  assert.match(rendered, /form method="post" action="\/signout"/);
  assert.match(rendered, /&lt;owner@example.test&gt;/);
  assert.match(rendered, /href="https:\/\/www.example.test\/" rel="noreferrer"/);
  assert.match(rendered, /name="robots" content="noindex, nofollow"/);
  assert.match(rendered, /id="main" tabindex="-1"/);
  const refused = page({ title: 'Client page', signIn: false, marketingUrl: 'https://example.test/r/bearer-secret', body: html`<h1>Documents</h1>` }).value;
  assert.doesNotMatch(refused, /bearer-secret|Public website|href="\/signin"/);
});

test('client checklist keeps encrypted upload contracts and distinguishes receipt, review and replacement', async () => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { token } = await createLink(practice.client, practice.requestId);
    const read = async () => (await fetch(`${base}/r/${token}`)).text();
    const first = await read();
    assert.match(first, /<ol class="client-checklist" aria-label="Document checklist">/);
    assert.match(first, /class="status" role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(first, /aria-label="Upload one or more files for:/);
    assert.doesNotMatch(first, /class="sidebar"|href="\/signin"/);
    for (const itemId of practice.itemIds) {
      const result = await upload({ base, token, itemId, publicKey: practice.keys.publicKey, plaintext: Buffer.from('FICTIONAL document'), filename: 'fictional.pdf' });
      assert.equal(result.response.status, 201);
    }
    assert.match(await read(), /Awaiting review by the practice/);
    await practice.client.post(`/requests/${practice.requestId}/items/${practice.itemIds[0]}/check`, {});
    assert.match(await read(), /Checked by the practice/);
    await practice.client.post(`/requests/${practice.requestId}/items/${practice.itemIds[0]}/attention`, { attention_note: 'Please send the missing second page' });
    const replacement = await read();
    assert.match(replacement, /please send this again/);
    assert.match(replacement, /Please send the missing second page/);
    assert.doesNotMatch(replacement, /Thank you — everything asked for has arrived/);
  });
});

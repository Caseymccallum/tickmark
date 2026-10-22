import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicOrigin } from '../src/public-urls.js';

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

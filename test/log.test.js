/**
 * The operational log: one JSON line per event, and nothing when it is told to be quiet.
 *
 * The app writes these through an injected `log`, so what is tested here is the shape of a line and the
 * fact that `NULL_LOG` writes none — the request and failure call sites in `src/app.js` are covered by
 * every other test, which runs with `NULL_LOG` and so keeps its own output clean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NULL_LOG, log } from '../src/log.js';

/** Run `fn` with one of the console streams swapped for a capture, and put it back afterwards. */
function capture(stream, fn) {
  const written = [];
  const original = console[stream];
  console[stream] = (line) => written.push(line);
  try {
    fn();
  } finally {
    console[stream] = original;
  }
  return written;
}

test('a line is one JSON object with a time, a level, and a stable event name', () => {
  const written = capture('log', () => log('info', 'request', { method: 'GET', status: 200, ms: 12 }));
  assert.equal(written.length, 1, 'exactly one line per event');

  const line = JSON.parse(written[0]);
  assert.equal(line.level, 'info');
  assert.equal(line.event, 'request', 'a dotted name, not a sentence');
  assert.equal(line.method, 'GET');
  assert.equal(line.status, 200);
  assert.ok(!Number.isNaN(Date.parse(line.ts)), 'and a time an aggregator can parse');
});

test('a failure goes to the error stream, carrying its detail', () => {
  const written = capture('error', () => log('error', 'request.failed', { path: '/requests', error: 'boom' }));
  const line = JSON.parse(written[0]);
  assert.equal(line.level, 'error');
  assert.equal(line.event, 'request.failed');
  assert.equal(line.error, 'boom', 'the message travels with it, so the line stands alone');
});

test('the null log writes nothing', () => {
  const out = capture('log', () => NULL_LOG('info', 'request', {}));
  const err = capture('error', () => NULL_LOG('error', 'request.failed', {}));
  assert.equal(out.length, 0, 'nothing on the log stream');
  assert.equal(err.length, 0, 'and nothing on the error stream');
});
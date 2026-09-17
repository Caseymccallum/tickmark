/**
 * Shared plumbing for the HTTP tests.
 *
 * One cookie-jar implementation and one server-starting helper, shared rather than copied,
 * because two copies of a test harness are two chances for the harness to be wrong in
 * different ways — the failing test would then be the harness's fault, which is the worst
 * kind of red.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

/** A browser-like client that keeps its own cookie jar. */
export function agent(base) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(base + path, { ...options, headers, redirect: 'manual' });
      const set = response.headers.getSetCookie();
      if (set.length > 0) cookie = set.map((value) => value.split(';')[0]).join('; ');
      return response;
    },
    post(path, fields, extra = {}) {
      return this.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(extra.headers ?? {}) },
        body: new URLSearchParams(fields).toString(),
      });
    },
    get(path) {
      return this.request(path);
    },
  };
}

/**
 * Start the real server on a port nobody chose, in a data directory that is thrown away
 * afterwards — including the uploaded blobs, because a test that leaves files behind is a
 * test that fills a disk.
 */
export async function withServer(run, { maxUploadBytes } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-test-'));
  const blobDir = join(directory, 'blobs');
  const db = openDatabase(join(directory, 'tickmark.db'));
  const server = createApp(db, { blobDir, maxUploadBytes });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db, blobDir, agent: () => agent(base) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export const PASSWORD = 'a long enough password';
export const signUp = (client, email, password = PASSWORD) => client.post('/signup', { email, password });

/**
 * Sign a practice up, create one request with three items, and return what a test needs.
 *
 * Item ids come from the database rather than by scraping the page: the page they appear on
 * is the *client's*, which needs a link first, and a test helper that quietly depended on a
 * page's markup would break every time the page changed.
 */
export async function practiceWithRequest({ agent, db }, email = 'sam@practice.example') {
  const client = agent();
  await signUp(client, email);
  const created = await client.post('/requests', {
    client: 'Northwind Ltd',
    client_email: 'accounts@northwind.example',
    title: '2025 return',
    items: 'Bank statements\nSigned engagement letter\nPhoto ID',
  });
  const requestId = created.headers.get('location').split('/').pop();
  const itemIds = db
    .prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position')
    .all(requestId)
    .map((row) => row.id);
  return { client, requestId, itemIds };
}
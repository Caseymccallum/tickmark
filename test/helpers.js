/**
 * Shared plumbing for the HTTP tests.
 *
 * **This file is not a test, and `npm test` does not run it.** The test script names the test files
 * explicitly (`node --test "test/*.test.js"`) because Node's default discovery executes *every* `.js`
 * file under a directory named `test`, recursively — and counts each one as a passing test. Plain
 * `node --test` therefore reported two more tests than exist, this file and `test/smtp-relay.js` being
 * the two. A count that overstates itself by two is exactly the kind of claim this project tries not to
 * make.
 *
 * One cookie-jar implementation and one server-starting helper, shared rather than copied,
 * because two copies of a test harness are two chances for the harness to be wrong in
 * different ways — the failing test would then be the harness's fault, which is the worst
 * kind of red.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { NULL_LOG } from '../src/log.js';
import { encryptFile, generatePracticeKey, unwrapPracticeKey } from '../web/tickmark-crypto.js';

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
 * One request, raw: the status, the headers exactly as sent, and the bytes exactly as they arrived.
 *
 * `fetch` decompresses transparently and hides what a test like this needs to see — whether the bytes were
 * compressed, what `content-length` says, whether the answer was a 304 — so a raw socket is the only way to ask.
 * One copy, here, for the same reason the cookie jar is one copy.
 */
export function raw(base, path, { headers = {} } = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (answer) => {
        const chunks = [];
        answer.on('data', (chunk) => chunks.push(chunk));
        answer.on('end', () =>
          resolve({ status: answer.statusCode, headers: answer.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    call.on('error', reject);
    call.end();
  });
}

/**
 * Start the real server on a port nobody chose, in a data directory that is thrown away
 * afterwards — including the uploaded blobs, because a test that leaves files behind is a
 * test that fills a disk.
 */
/**
 * What the app handed the mailer, newest last — and how to get a link back out of it.
 *
 * Sign-up and password-reset are two-step on purpose: the link that finishes either is *sent*, never
 * shown to whoever asked (see `src/signin-views.js`). So a test that brings a mail server finishes the
 * step by reading the link out of the letter that carried it — the same thing the recipient does —
 * rather than off the page, where with a mailer it deliberately is not. `withServer` fills this by
 * listening on the mailer's `onSent`. A test with no mail server has the link on the page instead (the
 * "drafted, not sent" trial fallback) and never reaches for this.
 */
const sent = [];
export const sentMessages = () => sent;

/** The token out of the most recent letter whose link points at `path` — `'verify'`, or `'reset'`. */
export function linkFromSent(path) {
  const pattern = new RegExp(`/${path}/([A-Za-z0-9_-]{20,})`);
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const match = pattern.exec(String(sent[i]?.body ?? ''));
    if (match) return match[1];
  }
  return null;
}

/**
 * The two-step account letters, held back from the relay.
 *
 * Sign-up and password-reset each send one link, and a test that brings a mail server is usually
 * counting the *product's* mail — "exactly one reminder went out". The account letters are harness
 * setup, not that: so `withServer` takes them (via the mailer's `onOutgoing`) instead of letting them
 * land on the relay and be counted beside the reminder. They land here instead, and `signUp` reads the
 * link out of them the way a recipient would. Matched on subject, which is the one thing that says
 * what a letter is.
 */
const ACCOUNT_LETTER = /Finish creating your Tickmark practice|You already have a Tickmark practice|Set a new password for Tickmark/;

export async function withServer(run, { maxUploadBytes, maxRequestBytes, maxRequestFiles, mailer, sms, chaseBudgetMs, signInLimiter, signUpLimiter, clientLimiter, webDir } = {}) {
  sent.length = 0;
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-test-'));
  const blobDir = join(directory, 'blobs');
  const db = openDatabase(join(directory, 'tickmark.db'));
  const server = createApp(db, {
    blobDir,
    maxUploadBytes,
    maxRequestBytes,
    maxRequestFiles,
    mailer: mailer
      ? {
          ...mailer,
          onOutgoing: (message) => {
            sent.push(message);
            return ACCOUNT_LETTER.test(String(message.subject ?? '')) ? false : undefined;
          },
        }
      : null,
    sms,
    chaseBudgetMs,
    signInLimiter,
    signUpLimiter,
    clientLimiter,
    webDir,
    log: NULL_LOG,
  });
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
export const PASSPHRASE = 'a passphrase long enough';

/**
 * Two fetches of one page differ in exactly one thing: the CSP nonce is per response by design (see
 * `src/views.js`), so tests that compare rendered bodies compare them modulo their nonces. One
 * helper, because two normalisers would be two chances to drift from what the server stamps.
 */
export const denonce = (markup) => markup.replace(/nonce="[A-Za-z0-9_-]+"/g, 'nonce="…"');

/**
 * What a message's body says, decoded — for both shapes `buildMessage` writes: the single-part text,
 * and the `text/plain` half of a styled `multipart/alternative`. One helper because a decoder that
 * only understands one shape is how "the styled mail broke the words" hides in a red test.
 */
export function plainBody(message) {
  const text = String(message);
  const payload = /Content-Type: multipart\/alternative/.test(text)
    ? /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1]
    : text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  return Buffer.from((payload ?? '').replace(/=\r\n/g, '').replace(/\r\n/g, ''), 'base64').toString('utf8');
}
/**
 * Sign a practice up, and finish it the way a person has to.
 *
 * Sign-up is two steps by design (see `src/signin-views.js`): the account is only made when the link
 * sent to the address is opened, which is what stops sign-up being a way to find out who has a
 * practice. With no mail server — every test that does not bring a fake relay — the trial shows that
 * link on the page, the same "drafted, not sent" fallback reminders use. So this helper opens the link
 * and confirms it, and hands back the response that *created* the account (a 303), so callers that
 * check `status === 303` keep saying what they mean.
 *
 * A response that is not the "check your email" page — a too-short password, a rate limit — is handed
 * back untouched and **unread**, so a test can still read its body to check the words.
 */
export async function signUp(client, email, password = PASSWORD) {
  const response = await client.post('/signup', { email, password });
  if (response.status !== 200) return response;
  // On the page when there is no mail server; in the letter the mailer carried when there is one.
  // Either way it is the same link the person would open, so the step below is the same step.
  let token = /\/verify\/([A-Za-z0-9_-]{20,})/.exec(await response.text())?.[1] ?? null;
  if (!token) token = linkFromSent('verify');
  if (!token) return response;
  await client.get(`/verify/${token}`);
  return client.post(`/verify/${token}`, {});
}

/**
 * Give a signed-in practice an encryption key, which is what sending a link requires.
 *
 * This runs the real browser flow's server half: the key pair is generated here with the same
 * module the browser uses, and the passphrase-wrapped private half is posted as the page posts
 * it. Nothing is faked, so a change to the wrapping format breaks these tests rather than
 * passing them.
 */
export async function setUpKey(client, passphrase = PASSPHRASE) {
  const keys = await generatePracticeKey(passphrase);
  const response = await client.post('/setup', {
    public_key: JSON.stringify(keys.publicKey),
    wrapped_private_key: keys.wrappedPrivateKey,
  });
  if (response.status !== 303) {
    throw new Error(`the test helper could not store a key: /setup answered ${response.status}`);
  }
  return { ...keys, response, passphrase };
}

/**
 * Create a link through the practice's own page, and take the token out of the page that shows it
 * once.
 *
 * The token is scraped from the rendered page rather than read from the database, because there is
 * nothing in the database to read: only its digest is stored, and a helper that could produce it
 * another way would be testing a flow the product does not have.
 */
export async function createLink(client, requestId, days = '30') {
  const response = await client.post(`/requests/${requestId}/link`, { days });
  const token = /\/r\/([A-Za-z0-9_-]{20,})/.exec(await response.text())?.[1];
  return { response, token };
}

/**
 * Encrypt a file to the practice's public key and send it the way the client's page does.
 *
 * Everything about this mirrors `web/upload.js`: the same content type, the same two headers,
 * and the envelope produced by the same function.
 */
export async function upload({ base, token, itemId, publicKey, plaintext, filename = 'upload.bin', note = null, headers = {} }) {
  const envelope = await encryptFile(publicKey, plaintext);
  const response = await fetch(`${base}/r/${token}/items/${itemId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(filename),
      ...(note === null ? {} : { 'x-note': encodeURIComponent(note) }),
      ...headers,
    },
    body: envelope,
  });
  return { response, envelope };
}

/**
 * Sign a practice up, create one request with three items, and return what a test needs.
 *
 * Item ids come from the database rather than by scraping the page: the page they appear on
 * is the *client's*, which needs a link first, and a test helper that quietly depended on a
 * page's markup would break every time the page changed.
 */
export async function practiceWithRequest({ agent, db }, email = 'sam@practice.example', passphrase = PASSPHRASE) {
  const client = agent();

  // Both steps check their outcome. A helper that carries on after a refused sign-up produces a
  // test that passes while exercising nothing — which is exactly what happened the first time this
  // was written, and it cost more time to find than the check would have.
  const signup = await signUp(client, email);
  if (signup.status !== 303) {
    throw new Error(
      `the test helper could not create ${email}: /signup answered ${signup.status}. Use a different address — emails are unique per practice.`,
    );
  }

  const keys = await setUpKey(client, passphrase);
  const created = await client.post('/requests', {
    client: 'Northwind Ltd',
    client_email: 'accounts@northwind.example',
    title: '2025 return',
    items: 'Bank statements\nSigned engagement letter\nPhoto ID',
  });
  const location = created.headers.get('location') ?? '';
  if (created.status !== 303 || !/^\/requests\/[0-9a-f-]{36}$/.test(location)) {
    throw new Error(
      `the test helper could not create a request for ${email}: /requests answered ${created.status} -> ${location}`,
    );
  }
  const requestId = location.split('/').pop();
  const itemIds = db
    .prepare('SELECT id FROM request_item WHERE request_id = ? ORDER BY position')
    .all(requestId)
    .map((row) => row.id);
  return {
    client,
    requestId,
    itemIds,
    keys,
    privateKey: await unwrapPracticeKey(keys.wrappedPrivateKey, passphrase),
  };
}
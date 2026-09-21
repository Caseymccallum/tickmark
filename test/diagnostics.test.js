/**
 * The four onboarding guards, through the real server:
 *
 * 1. the passphrase warning on the setup page, made unskippable by a confirmation;
 * 2. duplicating a request — title and checklist carried, client and due date left blank;
 * 3. the mail test page at /admin/test-email, success and failure both shown as sentences.
 *
 * (The item-rejection workflow — "needs attention" plus a note the client can read — is covered
 * end to end in `test/items.test.js`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { withServer, signUp, setUpKey, practiceWithRequest } from './helpers.js';

/** A relay that accepts everything, and remembers it. Copied small from `send.test.js`. */
async function relay(t) {
  const seen = { messages: [] };
  const server = createServer((socket) => {
    socket.write('220 relay here\r\n');
    let buffer = '';
    let inData = false;
    let lines = [];
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            seen.messages.push(lines.join('\r\n'));
            lines = [];
            socket.write('250 queued\r\n');
            continue;
          }
          lines.push(line);
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250 relay\r\n');
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('QUIT')) socket.write('250 ok\r\n');
        else if (upper.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: server.address().port };
}

const mailerAt = (port) => ({
  host: '127.0.0.1',
  port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Northwind Practice <office@practice.example>',
  timeoutMs: 3000,
  describe: () => `127.0.0.1:${port}`,
});

// --- 1. the passphrase warning ------------------------------------------------------------

test('the first setup page warns hard, and the key cannot be made without confirming it is saved', async (t) => {
  await withServer(async ({ agent }) => {
    const client = agent();
    await signUp(client, 'sam@practice.example');

    const page = await (await client.get('/setup')).text();
    assert.match(page, /class="danger"/, 'the warning is its own box, not a paragraph');
    assert.match(page, /zero-knowledge encryption/, 'and it says what the encryption is');
    assert.match(page, /cannot be recovered by anyone/, 'and what losing the passphrase costs');
    assert.match(page, /1Password,\s*Bitwarden/, 'and where to put it');
    assert.match(page, /id="saved-passphrase"/, 'there is a confirmation to give');
    assert.match(page, /<button type="submit" disabled>/, 'the button starts disabled');

    // A second key is not a first key: the warning is about creating the practice's key, and
    // re-checking the box on every rotation would be nagging rather than safety.
    await setUpKey(client);
    const again = await (await client.get('/setup')).text();
    assert.ok(!again.includes('class="danger"'), 'the danger box is the first key\'s alone');
    assert.ok(!again.includes('id="saved-passphrase"'), 'and so is the confirmation');
  });
});

// --- 2. duplicating a request ---------------------------------------------------------------

test('a request duplicates with its title and checklist, and the client is left to be chosen', async (t) => {
  await withServer(async ({ agent, db }) => {
    const p = await practiceWithRequest({ agent, db });
    await p.client.post(`/requests/${p.requestId}/items/${p.itemIds[2]}/withdraw`);

    const page = await (await p.client.get(`/requests/${p.requestId}`)).text();
    assert.match(page, /Duplicate this request/, 'the request page offers the duplicate');

    const list = await (await p.client.get('/requests')).text();
    assert.match(list, /\/requests\/new\?from=/, 'and so does the list');

    const prefilled = await (await p.client.get(`/requests/new?from=${p.requestId}`)).text();
    assert.match(prefilled, /value="2025 return"/, 'the title is carried');
    assert.match(prefilled, /id="client" name="client" required value=""/, 'the client is blank');
    assert.match(prefilled, /id="due" name="due" type="date" value=""/, 'and so is the due date');

    const carried = /<textarea id="items"[^>]*>([\s\S]*?)<\/textarea>/.exec(prefilled)?.[1];
    assert.match(carried, /Bank statements/, 'the checklist is carried');
    assert.ok(!/Photo ID/.test(carried), 'withdrawn items are not');

    // And the duplication completes: the practice names a client, and a new request exists.
    const created = await p.client.post('/requests', {
      client: 'Lodis Ltd',
      client_email: 'accounts@lodis.example',
      title: '2025 return',
      items: carried,
    });
    assert.equal(created.status, 303);
    const count = db.prepare('SELECT COUNT(*) AS n FROM request WHERE title = ?').get('2025 return');
    assert.equal(count.n, 2, 'two requests, the original untouched');

    // A closed request is a template too: the closed list offers the same duplicate.
    await p.client.post(`/requests/${p.requestId}/close`, {});
    const closed = await (await p.client.get('/requests?closed=1')).text();
    assert.match(closed, /\/requests\/new\?from=/, 'the closed list offers it as well');

    const fresh = await (await p.client.get(`/requests/new?from=${p.requestId}`)).text();
    assert.match(fresh, /value="2025 return"/, 'and a closed request still fills the form in');
  });
});

// --- 3. the mail test page -------------------------------------------------------------------

test('the mail test page needs a session, and says so plainly when sending is not configured', async (t) => {
  await withServer(async ({ agent }) => {
    const anonymous = agent();
    const refused = await anonymous.get('/admin/test-email');
    assert.equal(refused.status, 303);
    assert.equal(refused.headers.get('location'), '/signin');

    const client = agent();
    await signUp(client, 'sam@practice.example');
    const page = await (await client.get('/admin/test-email')).text();
    assert.match(page, /Sending is not configured/);
    assert.match(page, /TICKMARK_SMTP_URL/, 'and names the variables to set');
    assert.ok(!page.includes('Send the test message'), 'with no relay, there is nothing to press');
  });
});

test('the mail test page sends through the configured relay, and says the relay accepted it', async (t) => {
  const fake = await relay(t);
  await withServer(
    async ({ agent, db }) => {
      const p = await practiceWithRequest({ agent, db });

      const page = await (await p.client.get('/admin/test-email')).text();
      assert.match(page, /Sending from <strong>127\.0\.0\.1:\d+<\/strong>/, 'it says where from');
      assert.match(page, /office@practice\.example/, 'and as whom');

      const sent = await p.client.post('/admin/test-email', { email: 'the-practice@northwind.example' });
      assert.equal(sent.status, 200);
      const shown = await sent.text();
      assert.match(shown, /class="success"/);
      assert.match(shown, /the-practice@northwind\.example/, 'named for the address it went to');
      assert.match(shown, /Acceptance is not\s+delivery/, 'and does not overclaim');

      assert.equal(fake.seen.messages.length, 1, 'one message went out');
      assert.match(fake.seen.messages[0], /Subject: Tickmark test message/, 'and it is the test message');
    },
    { mailer: mailerAt(fake.port) },
  );
});

test('a relay that cannot be reached is reported as the step that failed, not as a shrug', async (t) => {
  // A port nothing is listening on: the connection is refused at once.
  const closed = createServer(() => {});
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  await withServer(
    async ({ agent, db }) => {
      const p = await practiceWithRequest({ agent, db });

      const sent = await p.client.post('/admin/test-email', { email: 'the-practice@northwind.example' });
      assert.equal(sent.status, 400);
      const page = await sent.text();
      assert.match(page, /<strong>Not sent\.<\/strong>/);
      assert.match(page, /connection:/, 'the step that failed is named');
      assert.match(page, /The relay could not be reached/, 'with one sentence that says what that means');
      assert.match(page, /127\.0\.0\.1/, 'and the host it could not reach');
    },
    { mailer: mailerAt(deadPort) },
  );
});

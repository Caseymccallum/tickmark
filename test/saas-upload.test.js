/**
 * A client submitting a document, through the hosted server.
 *
 * This is the whole point of the product, and it crosses every boundary the SaaS layer introduced:
 * a one-time link resolves a tenant with no host of its own, the practice's public key travels to
 * the client's browser, the encrypted envelope is written into *that tenant's* blob directory, and
 * the practice sees it arrive. If any of those seams were wrong, this is where it shows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSaasServer } from '../src/tenancy/entry.js';
import { createAccount, createTenant, mapHost } from '../src/tenancy/registry.js';
import { agent, upload } from './helpers.js';

const PASSWORD = 'a long enough password';
const EMAIL = 'sam@acme.example';

async function withHostedPractice(run, { provision } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tickmark-upload-'));
  const saas = createSaasServer({
    registryFile: join(directory, 'saas.db'),
    tenantsRoot: join(directory, 'tenants'),
    env: {},
  });
  try {
    // A practice that has paid, mapped to its own address — what the gateway leaves behind after
    // a successful checkout.
    const accountId = await createAccount(saas.registry, { email: EMAIL, password: PASSWORD });
    const tenant = createTenant(saas.registry, saas.pool, {
      ownerAccountId: accountId,
      name: 'Acme Accounting',
      email: EMAIL,
      status: 'active',
    });
    mapHost(saas.registry, { tenantId: tenant.id, host: 'acme.example' });
    if (provision) await provision({ ...saas, tenant, accountId });

    await new Promise((resolve) => saas.server.listen(0, resolve));
    const base = `http://127.0.0.1:${saas.server.address().port}`;
    await run({ base, ...saas, tenant, client: agent(base) });
  } finally {
    try {
      saas.server.closeAllConnections?.();
      await new Promise((resolve) => saas.server.close(resolve));
    } catch {
      // Cleanup never outranks the test's own result.
    }
    try {
      saas.pool.closeAll();
      saas.registry.close();
    } catch {
      // As above.
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`tickmark test cleanup: ${directory} not removed — ${error.code ?? error.message}`);
    }
  }
}

test('a client can submit a document to a hosted practice, and it lands in that practice\u2019s own files', async () => {
  await withHostedPractice(async ({ base, client, tenant, pool }) => {
    // The member signs in at the platform, which bridges a session into the practice's own file.
    const signedIn = await client.post('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(signedIn.status, 303);

    // The practice makes its key, asks for a document, and issues a link.
    const { generatePracticeKey } = await import('../web/tickmark-crypto.js');
    const { publicKey: practicePublicKey, wrappedPrivateKey } = await generatePracticeKey(PASSWORD);
    const keyed = await client.post('/t/acme-accounting/setup', {
      public_key: JSON.stringify(practicePublicKey),
      wrapped_private_key: wrappedPrivateKey,
    });
    assert.equal(keyed.status, 303, 'the practice has a key');

    const created = await client.post('/t/acme-accounting/requests', {
      client: 'Northwind Ltd',
      client_email: 'accounts@northwind.example',
      title: '2025 return',
      items: 'Bank statements',
    });
    assert.equal(created.status, 303);
    const requestId = created.headers.get('location').split('/').pop();

    const linked = await client.post(`/t/acme-accounting/requests/${requestId}/link`, { days: '30' });
    const linkPage = await linked.text();
    const token = /\/r\/([A-Za-z0-9_-]+)/.exec(linkPage)?.[1];
    assert.ok(token, 'a link was issued');

    // The client opens the link with no host of their own — the token alone must find the practice.
    const clientPage = await client.get(`/r/${token}`);
    assert.equal(clientPage.status, 200, 'the client page opens');
    const page = await clientPage.text();
    assert.match(page, /2025 return/);
    const itemId = new RegExp(`/r/${token}/items/([0-9a-f-]{36})`).exec(page)?.[1];
    assert.ok(itemId, 'the page offers somewhere to put the file');

    // And submits an encrypted file, the way the browser does.
    const before = pool.stats().open;
    const { response } = await upload({
      base,
      token,
      itemId,
      publicKey: practicePublicKey,
      plaintext: Buffer.from('the 2025 bank statements'),
      filename: 'statements.pdf',
    });
    assert.ok(response.ok, `the upload was accepted (${response.status})`);

    // It is in the practice's own blob directory, and it is the ciphertext, not the file.
    const blobDir = join(pool.root, tenant.id, 'blobs', requestId);
    assert.ok(existsSync(blobDir), `the tenant has a blob directory at ${blobDir}`);
    const stored = readdirSync(blobDir);
    assert.equal(stored.length, 1, 'one file arrived');
    assert.ok(!page.includes('the 2025 bank statements'), 'and the plaintext was never on the page');

    // The practice sees it arrive.
    const requestPage = await client.get(`/t/acme-accounting/requests/${requestId}`);
    const shown = await requestPage.text();
    assert.match(shown, /1 of 1 received/, 'the practice is told the document arrived');
    assert.ok(pool.stats().open >= before, 'and the practice\u2019s database was the one written to');
  });
});

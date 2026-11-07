/**
 * Cross-origin protection for requests that change state.
 *
 * `SameSite=Lax` already stops another site's form from carrying the session cookie, and for a long time that
 * was the whole defence — a browser behaviour rather than a server decision. The server now decides, in one
 * place, before any route is reached.
 *
 * The interesting case is not the foreign origin; it is the *absent* one. A browser sends `Origin` on every
 * mutating request, so a request without it is not a browser, and refusing those would break the documented
 * tools and the Stripe webhook while protecting nothing. That reasoning is tested here so it stays a decision
 * rather than an accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserOriginOf, crossOriginProblem } from '../src/http.js';
import { PASSWORD, agent, practiceWithRequest, withServer } from './helpers.js';

/** A request shape `crossOriginProblem` understands, without opening a socket. */
const ask = (method, headers = {}) => ({ method, headers });

/** Run `body` with TICKMARK_PUBLIC_URL set, and always put the environment back. */
function withPublicUrl(value, body) {
  const before = process.env.TICKMARK_PUBLIC_URL;
  if (value === undefined) delete process.env.TICKMARK_PUBLIC_URL;
  else process.env.TICKMARK_PUBLIC_URL = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.TICKMARK_PUBLIC_URL;
    else process.env.TICKMARK_PUBLIC_URL = before;
  }
}

// --- the rule, on its own -----------------------------------------------------------------------

test('a safe method is never refused, whatever it claims', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(crossOriginProblem(ask(method, { origin: 'https://evil.example' })), null);
    assert.equal(crossOriginProblem(ask(method, { 'sec-fetch-site': 'cross-site' })), null);
  }
});

test('a same-origin browser post is allowed', () => {
  withPublicUrl(undefined, () => {
    const headers = { host: 'tickmark.example', origin: 'http://tickmark.example' };
    assert.equal(crossOriginProblem(ask('POST', headers)), null);
  });
});

test('a foreign origin is refused', () => {
  withPublicUrl(undefined, () => {
    const problem = crossOriginProblem(ask('POST', { host: 'tickmark.example', origin: 'https://evil.example' }));
    assert.match(problem, /is not/);
  });
});

test('a sibling subdomain — same site, different origin — is refused', () => {
  withPublicUrl(undefined, () => {
    assert.match(
      crossOriginProblem(ask('POST', { host: 'app.tickmark.example', origin: 'https://other.tickmark.example' })),
      /is not/,
    );
    // And the fetch metadata catches it even when the Origin header is absent.
    assert.match(
      crossOriginProblem(ask('POST', { host: 'app.tickmark.example', 'sec-fetch-site': 'same-site' })),
      /same-site/,
    );
  });
});

test('Origin: null is refused', () => {
  withPublicUrl(undefined, () => {
    // A sandboxed iframe, a file:// document or an origin-stripped redirect. No form here is served from one.
    assert.match(crossOriginProblem(ask('POST', { host: 'tickmark.example', origin: 'null' })), /null/);
  });
});

test('a missing Origin is allowed, because a browser always sends one', () => {
  withPublicUrl(undefined, () => {
    // curl, an operator tool, a provider webhook. None can be induced by a third-party page, and all of them
    // would break if this were refused.
    assert.equal(crossOriginProblem(ask('POST', { host: 'tickmark.example' })), null);
    assert.equal(crossOriginProblem(ask('DELETE', {})), null);
  });
});

test('conflicting signals are refused rather than resolved in the request’s favour', () => {
  withPublicUrl(undefined, () => {
    // Claims to be same-origin while carrying a foreign Origin. The origin comparison runs after the
    // metadata check, so the stricter answer wins.
    assert.match(
      crossOriginProblem(ask('POST', {
        host: 'tickmark.example', origin: 'https://evil.example', 'sec-fetch-site': 'same-origin',
      })),
      /is not/,
    );
    // And cross-site metadata is refused even when the Origin header happens to match.
    assert.match(
      crossOriginProblem(ask('POST', {
        host: 'tickmark.example', origin: 'http://tickmark.example', 'sec-fetch-site': 'cross-site',
      })),
      /cross-site/,
    );
  });
});

test('scheme and port are part of the identity', () => {
  withPublicUrl(undefined, () => {
    assert.match(
      crossOriginProblem(ask('POST', { host: 'tickmark.example', origin: 'https://tickmark.example' })),
      /is not/,
      'http cannot stand in for https',
    );
    assert.match(
      crossOriginProblem(ask('POST', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3001' })),
      /is not/,
      'a different port is a different origin',
    );
  });
});

test('the configured public origin wins over the Host header', () => {
  withPublicUrl('https://tickmark.practice.example', () => {
    const request = ask('POST', { host: 'internal:3000', origin: 'https://tickmark.practice.example' });
    assert.equal(browserOriginOf(request), 'https://tickmark.practice.example');
    assert.equal(crossOriginProblem(request), null, 'the operator declared this address, so it is the one');

    // And a request that matches the *Host* header instead of the declaration is refused, which is the point:
    // Host is attacker-chosen on a directly-exposed server.
    assert.match(
      crossOriginProblem(ask('POST', { host: 'internal:3000', origin: 'http://internal:3000' })),
      /is not/,
    );
  });
});

test('a configured origin with a path reduces to its origin, and a malformed one does not break serving', () => {
  withPublicUrl('https://example.test/accountancy/', () => {
    // An Origin header never carries a path, so neither may the thing it is compared against.
    assert.equal(browserOriginOf(ask('POST', { host: 'example.test' })), 'https://example.test');
  });
  withPublicUrl('not a url', () => {
    assert.equal(browserOriginOf(ask('POST', { host: 'tickmark.example' })), 'http://tickmark.example');
  });
});

test('a reverse proxy is honoured through x-forwarded-proto', () => {
  withPublicUrl(undefined, () => {
    const request = ask('POST', {
      host: 'tickmark.practice.example', 'x-forwarded-proto': 'https', origin: 'https://tickmark.practice.example',
    });
    assert.equal(crossOriginProblem(request), null, 'TLS terminated at the proxy is still the same origin');
  });
});

// --- what it means to a real request ---------------------------------------------------------------

test('a foreign-origin form cannot change anything, and says so', async () => {
  await withServer(async ({ db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const before = db.prepare('SELECT name FROM practice').get().name;

    const refused = await practice.client.post('/members/name', { name: 'Taken over' }, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /came from another site/);
    assert.equal(db.prepare('SELECT name FROM practice').get().name, before, 'nothing was written');
  });
});

test('a same-origin form still works, and so does a client with no Origin at all', async () => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });

    const sameOrigin = await practice.client.post('/members/name', { name: 'Renamed properly' }, {
      headers: { origin: base, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(sameOrigin.status, 303, 'the real form is unaffected');
    assert.equal(db.prepare('SELECT name FROM practice').get().name, 'Renamed properly');

    const noOrigin = await practice.client.post('/members/name', { name: 'Renamed by curl' });
    assert.equal(noOrigin.status, 303, 'an operator tool with a session is not a cross-site attacker');
  });
});

test('the check runs before authentication, so even a signed-out post is refused', async () => {
  await withServer(async ({ base }) => {
    const refused = await agent(base).post('/signin', { email: 'x@example.test', password: 'y' }, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(refused.status, 403);
  });
});

test('a client’s upload route is protected too, not just the practice’s own', async () => {
  await withServer(async ({ base, db, agent }) => {
    const practice = await practiceWithRequest({ agent, db });
    const { createLink } = await import('./helpers.js');
    // The client link is a bearer capability and this route has no session — which is exactly why the check
    // lives in the dispatcher rather than beside the signed-in routes.
    const { token } = await createLink(practice.client, practice.requestId);
    const refused = await agent(base).post(`/r/${token}/items/${practice.itemIds[0]}`, {}, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(refused.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upload').get().n, 0, 'and nothing was stored');
  });
});

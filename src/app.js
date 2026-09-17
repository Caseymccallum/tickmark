/**
 * The HTTP surface, expressed as a function of a database.
 *
 * There is no framework here on purpose. Every page in version one is a form, a list
 * or a file upload — the case where the platform's own tools are enough, and where a
 * framework would add a dependency tree the *operator* has to trust and keep patched.
 * The surface is a factory rather than a running server so that a test can drive it
 * without binding a port it did not choose.
 */
import { createServer } from 'node:http';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tickmark</title>
  <style>
    body { font: 16px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1.25rem; color: #1a1a1a; }
    code { background: #f4f4f4; padding: .1rem .3rem; border-radius: .2rem; }
    .status { border-left: 3px solid #b45309; padding: .5rem 0 .5rem 1rem; color: #713f12; background: #fffbeb; }
  </style>
</head>
<body>
  <h1>Tickmark</h1>
  <p>The list of documents a client owes you, and a tick as each one arrives.</p>
  <p class="status"><strong>Not built yet.</strong> This page is served by the spike that
  proves the stack, not by the application. There is no sign-in, no request, no link and
  no upload.</p>
  <p>What exists so far: the database schema, the queries, this server, and the tests that
  check them. What is planned, and what is deliberately not planned, is in
  <code>docs/mvp.md</code>.</p>
</body>
</html>
`;

function send(response, status, body, type) {
  response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

export function createApp(db) {
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    // A health check that touches the database, because a process that is up and
    // cannot read its own schema is not healthy.
    if (url.pathname === '/healthz') {
      try {
        const practices = db.prepare('SELECT COUNT(*) AS n FROM practitioner').get().n;
        return send(response, 200, JSON.stringify({ ok: true, practices }), 'application/json');
      } catch (error) {
        return send(response, 503, JSON.stringify({ ok: false, error: error.message }), 'application/json');
      }
    }

    if (url.pathname === '/') return send(response, 200, PAGE, 'text/html; charset=utf-8');

    return send(response, 404, JSON.stringify({ error: 'not found' }), 'application/json');
  });
}
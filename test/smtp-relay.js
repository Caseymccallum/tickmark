/**
 * A fake SMTP relay, shared by the tests that need one.
 *
 * Extracted rather than copied: two protocol doubles are two chances for the double to be wrong in
 * different ways, and then a failing test is the harness's fault — the worst kind of red.
 *
 * Three modes, and the mode is the point of each test that uses it:
 *
 * - **plain** — no TLS at all. A relay on this machine during a trial.
 * - **implicit TLS** — TLS from the first byte, as `smtps://` expects.
 * - **STARTTLS** — plaintext, advertise `STARTTLS`, then *actually perform a handshake on that socket*.
 *   A double that said `220 go ahead` and carried on in the clear would prove nothing about what the
 *   client does after upgrading, so the upgrade here is real: `tls.TLSSocket` with `isServer: true`.
 *
 * `seen` records everything, because the interesting assertions are about the conversation: which lines
 * were sent, in what order, what the login token was, and which of those arrived *after* the handshake.
 *
 * **Not a test, and not run by `npm test`.** Node's default discovery executes every `.js` file under
 * `test/`, recursively, and counts each as a passing test — which is why the script names the test
 * files explicitly. See the note in `test/helpers.js` for the whole finding.
 */
import { createServer } from 'node:net';
import { TLSSocket, createSecureContext, createServer as createTlsServer } from 'node:tls';

/** Everything the relay heard, for a test to assert on. */
function newLedger() {
  return {
    conversation: [],
    messages: [],
    /** The most recent message, for the common case of one. */
    get message() {
      return this.messages.at(-1) ?? null;
    },
    auth: null,
    credentials: null,
    /** True once a handshake has completed on any connection. */
    upgraded: false,
    /** Lines that arrived over TLS, as opposed to before the upgrade. */
    afterUpgrade: [],
  };
}

/**
 * The SMTP state machine, attached to a socket. Called again for the socket that replaces it after a
 * STARTTLS upgrade, so the same rules govern both halves of the conversation.
 */
function attach(socket, seen, options, { overTls = false } = {}) {
  let buffer = '';
  let inData = false;
  let dataLines = [];
  let login = null;

  const record = (line) => {
    seen.conversation.push(line);
    if (overTls) seen.afterUpgrade.push(line);
  };

  const handle = (line) => {
    const upper = line.toUpperCase();

    if (login) {
      seen.credentials ??= [];
      seen.credentials.push(Buffer.from(line, 'base64').toString('utf8'));
      login -= 1;
      socket.write(login === 0 ? `${options.authReply}\r\n` : '334 continue\r\n');
      return;
    }

    if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
      socket.write(`${options.ehlo.join('\r\n')}\r\n`);
      return;
    }
    if (upper === 'STARTTLS') {
      if (options.onStartTls === 'refuse') {
        socket.write('454 TLS not available\r\n');
        return;
      }
      socket.write('220 go ahead\r\n');
      // A relay with no certificate cannot upgrade, so the connection ends here rather than carrying
      // on in the clear. That default matters: a double that advertised STARTTLS and then continued in
      // plaintext would let a broken client pass its own tests, and this harness exists to catch that.
      if (options.onStartTls !== 'upgrade' || !options.starttls) {
        socket.end();
        return;
      }
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: createSecureContext({ cert: options.starttls.cert, key: options.starttls.key }),
      });
      secure.on('secure', () => {
        seen.upgraded = true;
        attach(secure, seen, options, { overTls: true });
      });
      secure.on('error', () => {});
      return;
    }
    if (upper.startsWith('AUTH PLAIN')) {
      seen.auth = 'PLAIN';
      seen.credentials = [Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8')];
      socket.write(`${options.authReply}\r\n`);
      return;
    }
    if (upper === 'AUTH LOGIN') {
      seen.auth = 'LOGIN';
      login = 2;
      socket.write('334 continue\r\n');
      return;
    }
    if (upper.startsWith('MAIL FROM')) {
      socket.write('250 ok\r\n');
      return;
    }
    if (upper.startsWith('RCPT TO')) {
      // `recipientReply` may be a function of the address, so that a test can have one client's mailbox
      // refuse while the rest accept. A run that writes to a list behaves differently when one address is
      // dead, and that is the case worth testing.
      const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
      const reply = typeof options.recipientReply === 'function'
        ? options.recipientReply(address)
        : options.recipientReply;
      socket.write(`${reply}\r\n`);
      return;
    }
    if (upper === 'DATA') {
      inData = true;
      socket.write('354 go ahead\r\n');
      return;
    }
    if (upper === 'QUIT') {
      socket.write('221 bye\r\n');
      socket.end();
    }
  };

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          seen.messages.push(dataLines.join('\r\n'));
          dataLines = [];
          // `delayMs` exists so that a test can have a send take a measurable amount of time — the only
          // way to watch a run stop at its time budget without waiting two minutes for it.
          if (options.delayMs) setTimeout(() => socket.write('250 queued\r\n'), options.delayMs);
          else socket.write('250 queued\r\n');
          continue;
        }
        dataLines.push(line);
        continue;
      }
      record(line);
      handle(line);
    }
  });
  socket.on('error', () => {});
}

export async function startRelay(t, options = {}) {
  const settings = {
    greeting: '220 fake ESMTP',
    ehlo: ['250 fake'],
    authReply: '235 ok',
    recipientReply: '250 ok',
    onStartTls: 'upgrade',
    tls: null,
    starttls: null,
    ...options,
  };

  const seen = newLedger();
  const server = settings.tls
    ? createTlsServer({ cert: settings.tls.cert, key: settings.tls.key }, (socket) => {
        seen.upgraded = true;
        socket.write(`${settings.greeting}\r\n`);
        attach(socket, seen, settings, { overTls: true });
      })
    : createServer((socket) => {
        socket.write(`${settings.greeting}\r\n`);
        attach(socket, seen, settings);
      });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { port: server.address().port, seen };
}
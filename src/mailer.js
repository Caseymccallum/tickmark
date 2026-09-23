/**
 * Sending mail, by hand, with no dependency.
 *
 * An SMTP client is a few hundred lines against `node:net` and `node:tls`. A library would be the
 * largest supply-chain surface in a project whose whole pitch is that the operator can read what they
 * are running — and this is the code that talks to the outside world on their behalf, so it is the
 * last place to be running something nobody has read.
 *
 * ## What it does, in order
 *
 * Read the greeting, EHLO, STARTTLS and say hello again if the server offers it, authenticate if
 * there are credentials, MAIL FROM, RCPT TO, DATA, the message, QUIT. Every step checks its reply
 * code and fails with a sentence naming the step, because "the reminder was not sent" is useless next
 * to "the server refused the recipient (550 5.1.1 no such user)".
 *
 * ## What it deliberately does not do
 *
 * No queue and no retry. A send either works or it fails, and a failure is reported to the person
 * looking at the screen rather than swallowed into a background job — a notification that fails
 * quietly is worse than no notification at all.
 */
import { connect as connectNet, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_PORT = 587;

/** A failure with a sentence someone can act on. */
export class MailError extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
  }
}

/**
 * `smtp://user:pass@host:587` — STARTTLS if the server offers it.
 * `smtps://user:pass@host:465` — TLS from the first byte.
 *
 * Two URL schemes rather than a flag, because the choice is a property of the server and not a
 * preference: a relay on 465 does not speak plaintext at all, and one on 587 expects to be asked.
 */
export function parseSmtpUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new MailError('configuration', `TICKMARK_SMTP_URL is not a URL: ${value}`);
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new MailError('configuration', `TICKMARK_SMTP_URL must be smtp:// or smtps://, not ${url.protocol}//`);
  }

  const implicitTls = url.protocol === 'smtps:';
  const port = url.port ? Number(url.port) : implicitTls ? 465 : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MailError('configuration', `TICKMARK_SMTP_URL has an impossible port: ${url.port}`);
  }

  return {
    host: url.hostname,
    port,
    implicitTls,
    user: url.username ? decodeURIComponent(url.username) : null,
    pass: url.password ? decodeURIComponent(url.password) : null,
    // Only ever set from a separate, explicit flag. Silently accepting any certificate would make
    // this client a way to hand a password to whoever answered.
    rejectUnauthorized: true,
  };
}

/**
 * The mailer, or null if this installation has not been configured to send.
 *
 * A missing configuration is not an error at startup: drafting reminders works without a mail server,
 * and the pages say what is missing rather than the process refusing to run.
 */
export function mailerFromEnvironment(env = process.env) {
  const url = env.TICKMARK_SMTP_URL;
  const from = env.TICKMARK_MAIL_FROM;
  if (!url && !from) return null;
  if (!url) throw new MailError('configuration', 'TICKMARK_MAIL_FROM is set but TICKMARK_SMTP_URL is not');
  if (!from) throw new MailError('configuration', 'TICKMARK_SMTP_URL is set but TICKMARK_MAIL_FROM is not');

  const config = parseSmtpUrl(url);
  if (env.TICKMARK_SMTP_INSECURE === '1') config.rejectUnauthorized = false;

  // A relay whose certificate comes from a private CA — an internal mail server, a corporate relay, a
  // self-hosted one — needs that CA trusted. Without this the only switch available would be
  // TICKMARK_SMTP_INSECURE, which turns verification off for everything; trusting one named CA is
  // strictly safer than that, which is why this exists. It is read here rather than at connect time so
  // that a path that cannot be read is a startup error naming the file, not a failed send later.
  if (env.TICKMARK_SMTP_CA_FILE) {
    try {
      config.ca = readFileSync(env.TICKMARK_SMTP_CA_FILE, 'utf8');
    } catch (error) {
      throw new MailError(
        'configuration',
        `TICKMARK_SMTP_CA_FILE could not be read (${env.TICKMARK_SMTP_CA_FILE}) — ${error.message}`,
      );
    }
  }

  return {
    ...config,
    from,
    timeoutMs: Number(env.TICKMARK_SMTP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    /** What the pages say when they explain how sending is set up. Never includes the password. */
    describe: () =>
      `${config.host}:${config.port}${config.implicitTls ? ' (TLS)' : ' (STARTTLS when offered)'}` +
      `${config.ca ? ', with your own CA' : ''}`,
  };
}

/** The address part of `Name <address@host>`, for the envelope. */
const addressOf = (value) => {
  const angled = /<([^>]+)>/.exec(String(value));
  return (angled ? angled[1] : String(value)).trim();
};

/**
 * An RFC 2047 encoded-word, if the text is not plain ASCII.
 *
 * A subject line in any language has to survive the trip, and a raw UTF-8 subject needs the 8BITMIME
 * extension to be legal. Encoding it as a base64 word is legal everywhere instead of nearly
 * everywhere.
 */
export function encodeHeader(text) {
  const value = String(text).replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

const base64Body = (text) =>
  (Buffer.from(String(text), 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/**
 * The message, as it goes on the wire.
 *
 * The body is base64 rather than raw UTF-8 for the same reason the subject is encoded: it needs no
 * extension from the server, and every line is then 7-bit — which has the quiet side effect that no
 * line can begin with a dot, so this cannot accidentally end the message early.
 */
export function buildMessage({ from, to, subject, body, messageId }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    // Tells a well-behaved autoresponder not to answer this, which is the difference between a
    // reminder and a mail loop.
    'Auto-Submitted: auto-generated',
    '',
    base64Body(body),
    '',
  ].join('\r\n');
}

/** SMTP's own escaping rule: a line beginning with a dot gets another one. */
export const dotStuff = (text) => String(text).replace(/^\./gm, '..');

/**
 * One conversation with a server: write a line, read a reply.
 *
 * Two details here are the difference between working and mysteriously failing:
 *
 * - **It removes only its own listeners.** `tls.connect({ socket })` takes the socket over, so
 *   clearing every listener to attach a new handler set would tear the TLS machinery out of the
 *   socket it is wrapping. The handlers are kept in a map and removed by name.
 * - **It never calls `setEncoding`.** A decoded stream hands strings to whatever reads it, and TLS
 *   needs bytes. Replies are ASCII by definition — the only text this parser sees is status codes and
 *   server greetings — so decoding each chunk on arrival is safe here and nowhere else.
 */
class SmtpSession {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.lines = [];
    this.waiting = null;
    this.failure = null;
    this.handlers = new Map();
    this.attach(socket);
  }

  attach(socket) {
    if (this.socket) for (const [event, handler] of this.handlers) this.socket.removeListener(event, handler);

    this.socket = socket;
    this.handlers = new Map();
    const on = (event, handler) => {
      socket.on(event, handler);
      this.handlers.set(event, handler);
    };

    on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let at;
      while ((at = this.buffer.indexOf('\r\n')) !== -1) {
        this.lines.push(this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at + 2);
      }
      this.settle();
    });
    on('timeout', () => this.break(new MailError('timeout', `the server was silent for ${this.timeoutMs} ms`)));
    on('error', (error) => this.break(new MailError('connection', error.message)));
    on('close', () => this.break(new MailError('connection', 'the connection closed before the server finished replying')));

    if (typeof socket.setTimeout === 'function') socket.setTimeout(this.timeoutMs);
  }

  send(line) {
    if (this.socket) this.socket.write(`${line}\r\n`);
  }

  readReply() {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, lines: [] };
      this.settle();
    });
  }

  /** A reply ends at a line whose fourth character is a space: `250-x` continues, `250 x` ends. */
  settle() {
    while (this.waiting && this.lines.length > 0) {
      const line = this.lines.shift();
      this.waiting.lines.push(line);
      const end = /^(\d{3}) /.exec(line);
      if (end) {
        const { resolve, lines } = this.waiting;
        this.waiting = null;
        resolve({ code: Number(end[1]), lines });
      }
    }
  }

  break(error) {
    this.failure ??= error;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = null;
      reject(this.failure);
    }
  }

  close() {
    if (!this.socket) return;
    for (const [event, handler] of this.handlers) this.socket.removeListener(event, handler);
    this.handlers.clear();
    this.socket.destroy();
    this.socket = null;
  }
}

async function expect(session, codes, step) {
  const wanted = Array.isArray(codes) ? codes : [codes];
  const reply = await session.readReply();
  if (!wanted.includes(reply.code)) {
    // The reply's own lines already carry its code, so the code is prefixed only when the server
    // somehow did not: a sentence like "550 550 5.1.1 no such user" stutters in a support ticket.
    const said = reply.lines.join(' ').trim();
    throw new MailError(step, said.startsWith(String(reply.code)) ? said : `${reply.code} ${said}`);
  }
  return reply;
}

/**
 * SNI is a hostname, and Node refuses an IP address for it — which a relay addressed as
 * `smtp://192.0.2.10` would hit as a hard failure on the first connection. So it is sent only when the
 * host really is a name.
 */
const servernameFor = (host) => (isIP(host) === 0 ? host : undefined);

function openSocket(config, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = config.implicitTls
      ? connectTls({
          host: config.host,
          port: config.port,
          servername: servernameFor(config.host),
          rejectUnauthorized: config.rejectUnauthorized,
          ca: config.ca,
        })
      : connectNet({ host: config.host, port: config.port });

    const failed = (error) => reject(new MailError('connection', `${config.host}:${config.port} — ${error.message}`));
    socket.once('error', failed);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new MailError('timeout', `could not reach ${config.host}:${config.port} within ${timeoutMs} ms`));
    });

    const ready = () => {
      socket.removeListener('error', failed);
      socket.setTimeout(0);
      resolve(socket);
    };
    if (config.implicitTls) socket.once('secureConnect', ready);
    else socket.once('connect', ready);
  });
}

/** Ask who we are talking to. The name sent is the sender's domain, which is a real FQDN. */
async function sayHello(session, config) {
  session.send(`EHLO ${addressOf(config.from).split('@')[1] ?? 'tickmark.local'}`);
  const reply = await expect(session, 250, 'the server greeting');
  return reply.lines;
}

async function authenticate(session, config, greeting) {
  const advertised = greeting
    .map((line) => /^250[- ]AUTH[ -](.*)$/i.exec(line))
    .find(Boolean)?.[1]
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean) ?? [];

  if (advertised.length === 0) {
    throw new MailError('authentication', 'the server did not offer authentication, but credentials are configured');
  }

  if (advertised.includes('PLAIN')) {
    session.send(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.pass}`, 'utf8').toString('base64')}`);
    await expect(session, 235, 'authentication');
    return;
  }

  if (advertised.includes('LOGIN')) {
    session.send('AUTH LOGIN');
    await expect(session, 334, 'authentication');
    session.send(Buffer.from(config.user, 'utf8').toString('base64'));
    await expect(session, 334, 'authentication');
    session.send(Buffer.from(config.pass, 'utf8').toString('base64'));
    await expect(session, 235, 'authentication');
    return;
  }

  throw new MailError(
    'authentication',
    `the server offers ${advertised.join(', ')} and this client speaks PLAIN and LOGIN`,
  );
}

function upgrade(session, config, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = connectTls({
      socket: session.socket,
      servername: servernameFor(config.host),
      rejectUnauthorized: config.rejectUnauthorized,
      ca: config.ca,
    });
    secure.setTimeout(timeoutMs, () => {
      secure.destroy();
      reject(new MailError('starttls', 'the TLS handshake did not finish in time'));
    });
    secure.once('secureConnect', () => {
      secure.setTimeout(0);
      resolve(secure);
    });
    secure.once('error', (error) => reject(new MailError('starttls', `the TLS handshake failed: ${error.message}`)));
  });
}

/**
 * Send one message. Throws a `MailError` naming the step that failed, or returns the Message-ID.
 *
 * There is no retry and no queue. A reminder that failed is reported to the person looking at the
 * screen, who can send it by hand from the draft still in front of them — which is a worse outcome
 * than a successful send and a much better one than a message that vanished into a queue nobody
 * watches.
 */
export async function sendMail(config, { to, subject, body, from = config.from, timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS }) {
  const recipient = addressOf(to);
  if (!/^[^@\s]+@[^@\s]+$/.test(recipient)) {
    throw new MailError('configuration', `that is not an email address: ${to}`);
  }

  const socket = await openSocket(config, timeoutMs);
  const session = new SmtpSession(socket, timeoutMs);

  try {
    await expect(session, 220, 'the server greeting');

    let greeting = await sayHello(session, config);
    if (!config.implicitTls) {
      if (greeting.some((line) => /STARTTLS/i.test(line))) {
        session.send('STARTTLS');
        await expect(session, 220, 'STARTTLS');
        session.attach(await upgrade(session, config, timeoutMs));
        greeting = await sayHello(session, config);
      } else if (config.user && config.rejectUnauthorized !== false) {
        // No password over an unencrypted connection unless the operator has said, in so many
        // characters, that the relay is theirs. Silence here would leak it to whoever answered the
        // port.
        throw new MailError(
          'starttls',
          'the server does not offer STARTTLS, and refusing to send a password over an unencrypted connection. Set TICKMARK_SMTP_INSECURE=1 if that relay is your own machine.',
        );
      }
    }

    if (config.user) await authenticate(session, config, greeting);

    session.send(`MAIL FROM:<${addressOf(from)}>`);
    await expect(session, 250, 'the sender address');

    session.send(`RCPT TO:<${recipient}>`);
    await expect(session, [250, 251], `the recipient (${recipient})`);

    session.send('DATA');
    await expect(session, 354, 'DATA');

    // The Message-ID carries the sender's domain, which is the machine that accepts responsibility
    // for the message if a bounce comes back.
    const messageId = `<${randomUUID()}@${addressOf(from).split('@')[1] ?? 'tickmark.local'}>`;
    session.send(`${dotStuff(buildMessage({ from, to, subject, body, messageId }))}\r\n.`);
    await expect(session, 250, 'the message body');

    session.send('QUIT');
    // The reply is waited for even though the message has already been accepted at this point. Cutting
    // the connection the instant QUIT is written is how a client truncates its own final write — and a
    // relay logs that as an error, so the practice sees a complaint about a message that was delivered.
    // A failure here is deliberately not raised: the message is sent.
    await expect(session, 221, 'QUIT').catch(() => {});
    return { messageId, recipient };
  } finally {
    session.close();
  }
}
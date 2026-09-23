/**
 * The SMTP conversation, on the record.
 *
 * A claim about a protocol is worth nothing without the dialogue. Three audiences want to read this
 * one: a reviewer deciding whether a hand-built mail client is safe, a developer who wants to see
 * what SMTP over `node:net` and `node:tls` actually looks like on the wire, and anyone writing the
 * story up who needs evidence rather than adjectives.
 *
 *   node tools/smtp-transcript.mjs
 *
 * It runs real `sendMail()` calls against the same protocol double the tests use — whose TLS is
 * real TLS, with the throwaway CA in `test/fixtures/tls` — records each dialogue with the server's
 * replies interleaved and the TLS phase marked, and writes everything to
 * `tmp-transcript/smtp-transcript.md` as well as printing it.
 *
 * What this is not: a test — that is `test/mail.test.js` and `test/mail-tls.test.js`, which assert
 * these dialogues instead of displaying them — and not a real relay. Recording a conversation with
 * an actual provider is a private act involving real credentials: the page at `/admin/test-email`
 * is how that is done, and what it shows back is the relay's own words.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MailError, sendMail } from '../src/mailer.js';
import { startRelay } from '../test/smtp-relay.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, '..', 'test', 'fixtures', 'tls');
const ca = readFileSync(join(FIXTURES, 'ca.pem'), 'utf8');
const forLocalhost = {
  cert: readFileSync(join(FIXTURES, 'cert.pem')),
  key: readFileSync(join(FIXTURES, 'key.pem')),
};

// `startRelay` takes the test runner only to register its cleanup on. Here the cleanups are kept and
// run at the end, so the servers close and the process can exit.
const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };

const lines = [];
const say = (text = '') => {
  lines.push(text);
  console.log(text);
};

const configFor = (port, extra = {}) => ({
  host: '127.0.0.1',
  port,
  implicitTls: false,
  user: null,
  pass: null,
  rejectUnauthorized: true,
  from: 'Tickmark Practice <office@practice.example>',
  timeoutMs: 5000,
  ...extra,
});

/** The dialogue as a wire log, with a marker wherever a STARTTLS handshake changed the channel. */
function printDialogue(seen) {
  let wasTls = seen.dialogue[0]?.tls ?? false;
  if (wasTls) say('  (the whole session, from the first byte, is inside TLS)');
  for (const line of seen.dialogue) {
    if (line.tls && !wasTls) say('  -- TLS handshake: everything below travelled inside the tunnel --');
    wasTls = line.tls;
    say(`  ${line.from === 'client' ? 'C:' : 'S:'} ${line.text}`);
  }
}

/** The message every scenario sends — a real reminder's shape, body and all. */
const message = {
  to: 'accounts@northwind.example',
  subject: 'Still needed for your 2025 return',
  body: 'Hello Northwind,\n\nOne document is still outstanding: the bank statements.\n\nThanks,\n\nTickmark Practice',
};

let recorded = 0;

async function scenario(title, note, run) {
  recorded += 1;
  say('');
  say(`## ${title}`);
  say('');
  for (const line of note) say(`> ${line}`);
  say('');
  await run();
}

say('# SMTP transcripts — recorded from real sends');
say('');
say(`Recorded ${new Date().toISOString()} on Node ${process.version}.`);
say('Every dialogue below is a real `sendMail()` call against `test/smtp-relay.js` — a protocol');
say("double whose TLS is real TLS. Not a mock: these are the bytes as they went on the socket.");

// --- the dialogues, in order of how much they prove -------------------------------------------

await scenario(
  'A plain send: the whole dialogue',
  [
    'An open relay with no authentication — the simplest conversation SMTP has, and the shape',
    'every other one is built on. Three-digit codes everywhere; a code followed by `-` continues,',
    'a code followed by a space ends the reply. The message body travels base64, so it needs no',
    'extension from the server and no line can ever begin with the dot that ends a message early.',
  ],
  async () => {
    const relay = await startRelay(t, { greeting: '220 relay.example ESMTP ready' });
    const started = Date.now();
    const result = await sendMail(configFor(relay.port), message);
    printDialogue(relay.seen);
    say('');
    say(`Accepted in ${Date.now() - started} ms as ${result.messageId}. The message as it went on the wire:`);
    say('');
    say('```');
    say(relay.seen.message.replace(/\r\n/g, '\n'));
    say('```');
  },
);

await scenario(
  'STARTTLS: the login happens inside the tunnel',
  [
    'The relay advertises STARTTLS and presents a certificate the client trusts (the throwaway CA',
    'in test/fixtures/tls). Watch for the marker: the AUTH line below it carried the password, and',
    'nothing before it could have.',
  ],
  async () => {
    const relay = await startRelay(t, {
      greeting: '220 relay.example ESMTP ready',
      ehlo: ['250-relay.example', '250-STARTTLS', '250 AUTH PLAIN'],
      starttls: forLocalhost,
    });
    const started = Date.now();
    const result = await sendMail(
      configFor(relay.port, { user: 'relay-user', pass: 'relay-password', ca }),
      message,
    );
    say(`Accepted in ${Date.now() - started} ms as ${result.messageId}.`);
    say('');
    printDialogue(relay.seen);
  },
);

await scenario(
  'smtps:// — TLS from the first byte',
  [
    'Port 465 style: no plaintext phase exists, so there is no marker to mark. This relay offers',
    'AUTH LOGIN rather than PLAIN, which is the fallback the client speaks for older relays:',
    'username and password as two separate base64 lines.',
  ],
  async () => {
    const relay = await startRelay(t, {
      greeting: '220 relay.example ESMTP ready',
      tls: forLocalhost,
      ehlo: ['250-relay.example', '250 AUTH LOGIN'],
    });
    const started = Date.now();
    const result = await sendMail(
      configFor(relay.port, { implicitTls: true, user: 'relay-user', pass: 'relay-password', ca }),
      message,
    );
    say(`Accepted in ${Date.now() - started} ms as ${result.messageId}.`);
    say('');
    printDialogue(relay.seen);
  },
);

await scenario(
  'The refusal: a password never travels in the clear',
  [
    'Credentials are configured, but this relay advertises no STARTTLS. The client refuses to',
    'authenticate rather than hand a password to whatever answered the port — the dialogue simply',
    'stops. This is the behaviour to be most proud of, so here it is on the record.',
  ],
  async () => {
    const relay = await startRelay(t, { greeting: '220 relay.example ESMTP ready' });
    let error = null;
    try {
      await sendMail(configFor(relay.port, { user: 'relay-user', pass: 'relay-password' }), message);
    } catch (caught) {
      error = caught;
    }
    printDialogue(relay.seen);
    say('');
    say(`Refused: ${error instanceof MailError ? `step "${error.step}" — ${error.message}` : error}`);
    say('');
    say(`No AUTH line exists above. ${relay.seen.conversation.length} ${relay.seen.conversation.length === 1 ? 'line was' : 'lines were'} sent, every one of`);
    say('them free of anything secret.');
  },
);

await scenario(
  'A refusal from the server, reported as a sentence',
  [
    'The relay refuses the recipient, as a dead mailbox does. The error names the step and repeats',
    "the server's own words — the line a support ticket needs, rather than a stack trace.",
  ],
  async () => {
    const relay = await startRelay(t, {
      greeting: '220 relay.example ESMTP ready',
      recipientReply: '550 5.1.1 no such user here',
    });
    let error = null;
    try {
      await sendMail(configFor(relay.port), { ...message, to: 'nobody@northwind.example' });
    } catch (caught) {
      error = caught;
    }
    printDialogue(relay.seen);
    say('');
    say(`Refused: ${error instanceof MailError ? `step "${error.step}" — ${error.message}` : error}`);
  },
);

// --- the epilogue ------------------------------------------------------------------------------

say('');
say('---');
say('');
say(`${recorded} dialogues recorded. What these prove is asserted in test/mail.test.js and`);
say('test/mail-tls.test.js — this tool prints what those tests hold to be true. What no local');
say('double can prove is how any specific real-world relay behaves; that recording is made against');
say('a real provider, privately, through the page at /admin/test-email.');

const out = join(HERE, '..', 'tmp-transcript');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'smtp-transcript.md'), `${lines.join('\n')}\n`);
console.log(`\nwritten to tmp-transcript/smtp-transcript.md`);

for (const cleanup of cleanups) await cleanup();

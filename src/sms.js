/**
 * Sending a text message, by hand, with no dependency.
 *
 * The mirror of `mailer.js`, and a fraction of its size: an SMS gateway is an HTTP POST rather than a
 * conversation, so there is no dialogue to get wrong. `node:http`/`node:https` and a form body are the
 * whole of it, and pulling in an SDK to make one POST would be the largest thing in the tree doing the
 * smallest job.
 *
 * Why a text at all: a client who ignores email answers a text. The message is a line and a link —
 * **never a document** — which is exactly why texting costs nothing of the zero-knowledge promise. The
 * link opens the same encrypted portal the email's does; what travels over this channel is a sentence
 * and an address, and the bytes of any file stay between the client's browser and the practice's key.
 *
 * Two things are shared with the mailer on purpose. **No queue and no retry**: a send either works or
 * it fails in front of the person who pressed the button, because a text that vanished into a retry
 * queue is worse than one reported as not sent. And a **half-configured install refuses at startup**
 * rather than quietly pretending — set one of the two variables and not the other, and the process
 * says which is missing.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const DEFAULT_TIMEOUT_MS = 15000;

/** A failure with a sentence someone can act on. */
export class SmsError extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
  }
}

/**
 * `https://user:pass@gateway.example/2010-04-01/Accounts/abc/Messages.json` — credentials in the URL,
 * exactly as the mail relay does it, so there is one shape to document and one place to look.
 *
 * The endpoint returned has the credentials **taken out of it**, because they belong in an
 * `Authorization` header and never in the request line where they would be logged. A gateway that
 * authenticates another way is reached by a URL with no credentials and, where it wants a bearer
 * token, `TICKMARK_SMS_TOKEN`.
 */
export function parseSmsUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new SmsError('configuration', `TICKMARK_SMS_URL is not a URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SmsError('configuration', `TICKMARK_SMS_URL must be http:// or https://, not ${url.protocol}//`);
  }
  return {
    endpoint: url.origin + url.pathname + url.search,
    user: url.username ? decodeURIComponent(url.username) : null,
    pass: url.password ? decodeURIComponent(url.password) : null,
  };
}

/**
 * The sender, or null if this install has not been configured to text.
 *
 * A missing configuration is not an error at startup — reminders still go by email, and the pages say
 * texting is not set up rather than the process refusing to run. Only a *half* configuration throws.
 */
export function smsFromEnvironment(env = process.env) {
  const url = env.TICKMARK_SMS_URL;
  const from = env.TICKMARK_SMS_FROM;
  if (!url && !from) return null;
  if (!url) throw new SmsError('configuration', 'TICKMARK_SMS_FROM is set but TICKMARK_SMS_URL is not');
  if (!from) throw new SmsError('configuration', 'TICKMARK_SMS_URL is set but TICKMARK_SMS_FROM is not');

  const { endpoint, user, pass } = parseSmsUrl(url);
  return {
    endpoint,
    user,
    pass,
    from: String(from),
    token: env.TICKMARK_SMS_TOKEN || null,
    timeoutMs: Number(env.TICKMARK_SMS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    /** What the pages say when they explain how texting is set up. Never includes a secret. */
    describe: () => `${new URL(endpoint).host}${user || env.TICKMARK_SMS_TOKEN ? ' (signed in)' : ''}`,
  };
}

/** Digits and a leading `+`, which is the only shape a gateway will dial. Nothing else survives. */
export function normalisePhone(value) {
  return String(value ?? '').replace(/[\s()\-.]/g, '');
}

/** Send one text. Throws an `SmsError` naming the step that failed, or returns who it went to. */
export async function sendSms(config, { to, body, from = config.from, timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS }) {
  const recipient = normalisePhone(to);
  if (!/^\+?\d{6,15}$/.test(recipient)) {
    throw new SmsError('configuration', `that is not a phone number: ${to}`);
  }
  const text = String(body ?? '').trim();
  if (!text) throw new SmsError('configuration', 'an empty text says nothing');

  // The same seam the mailer offers: a deployment may take the message itself rather than hand it to a
  // gateway — the hosted layer, or a test that would rather not dial out. Returning `false` says "I have
  // this one": the send is skipped and the caller counts it as handled. Inert in an ordinary install.
  if (config.onOutgoing?.({ to: recipient, body: text, from }) === false) {
    return { to: recipient, suppressed: true, id: null };
  }

  const form = new URLSearchParams({ To: recipient, From: String(from), Body: text }).toString();
  const url = new URL(config.endpoint);
  const secure = url.protocol === 'https:';
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': Buffer.byteLength(form),
  };
  if (config.user) {
    headers.authorization = `Basic ${Buffer.from(`${config.user}:${config.pass ?? ''}`).toString('base64')}`;
  } else if (config.token) {
    headers.authorization = `Bearer ${config.token}`;
  }

  return new Promise((resolve, reject) => {
    const send = secure ? httpsRequest : httpRequest;
    const request = send(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const reply = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ to: recipient, id: idFrom(reply), suppressed: false });
          } else {
            // The gateway's own reply, quoted back: "401 — Authenticate" says which it was, where "the
            // send failed" says nothing at all.
            reject(new SmsError('the gateway', `${response.statusCode} — ${reply.slice(0, 200) || response.statusMessage}`));
          }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      reject(new SmsError('timeout', 'the gateway did not answer in time'));
    });
    request.on('error', (error) => reject(new SmsError('the gateway', error.message)));
    request.write(form);
    request.end();
  });
}

/** The message id a gateway puts in its JSON reply (`sid` or `id`), if it sends one. */
function idFrom(reply) {
  try {
    const parsed = JSON.parse(reply);
    return parsed.sid ?? parsed.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The reminder, as one text.
 *
 * A text is a different medium from the letter beside it: who is asking, how much is missing, and the
 * one link that opens the request — no greeting, no list, no sign-off. Two named documents at most,
 * then "and N more", because the alternative is three messages arriving out of order. Everything the
 * letter says in full, the page at that link says better and in the client's own time.
 */
export function smsReminder({ practiceName, title, missing = [], link }) {
  const who = String(practiceName ?? '').trim();
  const what = String(title ?? '').trim();
  const named = missing.slice(0, 2).join(', ');
  const more = missing.length > 2 ? ` and ${missing.length - 2} more` : '';
  const owed = missing.length > 0 ? `still needed: ${named}${more}` : `a reminder about ${what}`;
  return `${who ? `${who}: ` : ''}${owed} for ${what}. ${link}`.trim();
}
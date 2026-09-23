/**
 * The chase list, and every message it can send.
 *
 * **Not one of `docs/audit.md` §3's four steps** — this is the sixth module to leave `app.js`, and it holds the half
 * of the loop a client never sees: the list of everyone who owes something, the letter that chases them, the record
 * of what went out, and the test message that tells a practice its relay works.
 *
 * Three things are worth knowing before changing anything here.
 *
 * 1. **The list is the authority.** `chaseList` derives who to chase from the same `outstandingOf` the request page
 *    uses, so there is no second definition of "outstanding" to drift; and it sorts by urgency, so a run cut short by
 *    its time budget has written to the clients nearest their deadline.
 * 2. **A run bounds itself in time, not in count.** A fast relay and a slow one deserve different answers, and what
 *    the limit is really about is the response still being writable — see `CHASE_BUDGET_MS`, which is exported because
 *    the bulk ask in `app.js` runs under the same bound.
 * 3. **Nothing is suppressed silently.** A chase held back by the practice's own cadence is named on the page, a send
 *    that failed is recorded as an event and reported, and a run that hit its budget says where it stopped. The
 *    failure this feature exists to prevent is a "sent" that was not.
 */
import { agoWords } from './clock.js';
import { hashToken, newToken } from './crypto.js';
import { now } from './db.js';
import { field, formFields, originOf, readBody } from './http.js';
import { MailError, mailHtml, sendMail } from './mailer.js';
import { messageFor } from './notices.js';
import {
  history,
  issueToken,
  logContact,
  markArrivalsChecked,
  outstandingForPractice,
  outstandingOf,
  practiceFor,
  recordEvent,
  requestsFor,
  setCadence,
} from './store.js';
import { TONES, badge, empty, fail, html, page, raw, redirect, requireSignIn, section, sendPage } from './views.js';

/**
 * How long a link in a bulk reminder works for.
 *
 * The single-request page offers a choice and defaults to thirty days. A run writing to a whole client list has no
 * form to ask on, so it uses that same default rather than inventing a second one.
 */
const REMINDER_DAYS = 30;

/**
 * The most days a practice may set as its chase cadence.
 *
 * A year, because a cadence longer than a season is a cadence that silences the button for good — which is not what the
 * setting is for. Zero is allowed and means "no limit", which is the other honest answer.
 */
const MAX_CADENCE_DAYS = 365;

/**
 * How long a run of reminders may take before it stops and reports where it got to.
 *
 * Node's own `requestTimeout` is five minutes by default, and a run that reached it would be cut off mid-sentence —
 * with some clients written to and no record of how far it got, which is the one state this feature must not have. So
 * the run bounds itself, well inside that limit, leaving room for the response to be written.
 *
 * A count would be the wrong bound. A fast relay and a slow one deserve different answers, and time is what the limit
 * is actually about: the same run should write to forty clients in seconds or in four minutes if the relay is
 * crawling.
 */
export const CHASE_BUDGET_MS = 120000;

/**
 * Everyone who owes something, in one place, in the order that matters.
 *
 * The research on this is blunt: manual tracking breaks down past fifty clients, and chasing is where a
 * practice's week goes. A board that says who to chase but makes you chase them one at a time has
 * diagnosed the problem without solving it — so this is the list the button acts on, and it is built
 * from the same `outstandingOf` the request page uses rather than from a second definition of
 * "outstanding".
 *
 * The order is urgency first: overdue and soonest-due clients, then whoever owes the most, then
 * alphabetical so the answer is stable. If a run is cut short by the time budget, the clients it
 * reached are the ones nearest their deadline.
 */
function chaseList(db, practiceId) {
  // Every document still wanted, and every client's last contact, in two queries rather than two per request. The
  // three N+1s this replaces were the reason the chase page cost more than the board despite showing less.
  const wanted = outstandingForPractice(db, practiceId);
  const contacted = new Map();
  for (const row of db
    .prepare(
      `SELECT e.request_id AS request_id, MAX(e.at) AS at
         FROM event e JOIN request r ON r.id = e.request_id
        WHERE r.practice_id = ? AND e.kind IN ('reminder.sent', 'request.contacted')
        GROUP BY e.request_id`,
    )
    .all(practiceId)) {
    contacted.set(row.request_id, row.at);
  }

  return requestsFor(db, practiceId)
    .map((row) => ({
      ...row,
      outstanding: wanted.get(row.id) ?? [],
      lastContactAt: contacted.get(row.id) ?? null,
    }))
    .filter((row) => row.outstanding.length > 0)
    .sort((a, b) => {
      if (a.due_at !== b.due_at) return (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');
      if (a.outstanding.length !== b.outstanding.length) return b.outstanding.length - a.outstanding.length;
      return a.client_name.localeCompare(b.client_name);
    });
}

/**
 * Check off everything that has arrived, in one action, and say how many.
 *
 * The count in the redirect is what makes this honest: the page the practice lands on says "3 documents checked"
 * rather than leaving them to work out whether the press did anything.
 */
export function checkAllArrivalsPage({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const checked = markArrivalsChecked(db, practiceId, params[0]);
  if (checked === 0) {
    return fail(
      response,
      404,
      'There was nothing to check: either that request does not exist, or nothing on it has arrived that nobody has looked at yet.',
      practitioner,
    );
  }
  return redirect(response, `/requests/${params[0]}?checked=${checked}`);
}

/**
 * Record a contact that was not an email from here.
 *
 * Nothing is sent — this is the practice writing down something they already did, and the client is not told. The
 * only sign of it is in the record and in the cadence, which is exactly the point: the tool stops offering to
 * chase somebody the practice spoke to this morning.
 */
export async function logContactPage({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const note = (field(fields, 'note') ?? '').trim();

  if (note.length === 0) {
    return fail(
      response,
      400,
      'Say what happened in a few words — "phoned, sending the rest Friday". The note is the record; a row with nothing in it is a row somebody has to interpret later.',
      practitioner,
    );
  }
  if (note.length > 200) {
    return fail(response, 400, 'That note is longer than 200 characters. Keep it to what you would write on the file.', practitioner);
  }
  if (!logContact(db, practiceId, params[0], { note })) {
    return fail(response, 404, 'There is no request at that address.', practitioner);
  }

  return redirect(response, `/requests/${params[0]}?contacted=1`);
}

/**
 * Whether the practice's own cadence holds a reminder back.
 *
 * The rule is one line and it lives in one place, because the page and the run must agree about it: a page that
 * says "this sends 4" over a run that sends 2 would be the same class of lie as a banner that overstates itself
 * anywhere else.
 *
 * It reads **any** contact rather than only the emails this tool sent, which is the change 2v made: the setting is
 * about how often a client hears from the practice, and a phone call is hearing from the practice.
 */
function heldBackBy(line, cadenceDays, nowIso = now()) {
  if (cadenceDays <= 0 || !line.lastContactAt) return false;
  const days = (Date.parse(nowIso) - Date.parse(line.lastContactAt)) / 86400000;
  return days < cadenceDays;
}

/**
 * The chase list, split by what the button would do to each row.
 *
 * One function read by the pre-flight page and by the run, so the two cannot disagree — and the split is
 * ordered by which reason is more fundamental: **no address beats the cadence**, because a client with no
 * address could not be written to whatever the cadence says, and reporting them as "held by your cadence"
 * would name the wrong problem.
 */
function chaseSplits(db, practiceId) {
  const practice = practiceFor(db, practiceId);
  const cadenceDays = practice?.cadenceDays ?? 0;
  const rows = chaseList(db, practiceId);

  const withoutAddress = rows.filter((row) => !row.client_email);
  const addressed = rows.filter((row) => row.client_email);
  const held = addressed.filter((row) => heldBackBy(row, cadenceDays));
  const sendable = addressed.filter((row) => !heldBackBy(row, cadenceDays));

  return { rows, sendable, held, withoutAddress, cadenceDays };
}

/**
 * The list before the button: exactly who will be written to, and who will not.
 *
 * This page exists because the action has no undo. A practice is about to send real email to real
 * clients under their own name, so they get to see the list, the addresses, and how many documents each
 * one is being chased for — before anything leaves the server. "Are you sure?" on its own would be a
 * worse page: it asks for confidence without giving information.
 */
export function chasePage({ db, response, practitioner, practiceId, mailer, url }) {
  if (!requireSignIn({ practitioner, response })) return;

  const { rows, sendable, held, withoutAddress, cadenceDays } = chaseSplits(db, practiceId);
  const saved = url.searchParams.get('saved');
  const justSaved = saved && /^\d+$/.test(saved) ? saved : null;

  const table = rows.length === 0
    ? empty(
        'Nothing is outstanding for anyone.',
        html`<a href="/requests">The board</a> has the full picture.`,
      )
    : html`<div class="scroll"><table class="chase">
        <colgroup>
          <col class="w17"><col class="w24"><col class="w29">
          <col class="w18"><col class="w12">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Client</th>
            <th align="left">Request</th>
            <th align="left">Outstanding</th>
            <th align="left">To send to</th>
            <th align="left">Last</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td><span class="cell-t">${row.client_name}</span></td>
            <td><a class="cell-t" href="/requests/${row.id}">${row.title}</a></td>
            <td>${row.outstanding.map((item) => item.label).join(', ')}
              ${row.outstanding.some((item) => item.clientSays)
                ? html`<span class="cell-s">the client has already answered about some of these — the message
                    repeats that back rather than asking again</span>`
                : ''}</td>
            <td>${row.client_email ?? html`<span class="badge bad">no email address on this client</span>`}</td>
            <td>${row.lastContactAt
              ? html`<span class="cell-s">in touch ${agoWords(row.lastContactAt, now())}</span>`
              : html`<span class="cell-s muted">never in touch</span>`}
              ${held.includes(row) ? html`${badge('held back — inside your cadence', TONES.waiting)}` : ''}</td>
          </tr>`)}
        </tbody>
      </table></div>`;

  return sendPage(response, 200, page({
    title: 'Chase everyone',
    practitioner,
    here: '/chase',
    banner: !mailer
      ? html`<p class="warning">Tickmark has no mail server configured, so nothing can be sent. Set
          <code>TICKMARK_SMTP_URL</code> and <code>TICKMARK_MAIL_FROM</code> and restart it — or open a
          request and copy its reminder by hand.</p>`
      : sendable.length === 0
        ? html`<p class="note">Nothing would be sent at the moment${held.length > 0
            ? html`, because every client who owes something was in touch inside your
                ${cadenceDays}-day cadence`
            : ''}. <a href="/requests">The board</a> shows what is outstanding.</p>`
        : html`<p class="warning">This sends <strong>${sendable.length}</strong>
            ${sendable.length === 1 ? 'message' : 'messages'} from
            <strong>${mailer.describe()}</strong>. It cannot be undone or recalled, and each client gets
            their own link.${held.length > 0
              ? html` ${held.length} ${held.length === 1 ? 'client is' : 'clients are'} held back by your
                  cadence.`
              : ''}${withoutAddress.length > 0
              ? html` ${withoutAddress.length} ${withoutAddress.length === 1 ? 'client is' : 'clients are'}
                  left out for want of an email address.`
              : ''}</p>`,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Chase everyone who owes you something</h1>
          <p class="sub">${rows.length} ${rows.length === 1 ? 'request has' : 'requests have'} something
          outstanding. Each one is sent the ordinary reminder for its own list, with its own link.</p>
        </div>
      </div>
      ${table}
      ${rows.length === 0
        ? ''
        : html`<div class="actions">
            <form method="post" action="/chase">
              ${mailer && sendable.length > 0
                ? html`<button type="submit" class="primary">Send ${sendable.length}
                    ${sendable.length === 1 ? 'reminder' : 'reminders'}</button>`
                : html`<button type="submit" disabled>Send${mailer ? '' : ' (no mail server)'}</button>`}
            </form>
          </div>`}

      <section class="card">
        <h2>How often to chase</h2>
        <form method="post" action="/chase/cadence" class="inline">
          <label>Do not write to the same client more often than every
            <input name="days" type="number" min="0" max="${MAX_CADENCE_DAYS}" value="${cadenceDays}"
              aria-label="Cadence in days" required> days</label>
          <button type="submit">Save</button>
        </form>
        ${justSaved
          ? html`<p class="success">Your cadence is now ${justSaved}
              ${justSaved === '0' ? 'days — no limit' : `day${justSaved === '1' ? '' : 's'}`}.</p>`
          : ''}
        <p class="note"><strong>0 means no limit, and that is where this starts.</strong> How often it is
        acceptable to chase a client is your judgement about your clients, not a number this should pick for
        you — which is why there is no default. Any number of days holds a repeat back: even 1 day stops the
        same client being contacted twice in one afternoon, which is the accident worth preventing.
        <strong>It counts every kind of contact</strong>, including a call you record by hand, because the
        question is how often a client hears from you rather than how many emails the tool sent.
        <strong>It applies to this page only.</strong> Opening one request and sending that reminder by hand
        is never held back, because there you are looking at that client.</p>

        <p class="note">The run stops after ${Math.round(CHASE_BUDGET_MS / 60000)} minutes and reports where
        it got to, so that a slow relay cannot leave half the messages sent with no record of which.
        ${cadenceDays > 0
          ? html`Clients inside your cadence are named in the report rather than dropped quietly.`
          : html`<strong>With no cadence set, it has no memory of who it has already written to:</strong>
              pressing the button twice reminds everyone still outstanding twice — which is why the last
              column above is there, why each request keeps its own history, and why the setting above
              exists.`}</p>
      </section>
      <p class="note"><a href="/requests">Back to the board</a></p>`,
  }));
}

/**
 * Save the practice's chase cadence.
 *
 * A whole number of days, 0 for no limit, and nothing clever about it. The value is validated here rather
 * than in the store because this is where the sentence explaining a refusal can go — and a refusal is what
 * a practice gets for `-1`, for `3.5`, for `"soon"`, or for a number so large the setting would silence
 * the button for a season, which is not what the setting is for.
 */
export async function setCadencePage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const raw = (field(fields, 'days') ?? '').trim();
  const days = Number(raw);

  if (!/^\d+$/.test(raw) || !Number.isInteger(days) || days < 0 || days > MAX_CADENCE_DAYS) {
    return fail(
      response,
      400,
      `A cadence has to be a whole number of days between 0 and ${MAX_CADENCE_DAYS}. 0 means no limit, which is where this starts.`,
      practitioner,
    );
  }

  setCadence(db, practiceId, days);
  return redirect(response, `/chase?saved=${days}`);
}

/**
 * Send the ordinary reminder to everyone who owes something.
 *
 * Four rules, each of them a failure this feature would otherwise have:
 *
 * 1. **A failure never stops the run and is never hidden.** One client with a dead mailbox must not stop
 *    the other thirty being written to, and the report says which failed and what the server said.
 * 2. **The run bounds itself in time** — see `CHASE_BUDGET_MS` — and says where it stopped.
 * 3. **Every send is recorded per request**, in the same events the single-send path writes, so a
 *    client's history says what was sent to them and when, whichever way it was sent.
 * 4. **The practice's own cadence is respected, and the clients it holds back are named.** A run that
 *    quietly skipped people would be indistinguishable from a run that wrote to them, which is the one
 *    thing a report must never be. The split comes from `chaseSplits`, the same function the page reads,
 *    so the pre-flight count and the run cannot disagree.
 */
export async function sendAllReminders({ db, request, response, practitioner, practiceId, mailer, chaseBudgetMs = CHASE_BUDGET_MS }) {
  if (!requireSignIn({ practitioner, response })) return;
  if (!mailer) {
    return fail(response, 400, 'This installation has no mail server configured, so nothing can be sent.', practitioner);
  }

  const origin = originOf(request);
  const { sendable, held, withoutAddress, cadenceDays } = chaseSplits(db, practiceId);

  const results = [];
  const startedAt = Date.now();

  for (const [index, row] of sendable.entries()) {
    if (Date.now() - startedAt > chaseBudgetMs) {
      for (const rest of sendable.slice(index)) results.push({ row: rest, outcome: 'not-attempted' });
      break;
    }
    results.push(await sendOneReminder(db, row, origin, mailer, practiceFor(db, practiceId).name));
  }

  return sendPage(
    response,
    200,
    chaseReportPage({
      practitioner,
      results,
      skipped: withoutAddress,
      held,
      cadenceDays,
      elapsedMs: Date.now() - startedAt,
    }),
  );
}

/** One request's reminder, sent. Its own function so that the loop above reads as a loop. */
async function sendOneReminder(db, row, origin, mailer, practiceName = null) {
  const token = newToken();
  issueToken(db, {
    requestId: row.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + REMINDER_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });

  const message = messageFor({ db, found: row, origin, token, practiceName });
  const hasLink = /\/r\/[A-Za-z0-9_-]{20,}/.test(message.body);

  try {
    const { messageId } = await sendMail(mailer, {
      to: row.client_email,
      subject: message.subject,
      body: message.body,
      html: mailHtml(message.body, practiceName),
    });
    recordEvent(db, {
      requestId: row.id,
      kind: 'reminder.sent',
      detail: `to ${row.client_email} (${messageId})${hasLink ? '' : ' — with no link in it'}`,
    });
    return { row, outcome: 'sent', to: row.client_email, messageId, hasLink };
  } catch (error) {
    recordEvent(db, {
      requestId: row.id,
      kind: 'reminder.failed',
      detail: `to ${row.client_email} — ${error.message}`,
    });
    return { row, outcome: 'failed', to: row.client_email, reason: error.message };
  }
}

/**
 * The mail setup's test bench (see docs/mail.md).
 *
 * Setting a relay up is the one piece of onboarding that involves someone else's machine, and the
 * failure modes — the password, the port, the firewall, the certificate — are exactly the things a
 * non-technical operator cannot tell apart. So the page sends one real message the way a reminder is
 * sent, and on a failure shows the relay's own reply next to one sentence that names which of those
 * four it was. It changes nothing: no reminder is marked sent, no link is issued, nothing is recorded.
 */
function testEmailPage({ practitioner, mailer, error = null, sent = null, to = '' }) {
  return page({
    title: 'Test email',
    practitioner,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Test the mail setup</h1>
          <p class="sub">One real message through the same code a reminder uses, so a success here is a
          relay a reminder will work with.</p>
        </div>
      </div>
      ${mailer
        ? html`<p class="info">Sending from <strong>${mailer.describe()}</strong>, as
              <strong>${mailer.from}</strong>.</p>`
        : html`<p class="warning"><strong>Sending is not configured.</strong> Set
              <code>TICKMARK_SMTP_URL</code> and <code>TICKMARK_MAIL_FROM</code> (see
              <code>docs/mail.md</code>) and restart. Until then Tickmark drafts reminders and does
              not send them.</p>`}
      ${error
        ? html`<p class="error"><strong>Not sent.</strong> ${error.message}</p>
            ${MAIL_STEP_ADVICE.find(([step]) => error.step.startsWith(step))?.[1]
              ? html`<p class="note">${MAIL_STEP_ADVICE.find(([step]) => error.step.startsWith(step))[1]}</p>`
              : ''}`
        : ''}
      ${sent
        ? html`<p class="success"><strong>Sent.</strong> The relay accepted the message for
              <strong>${sent.recipient}</strong> (<code>${sent.messageId}</code>). Acceptance is not
              delivery — check that it arrived, and that it did not land in spam.</p>`
        : ''}
      ${mailer
        ? html`<form method="post" action="/admin/test-email" class="card narrow">
              <div class="field">
                <label for="email">Send a test message to</label>
                <input id="email" name="email" type="email" required value="${to}">
              </div>
              <button type="submit">Send the test message</button>
            </form>
            <p class="note">A plain-text message, sent through the same code a reminder uses — so a
            success here is a relay a reminder will work with. A failure names the step that failed and
            the relay's own reply, which is what says whether it is the address, the password, the port
            or the firewall.</p>`
        : ''}`,
  });
}

/**
 * One sentence per way the conversation can fail, matched by the step `sendMail` names.
 *
 * The SMTP reply itself is always shown too — `550 5.1.1 no such user` is quotable to a mail provider
 * — because a canned sentence is a starting point and the server's words are the evidence.
 */
const MAIL_STEP_ADVICE = [
  ['connection', 'The relay could not be reached. Check the host and the port, and whether a firewall is in the way — this is where a wrong port or a blocked one shows up.'],
  ['timeout', 'The relay did not answer in time. Usually a wrong port, or a firewall that drops the connection rather than refusing it.'],
  ['starttls', 'The encrypted connection failed. Usually a certificate this machine does not trust (see TICKMARK_SMTP_CA_FILE in docs/mail.md), or a TLS-only relay spoken to on the wrong port.'],
  ['authentication', 'The relay refused the credentials — the username or the password is wrong, or the relay does not accept them.'],
  ['configuration', 'The settings themselves are wrong — TICKMARK_SMTP_URL or TICKMARK_MAIL_FROM (see docs/mail.md), or the recipient address.'],
  ['the server greeting', 'The relay answered, but not as an SMTP server. Check the host and port — this is what a web server or a firewall page looks like when an SMTP client dials it.'],
];

export function testEmailForm({ response, practitioner, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;
  return sendPage(response, 200, testEmailPage({ practitioner, mailer }));
}

export async function testEmailSend({ request, response, practitioner, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const to = field(fields, 'email') ?? '';

  if (!mailer) {
    return sendPage(response, 400, testEmailPage({ practitioner, mailer, to }));
  }

  try {
    const sent = await sendMail(mailer, {
      to,
      subject: 'Tickmark test message',
      body: [
        'This is a test message from Tickmark, sent from the mail setup page.',
        '',
        `Relay: ${mailer.describe()}`,
        '',
        'If you are reading this, the relay accepted the message. Check that it arrived in the mailbox — acceptance is not delivery.',
      ].join('\n'),
    });
    return sendPage(response, 200, testEmailPage({ practitioner, mailer, to, sent }));
  } catch (error) {
    // Anything that is not a MailError is a bug in this process, not in the relay — that one is
    // worth a stack trace in the log rather than a sentence in the browser.
    if (!(error instanceof MailError)) throw error;
    return sendPage(response, 400, testEmailPage({ practitioner, mailer, to, error }));
  }
}

/**
 * What happened, per client.
 *
 * This page is the whole reason the run is safe to press. It names every outcome — sent, failed, not
 * attempted, and who was never a candidate — with the server's own words for a failure. A bulk action
 * whose result is "done" teaches a practice to distrust it, and the first time a message quietly did not
 * arrive they would go back to sending them by hand.
 */
function chaseReportPage({ practitioner, results, skipped, held = [], cadenceDays = 0, elapsedMs }) {
  const sent = results.filter((entry) => entry.outcome === 'sent');
  const failed = results.filter((entry) => entry.outcome === 'failed');
  const later = results.filter((entry) => entry.outcome === 'not-attempted');
  const seconds = Math.round(elapsedMs / 1000);

  const outcomeOf = (entry) => (entry.outcome === 'sent'
    ? html`<strong>sent</strong> <span class="note">${entry.messageId}${entry.hasLink ? '' : ' — with no link in it'}</span>`
    : entry.outcome === 'failed'
      ? html`<strong class="error">not sent</strong> <span class="note">${entry.reason}</span>`
      : html`<span class="note">not attempted — the run was out of time</span>`);

  return page({
    title: 'What happened',
    practitioner,
    body: html`
      <h1>What happened</h1>
      <p>${sent.length} sent, ${failed.length} failed, ${later.length} not attempted${held.length > 0
        ? html`, ${held.length} held back by your cadence`
        : ''}${skipped.length > 0
        ? html`, ${skipped.length} with no email address`
        : ''} — in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.</p>
      ${failed.length > 0
        ? html`<p class="error"><strong>${failed.length}
            ${failed.length === 1 ? 'message was' : 'messages were'} not sent.</strong> Nothing was lost:
            each one is still on <a href="/chase">the chase list</a>, so pressing the button again will
            try it again${cadenceDays > 0
              ? html` — but only once your ${cadenceDays}-day cadence lets it, so a failure inside the
                  cadence is a reason to open that request and send it by hand`
              : html` — along with everyone else still outstanding, because no cadence is set and the run
                  keeps no record of who it has already reminded`}.</p>`
        : ''}
      ${held.length > 0
        ? html`<p class="note"><strong>${held.length} ${held.length === 1 ? 'client was' : 'clients were'}
            not written to</strong>, because you asked not to be in touch with the same client more often than
            every ${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'} and they were contacted more recently
            than that — by an email from here, or by something you recorded yourself. Nothing is wrong: they
            are still on <a href="/chase">the chase list</a>, and the setting is on that page if you want to
            change it.</p>`
        : ''}
      ${later.length > 0
        ? html`<p class="warning"><strong>The run stopped before it finished.</strong> It reached its time
            budget, which is deliberate — a run cut off by the server halfway through would leave no record
            of who had already been written to. The ${later.length} below are untouched and still on
            <a href="/chase">the chase list</a>.</p>`
        : ''}
      ${results.length + skipped.length + held.length === 0
        ? empty('There was nothing to send.', 'Nobody owed anything that this run could write to.')
        : html`<div class="scroll"><table>
            <colgroup><col class="w22"><col class="w34"><col class="w44"></colgroup>
            <thead>
              <tr><th align="left">Client</th><th align="left">Request</th><th align="left">Outcome</th></tr>
            </thead>
            <tbody>
              ${results.map((entry) => html`<tr>
                <td><span class="cell-t">${entry.row.client_name}</span></td>
                <td><a href="/requests/${entry.row.id}">${entry.row.title}</a></td>
                <td>${outcomeOf(entry)}</td>
              </tr>`)}
              ${held.map((row) => html`<tr>
                <td><span class="cell-t">${row.client_name}</span></td>
                <td><a href="/requests/${row.id}">${row.title}</a></td>
                <td>${badge(`held back by your cadence — in touch ${agoWords(row.lastContactAt, now())}`, TONES.waiting)}</td>
              </tr>`)}
              ${skipped.map((row) => html`<tr>
                <td><span class="cell-t">${row.client_name}</span></td>
                <td><a href="/requests/${row.id}">${row.title}</a></td>
                <td>${badge('no email address on this client', TONES.wrong)}</td>
              </tr>`)}
            </tbody>
          </table></div>`}
      <p class="note"><a href="/requests">Back to the board</a> &middot; <a href="/chase">the chase list</a></p>`,
  });
}


/**
 * One request's own actions: its link, its letters, and the documents on it.
 *
 * The last big section to leave `app.js`, and the part of the product a practice touches most: opening what a client
 * sent, issuing a link, drafting and sending the reminder or the opening ask, closing a request and opening it again,
 * and adding or editing the documents on it.
 *
 * Three things here are load-bearing, and all three are the kind a reader should meet in a comment rather than in a
 * bug report.
 *
 * 1. **A link is issued, never recovered.** Only the token's digest is stored, so a practice that has lost the original
 *    cannot be shown it again — `issueLink` and `draftReminder` make a fresh one and say so on the screen. That is the
 *    visible cost of the design decision in `docs/encryption.md`, and it belongs where a person can read it.
 * 2. **A letter is drafted, not sent by a robot.** `draftOpening` and `draftReminder` render a textarea the practice
 *    edits; `sendOpening` and `sendReminder` are the separate, deliberate acts of sending one. The wording itself lives
 *    in `src/notices.js`, and `src/chase-views.js` reuses both for a run to fifty clients.
 * 3. **What a client sent is served as an envelope.** `serveEnvelope` streams ciphertext to the browser, which is the
 *    only place it can be opened — so this route has nothing to redact and no content type to guess.
 */
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { hashToken, newToken } from './crypto.js';
import { now } from './db.js';
import { field, formFields, originOf, parseItems, readBody } from './http.js';
import { MailError, mailHtml, sendMail } from './mailer.js';
import { messageFor, openingDraft } from './notices.js';
import { holdsKey, refusalFor } from './roles.js';
import {
  addItems,
  clearItemAttention,
  clientFor,
  clientSummaries,
  closeRequest,
  findOrCreateClient,
  history,
  issueToken,
  itemsOf,
  outstandingOf,
  practiceFor,
  recordEvent,
  reopenRequest,
  requestFor,
  revokeToken,
  setItemAttention,
  setItemLabel,
  setItemReviewed,
  setItemWithdrawn,
  updateClient,
  updateRequest,
} from './store.js';
import { SECURITY_HEADERS, empty, fail, html, page, redirect, requireSignIn, sendPage } from './views.js';

/**
 * Serve one stored envelope to the practice that owns it.
 *
 * What goes over the wire is ciphertext, so this is not a document being handed out — it is a
 * blob the practice's browser is about to decrypt. That distinction is why this route can be
 * simple: there is nothing here to redact, and no content type to guess.
 *
 * Authorization is the scoping of the query, as everywhere else: an upload belonging to another
 * practice is not found, and a request belonging to another practice cannot be reached to begin
 * with.
 */
export async function serveEnvelope({ db, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const row = db
    .prepare('SELECT * FROM upload WHERE id = ? AND request_id = ?')
    .get(params[1], found.id);
  if (!row) return fail(response, 404, 'There is no file with that id in this request.', practitioner);

  let size;
  try {
    size = (await stat(row.storage_path)).size;
  } catch {
    // The row exists and the file does not: the disk has been changed underneath the record, which
    // is worth saying plainly rather than reporting as a missing upload.
    return fail(response, 500, 'The record of that file is here but the file itself is not. Check the blob directory.', practitioner);
  }

  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/octet-stream',
    'content-length': size,
    // The original filename, so the browser can offer it once the bytes are decrypted. It travels
    // in a header rather than in the path because it is a label the client chose.
    'x-file-name': encodeURIComponent(row.filename),
    'cache-control': 'no-store',
  });
  // Streamed rather than read into memory: one document is bounded by the upload ceiling, and a
  // practice working down a list of twenty saves should not cost the server a file's worth of heap
  // each time. The rows below record the look once the bytes are on their way.
  createReadStream(row.storage_path).pipe(response);

  // **Recorded after the bytes are on their way, never before.** Opening a document is the one thing this
  // product lets somebody do that is worth an audit trail — a firm promising confidentiality should be able to
  // answer "who has seen this client's bank statements?" — and the answer has to survive the file being read.
  // Writing it first would mean a failed read left a record of a look that never happened, which is worse than
  // no record at all.
  //
  // The person travels in `detail`, the way `notice.sent` does, because the event table records what happened to
  // a *request* rather than who did it: the schema has no column for the actor, and adding one would be a
  // migration for a fact that three callers need to say in a sentence.
  recordEvent(db, {
    requestId: found.id,
    kind: 'file.opened',
    detail: `${practitioner.email} — ${row.filename}`,
  });
}

export async function issueLink({ db, request, response, practitioner, params, practiceId, onLinkIssued }) {
  if (!requireSignIn({ practitioner, response })) return;

  // Ownership first, key second. A request belonging to somebody else must be *not found*
  // whatever state this practice is in — a refusal that depends on my own setup would leak
  // whether the request exists.
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  // No key, no link. This is where the encryption requirement bites, and it bites before a
  // client is involved rather than after: a link that cannot receive an encrypted file is a
  // promise the product cannot keep.
  if (!practitioner.hasKey) return redirect(response, '/setup');

  const fields = formFields(await readBody(request));
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);

  const token = newToken();
  issueToken(db, {
    requestId: found.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  });

  // Optional, injected, and a no-op single-tenant: where else would a link live but in the file
  // that issued it? In SaaS mode the entry passes the registry's recorder, so a client's link can
  // find its practice without a host header. The core route never learns why.
  onLinkIssued?.({ practiceId, token, requestId: found.id });

  return sendPage(response, 200, page({
    title: found.title,
    practitioner,
    banner: html`<p class="warning"><strong>This is the link — copy it now. It will not be shown
      again.</strong> Only a digest of it is stored, so nobody can recover it later, including
      whoever runs this server.<br>
      <code>${originOf(request)}/r/${token}</code></p>`,
    body: html`<h1>${found.title}</h1>
      <p>Send that link to ${found.client_name}. It stops working after ${days} days, and
      you can revoke it from the <a href="/requests/${found.id}">request page</a>.</p>`,
  }));
}

export async function revokeLink({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const tokenId = field(fields, 'token_id');
  const revoked = tokenId ? revokeToken(db, practiceId, tokenId) : false;
  if (!revoked) {
    return fail(response, 400, 'That link is not one of yours, or it was already revoked.', practitioner);
  }
  return redirect(response, `/requests/${found.id}`);
}

/**
 * A block of text the practice is meant to copy.
 *
 * `data-select-on-click` selecting the contents is the whole interaction: a practice with a mouse clicks once
 * and types Ctrl-C, which is one more step than a copy button and one fewer than a broken
 * clipboard API in a page served over plain HTTP. The behaviour is one nonced script in `src/views.js`,
 * because a strict CSP refuses inline `on…=` handlers — a nonce can bless a script, never an attribute.
 */
const copyableField = (name, text, rows) => html`
  <label for="${name}">${name}</label>
  <textarea id="${name}" rows="${rows}" readonly data-select-on-click>${text}</textarea>`;

/**
 * Draft the reminder, and make the link it needs.
 *
 * A reminder without a link is much weaker — the client has to find the original email — and the
 * link cannot be recovered from the server, by design: only its digest is stored. So asking for a
 * reminder makes a fresh one, and says so. That is the visible cost of that design decision, and
 * it belongs on the screen rather than in a footnote.
 */
export async function draftReminder({ db, request, response, practitioner, params, mailer, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (!practitioner.hasKey) return redirect(response, '/setup');

  const outstanding = outstandingOf(db, found.id);
  if (outstanding.length === 0) return redirect(response, `/requests/${found.id}`);

  const fields = formFields(await readBody(request));
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);

  const token = newToken();
  issueToken(db, {
    requestId: found.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  });
  recordEvent(db, {
    requestId: found.id,
    kind: 'reminder.drafted',
    detail: `${outstanding.length} still outstanding`,
  });

  const message = messageFor({
    db,
    found,
    origin: originOf(request),
    token,
    practiceName: practiceFor(db, practiceId).name,
  });

  return sendPage(response, 200, reminderPage({
    mailer,
    practitioner,
    found,
    draft: { subject: message.subject, body: message.body },
    days,
    outstanding: message.outstanding.length,
    total: message.total,
  }));
}

/**
 * Change a request after it exists.
 *
 * The gap this closes is not a missing feature so much as a missing operation: a title could be set once and
 * never corrected, and a due date could be set once and never moved. Both happen constantly — deadlines are
 * the most changeable fact in an accountant's week — and the only fix was to close the request and start
 * again, which throws away the link the client already has and the record of what they already sent.
 *
 * The client can be corrected here too. "This was filed against the wrong client" is a correction like any
 * other, and it carries the same rule as everywhere else: a name that matches an existing client moves the
 * request to *them* rather than creating a second record.
 */
export function editRequestForm({ db, response, practitioner, params, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const clients = clientSummaries(db, practiceId).map((row) => ({ name: row.name, email: row.email }));
  const saved = url.searchParams.get('saved');

  return sendPage(response, 200, page({
    title: `Edit ${found.title}`,
    practitioner,
    here: '/requests',
    banner: saved
      ? html`<p class="success"><strong>Saved.</strong> ${saved === 'nothing' ? 'Nothing had changed.' : saved}</p>`
      : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a> · <a href="/requests/${found.id}">${found.title}</a></p>
          <h1>Edit this request</h1>
          <p class="sub">The client's link does not change, and neither does anything they have already sent.</p>
        </div>
      </div>
      <form method="post" action="/requests/${found.id}/edit" class="card narrow">
        <input type="hidden" name="client_id" value="${found.client_id}">
        <div class="field">
          <label for="client">Client</label>
          <input id="client" name="client" required value="${found.client_name}" list="client-names"
            autocomplete="off">
          ${clients.length > 0
            ? html`<datalist id="client-names">
                ${clients.map((client) => html`<option value="${client.name}">${client.email ?? ''}</option>`)}
              </datalist>
              <p class="form-hint">Choosing another of the practice's clients moves the request to them —
              nothing is copied, and nothing is left behind.</p>`
            : ''}
        </div>
        <div class="field">
          <label for="title">What is this for?</label>
          <input id="title" name="title" required value="${found.title}" maxlength="200">
        </div>
        <div class="field">
          <label for="due">Due <span class="note">(optional — clear it to remove the date)</span></label>
          <input id="due" name="due" type="date" value="${found.due_at ?? ''}">
        </div>
        <div class="field">
          <label for="client_note">A note for your client <span class="note">(optional — shown at the top of their page)</span></label>
          <textarea id="client_note" name="client_note" rows="4" maxlength="2000">${found.client_note ?? ''}</textarea>
        </div>
        <button type="submit">Save the changes</button>
      </form>
      <p class="note">To change the list itself — adding a document, or stopping asking for one — use the
      request's own page. The record keeps what was asked for and when.</p>`,
  }));
}

/** Save an edit, and record what actually changed rather than that something did. */
export async function saveRequest({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const name = (field(fields, 'client') ?? '').trim();
  const title = (field(fields, 'title') ?? '').trim();
  const due = (field(fields, 'due') ?? '').trim();
  const note = (field(fields, 'client_note') ?? '').trim();
  const carriedClientId = field(fields, 'client_id');

  if (!name) return fail(response, 400, 'A client is required.', practitioner);
  if (!title) return fail(response, 400, 'A title is required.', practitioner);
  if (title.length > 200) return fail(response, 400, 'That title is longer than 200 characters.', practitioner);
  if (note.length > 2000) {
    return fail(response, 400, 'The note for your client is longer than 2000 characters.', practitioner);
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return fail(response, 400, 'That is not a date a browser would send.', practitioner);
  }

  // The client named on the form decides which record the request belongs to: the same name is the same
  // client, and a name typed differently on purpose is only a *new* client when it matches none of them.
  const carried = carriedClientId ? clientFor(db, practiceId, carriedClientId) : null;
  let clientId = carried?.id ?? null;
  if (!clientId) {
    clientId = findOrCreateClient(db, { practiceId, createdBy: practitioner.id, name });
  } else if (name !== carried.name) {
    const clash = db
      .prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
      .get(practiceId, name, carried.id);
    if (clash) return fail(response, 400, `There is already a client called ${name}.`, practitioner);
    updateClient(db, { practiceId, clientId: carried.id, name, email: carried.email });
  }

  const { changes } = updateRequest(db, {
    practiceId,
    requestId: found.id,
    clientId,
    title,
    dueAt: due || null,
    clientNote: note || null,
  });

  return redirect(
    response,
    `/requests/${found.id}/edit?saved=${encodeURIComponent(changes.length === 0 ? 'nothing' : changes.join(', '))}`,
  );
}

/**
 * Ask for the documents, by email.
 *
 * The gap this closes is small on paper and large in practice: the practice could already make a link and
 * already send mail, so the only way to ask for something was to copy a link out of one page and paste it
 * into another program. That step is where a practice decides the tool is a spreadsheet with extra steps.
 *
 * Like the reminder, it **issues a fresh link** rather than reusing one: a link cannot be recovered from the
 * server by design, and the practice may be sending to a client who never received the first one. It is
 * recorded as `request.sent` rather than as a reminder, because the record should say what actually
 * happened — "we asked for this on the 3rd" and "we chased them on the 20th" are different sentences.
 */
export async function draftOpening({ db, request, response, practitioner, params, mailer, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (!practitioner.hasKey) return redirect(response, '/setup');

  const items = itemsOf(db, found.id).filter((item) => !item.withdrawn);
  if (items.length === 0) return redirect(response, `/requests/${found.id}`);

  const fields = formFields(await readBody(request));
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);

  const token = newToken();
  issueToken(db, {
    requestId: found.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  });

  return sendPage(response, 200, reminderPage({
    mailer,
    practitioner,
    found,
    opening: true,
    action: `/requests/${found.id}/send-request`,
    days,
    outstanding: items.length,
    total: items.length,
    draft: openingDraft({
      clientName: found.client_name,
      title: found.title,
      dueAt: found.due_at,
      items: items.map((item) => item.label),
      note: found.client_note,
      link: `${originOf(request)}/r/${token}`,
      practiceName: practiceFor(db, practiceId).name,
    }),
  }));
}

/**
 * Send the request that is on the screen.
 *
 * Identical in shape to sending a reminder, and for the same reasons: the text comes from the form, because
 * the practice may have edited it and their words are what their client should receive; and a failure keeps
 * the text and reports the relay's own words, because a send that loses what somebody typed is worse than a
 * send that fails.
 */
export async function sendOpening({ db, request, response, practitioner, params, mailer, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (!mailer) {
    return fail(response, 400, 'This installation has no mail server configured, so nothing can be sent.', practitioner);
  }
  if (!found.client_email) {
    return fail(response, 400, `There is no email address for ${found.client_name}, so there is nowhere to send it.`, practitioner);
  }

  const fields = formFields(await readBody(request));
  const subject = field(fields, 'subject') ?? openingDraft({
    clientName: found.client_name,
    title: found.title,
    dueAt: found.due_at,
    items: itemsOf(db, found.id).filter((item) => !item.withdrawn).map((item) => item.label),
    note: found.client_note,
    link: '',
  }).subject;
  const body = typeof fields.message === 'string' ? fields.message : '';

  try {
    const messageId = await sendMail(mailer, {
      to: found.client_email,
      subject,
      body,
      html: mailHtml(body, practiceFor(db, practiceId)?.name ?? null),
    });
    recordEvent(db, {
      requestId: found.id,
      kind: 'request.sent',
      detail: `${found.client_email} — ${messageId}`,
    });
    return redirect(response, `/requests/${found.id}?emailed=${encodeURIComponent(messageId)}`);
  } catch (error) {
    if (!(error instanceof MailError)) throw error;
    return sendPage(response, 200, reminderPage({
      mailer,
      practitioner,
      found,
      opening: true,
      action: `/requests/${found.id}/send-request`,
      days: 30,
      outstanding: outstandingOf(db, found.id).length,
      total: itemsOf(db, found.id).length,
      draft: { subject, body },
      error: error.message,
    }));
  }
}

/**
 * The reminder, as a page the practice can edit before it goes anywhere.
 *
 * The fields are **editable**, which is the honest reading of "a draft": what is in them is what gets
 * sent, so an edit is a decision rather than a decoration. The first version made them read-only, which
 * is one keystroke away from the same thing but tells the practice their words do not matter.
 *
 * Sending is offered only when it can work — a mail server configured, and an address to send to — and
 * when it cannot, the page says what is missing rather than showing a button that fails. Same rule as
 * everywhere else here: no control that cannot do what it says.
 */
function reminderPage({
  mailer,
  practitioner,
  found,
  draft,
  days,
  outstanding,
  total,
  error = null,
  opening = false,
  action = null,
}) {
  const canSend = Boolean(mailer) && Boolean(found.client_email);
  const sendTo = action ?? `/requests/${found.id}/send-reminder`;

  const whyNot = !mailer
    ? html`<p class="note">Tickmark cannot send this by itself, because this installation has no mail
        server configured. Set <code>TICKMARK_SMTP_URL</code> and <code>TICKMARK_MAIL_FROM</code> and
        restart it — <code>docs/roadmap.md</code> says what to point them at, and why deliverability is
        a different problem from sending.</p>`
    : !found.client_email
      ? html`<p class="note">There is no email address for ${found.client_name} on this request, so there
          is nowhere to send it. Add one, or copy the message and send it yourself.</p>`
      : '';

  return page({
    title: `${opening ? 'Ask' : 'A reminder for'} ${opening ? found.client_name : ''}`.trim(),
    practitioner,
    banner: error
      ? html`<p class="error"><strong>Not sent.</strong> ${error}<br>Nothing you typed is lost — it is
          below, and you can try again or copy it.</p>`
      : canSend
        ? html`<p class="warning">Sending from <strong>${mailer.describe()}</strong> to
            <strong>${found.client_email}</strong>.</p>`
        : html`<p class="warning">Tickmark does not send this. Copy it into whatever you send mail with,
            to <strong>${found.client_email ?? 'the client'}</strong>.</p>`,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a> · <a href="/requests/${found.id}">${found.title}</a></p>
          <h1>${opening ? `Ask ${found.client_name} for these` : `A reminder for ${found.client_name}`}</h1>
          <p class="sub">${opening
            ? html`${total} ${total === 1 ? 'document is' : 'documents are'} being asked for. The link in the
                message is new, it works for ${days} days, and <strong>it is not recoverable</strong> — if you
                lose it, start this again.`
            : html`${outstanding} of ${total} still outstanding. The link in the message is new, it
                works for ${days} days, and <strong>it is not recoverable</strong> — if you lose it, draft the
                reminder again.`}</p>
        </div>
      </div>
      ${whyNot}
      <form method="post" action="${sendTo}" class="card">
        <div class="field">
          <label for="subject">Subject</label>
          <textarea id="subject" name="subject" rows="2">${draft.subject}</textarea>
        </div>
        <div class="field">
          <label for="message">Message <span class="note">what you see is what gets sent — as plain text, and as a styled copy of these same words</span></label>
          <textarea id="message" name="message" rows="18" data-select-on-click>${draft.body}</textarea>
        </div>
        ${canSend
          ? html`<button type="submit">Send it to ${found.client_email}</button>`
          : html`<button type="submit" disabled>Send it</button>`}
      </form>
      <p class="note"><a href="/requests/${found.id}">Back to the request</a></p>`,
  });
}

/**
 * Send the reminder that is on the screen.
 *
 * Two rules, and both are why this is not a one-line handler:
 *
 * 1. **The text comes from the form.** The practice may have edited it, and their words are what their
 *    client should receive.
 * 2. **A failure keeps the text.** The page is re-rendered with everything still in it and a sentence
 *    saying what went wrong, because a send that loses what someone typed is worse than a send that
 *    fails — and both are recorded, so "did we actually send it?" can be answered by reading.
 */
export async function sendReminder({ db, request, response, practitioner, params, mailer, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (!mailer) {
    return fail(response, 400, 'This installation has no mail server configured, so nothing can be sent.', practitioner);
  }
  if (!found.client_email) {
    return fail(response, 400, `There is no email address for ${found.client_name}, so there is nowhere to send it.`, practitioner);
  }

  const fields = formFields(await readBody(request));
  const subject = field(fields, 'subject');
  const body = typeof fields.message === 'string' ? fields.message : '';
  const days = Math.min(Math.max(Number(field(fields, 'days', '30')) || 30, 1), 365);
  const outstanding = outstandingOf(db, found.id);

  const refuse = (error) => sendPage(
    response,
    400,
    reminderPage({
      mailer,
      practitioner,
      found,
      draft: { subject: subject ?? '', body },
      days,
      outstanding: outstanding.length,
      total: itemsOf(db, found.id).length,
      error,
    }),
  );

  if (!subject) return refuse('A subject is needed — a message with no subject is one a client is likely to delete.');
  if (body.trim().length === 0) return refuse('The message was empty.');

  try {
    const { messageId } = await sendMail(mailer, {
      to: found.client_email,
      subject,
      body,
      html: mailHtml(body, practiceFor(db, practiceId)?.name ?? null),
    });

    // A reminder with no link in it is a message the client cannot act on — they have nowhere to send
    // anything. It is sent anyway, because the words are the practice's decision, but the page says so
    // afterwards rather than letting a send look like a success when it was not: silence about this is
    // exactly the "fails quietly" problem this feature exists to avoid.
    const hasLink = /\/r\/[A-Za-z0-9_-]{20,}/.test(body);
    recordEvent(db, {
      requestId: found.id,
      kind: 'reminder.sent',
      detail: `to ${found.client_email} (${messageId})${hasLink ? '' : ' — with no link in it'}`,
    });
    return redirect(response, `/requests/${found.id}?sent=${encodeURIComponent(messageId)}${hasLink ? '' : '&nolink=1'}`);
  } catch (error) {
    recordEvent(db, {
      requestId: found.id,
      kind: 'reminder.failed',
      detail: `to ${found.client_email} — ${error.message}`,
    });
    return refuse(error.message);
  }
}

export async function closeRequestPage({ db, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const closed = closeRequest(db, practiceId, params[0]);
  if (!closed) return fail(response, 404, 'There is no open request at that address.', practitioner);
  return redirect(response, `/requests/${params[0]}`);
}

export async function reopenRequestPage({ db, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const reopened = reopenRequest(db, practiceId, params[0]);
  if (!reopened) return fail(response, 404, 'There is no closed request at that address.', practitioner);
  return redirect(response, `/requests/${params[0]}`);
}

/**
 * Add documents to a request that is already out with a client.
 *
 * A practice only knows the whole list once it starts looking, and a list fixed at creation is a list
 * they work around by sending a second email — which defeats the point of the request being the thing
 * that answers "did we get it?".
 *
 * A closed request is refused rather than quietly accepting. Reopening is a deliberate act and it
 * should stay one.
 */
export async function addItemsPage({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);
  if (found.closed_at) {
    return fail(response, 400, `"${found.title}" is closed. Reopen it before adding to it.`, practitioner);
  }

  const fields = formFields(await readBody(request));
  const labels = parseItems(typeof fields.items === 'string' ? fields.items : '');
  if (labels.length === 0) {
    return fail(response, 400, 'There was nothing to add — give one document per line.', practitioner);
  }

  const added = addItems(db, { requestId: found.id, labels });
  if (added.length === 0) {
    // Said rather than silently ignored: a practice that adds something and sees no change would
    // reasonably conclude the button is broken.
    return fail(response, 400, 'Everything on that list is already on this request.', practitioner);
  }
  return redirect(response, `/requests/${found.id}`);
}

/**
 * The four things a practice can say about a single document.
 *
 * A table rather than a chain of `if`s, so that the set of things a practice can say is one place a
 * reader can check — and so that an unknown action is a refusal rather than a silent no-op.
 */
const ITEM_ACTIONS = {
  withdraw: ({ db, practiceId, requestId, itemId }) =>
    setItemWithdrawn(db, practiceId, requestId, itemId, true),
  restore: ({ db, practiceId, requestId, itemId }) =>
    setItemWithdrawn(db, practiceId, requestId, itemId, false),
  attention: ({ db, practiceId, requestId, itemId, note }) =>
    setItemAttention(db, practiceId, requestId, itemId, { note }),
  'clear-attention': ({ db, practiceId, requestId, itemId }) =>
    clearItemAttention(db, practiceId, requestId, itemId),
  'relabel': ({ db, practiceId, requestId, itemId, fields }) =>
    setItemLabel(db, practiceId, requestId, itemId, {
      label: field(fields, 'label') ?? '',
      note: field(fields, 'note') ?? '',
    }),
  // The practice saying "I have looked at this", and taking it back. Both are recorded, because the
  // second is how a mistake gets corrected and the history should show that it was.
  check: ({ db, practiceId, requestId, itemId }) =>
    setItemReviewed(db, practiceId, requestId, itemId, true),
  uncheck: ({ db, practiceId, requestId, itemId }) =>
    setItemReviewed(db, practiceId, requestId, itemId, false),
};

export async function changeItemPage({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const [requestId, itemId, action] = params;

  const found = requestFor(db, practiceId, requestId);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const change = Object.hasOwn(ITEM_ACTIONS, action) ? ITEM_ACTIONS[action] : null;
  if (!change) {
    return fail(response, 400, `"${action}" is not something that can be said about a document.`, practitioner);
  }

  // The one route whose permission depends on *which* action it is: `/items/:id/:action` carries withdraw,
  // restore, attention, relabel — all coordination, all an assistant's to do — and `check`, which is a
  // statement that somebody has read the file. A member who holds no key cannot have read it, so the check
  // is refused here rather than tagged on the route. The dispatcher cannot know which action this is; the
  // handler can, and this is where it does.
  //
  // `uncheck` is deliberately **not** in the guard: it withdraws the claim rather than making one, and an
  // assistant who noticed "nobody has looked at that yet" is doing coordination. (The old guard also named
  // a `'check-clear'` action, which has never existed in `ITEM_ACTIONS` — the kind of check that protects
  // nothing because nothing can ever match it. One name, one rule.)
  if (!holdsKey(practitioner.role) && action === 'check') {
    return fail(response, 403, refusalFor('accountant', practitioner.role), practitioner);
  }

  const fields = formFields(await readBody(request));
  const changed = change({
    db,
    practiceId,
    requestId,
    itemId,
    fields,
    note: field(fields, 'attention_note'),
  });
  if (!changed) {
    return fail(
      response,
      404,
      'That document is not part of this request, or it is already in that state.',
      practitioner,
    );
  }
  return redirect(response, `/requests/${found.id}`);
}
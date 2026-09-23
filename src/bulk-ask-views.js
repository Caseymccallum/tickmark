/**
 * Asking everyone at once: the one action that makes fifty clients possible.
 *
 * The twelfth module to leave `app.js`, and one of the two sections `docs/splitting.md` had left to move: the preview
 * page that lists every client and whether they can be written to, the run itself, the per-client opening it sends
 * through the same `openingDraft` the single-request page uses, and the report that says what happened.
 *
 * The three rules the section runs by are stated in full on `askEveryonePage`, and they are the chase's three on
 * purpose — a second set of rules for the same job is a second chance to get it wrong. Two of them are worth knowing
 * at file level, because they are what the code here is shaped by:
 *
 * 1. **The run is bounded in time, not in count.** `CHASE_BUDGET_MS` is imported from `src/chase-views.js` rather than
 *    redefined: what the ceiling is really about is the response still being writable, which is the same question for a
 *    bulk ask and for a chase run. Requests the run did not reach exist with their links already issued, and can be
 *    sent from their own pages — nothing is lost, it is only late.
 * 2. **One failure never stops the run and is never hidden.** The report lists every client with its outcome, the
 *    failed ones included, and a client with no address is named on the preview rather than dropped quietly.
 */
import { CHASE_BUDGET_MS } from './chase-views.js';
import { hashToken, newToken } from './crypto.js';
import { field, formFields, originOf, readBody } from './http.js';
import { mailHtml, sendMail } from './mailer.js';
import { openingDraft } from './notices.js';
import {
  clientsForBulkSend,
  clientsDueForAsking,
  templateFor,
  templatesOf,
  createRequest,
  issueToken,
  practiceFor,
  itemsOf,
  recordEvent,
} from './store.js';
import { TONES, badge, empty, fail, html, page, raw, requireSignIn, sendPage } from './views.js';

// ---------------------------------------------------------------------------------
// Asking everyone at once
// ---------------------------------------------------------------------------------

/**
 * The one action that makes fifty clients possible.
 *
 * The research this product was built from is blunt about where a practice breaks: *manual tracking breaks
 * down past 50 clients*, and a season's document-gathering is 150–175 hours of following up. Built one at a
 * time, sending the same standard request to sixty clients is an afternoon of typing — which is how firms
 * quietly stop doing it, and why the incumbents sell "bulk send" as a headline feature.
 *
 * Three rules, and they are the chase's three, because a second set of rules for the same job is a second
 * chance to get it wrong:
 *
 * 1. **The page is the preview.** Every client is listed with whether they can be written to and why not, so
 *    nothing happens that the practice did not see first. That is why there is no "are you sure?" step.
 * 2. **A failure never stops the run and is never hidden.** One dead mailbox must not stop the other fifty.
 * 3. **The run bounds itself in time**, and says where it stopped. Requests it did not reach exist, with their
 *    links issued, and can be sent individually from their own pages — nothing is lost, it is only late.
 *
 * What it deliberately does not do: merge clients, or guess who *should* get a list. The practice ticks names.
 */
export function askEveryonePage({ db, response, practitioner, practiceId, url, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;
  const templates = templatesOf(db, practiceId);
  const clients = clientsForBulkSend(db, practiceId);
  const reachable = clients.filter((client) => client.email);
  const chosen = templateFor(db, practiceId, url.searchParams.get('template') ?? '');

  // Arriving from the "due to be asked" list, those clients are ticked already. The page is still the preview —
  // every name and address is on it, and the counting is done by a person — but the sixty ticks a season-start
  // needs have been made by the software, which is the whole point of having worked out who is due.
  const dueIds = url.searchParams.get('due') === '1'
    ? new Set(clientsDueForAsking(db, practiceId, { timezone: practiceFor(db, practiceId).timezone }).map((row) => row.id))
    : new Set();
  const dueReachable = clients.filter((client) => dueIds.has(client.id) && client.email).length;

  return sendPage(response, 200, page({
    title: 'Ask everyone at once',
    practitioner,
    here: '/templates',
    // Two notices, both of them true, so both are shown: a page with no mail server still needs to say who is
    // ticked and why, and a page full of ticked clients still needs to say that nothing can be sent.
    banner: html`
      ${!mailer
        ? html`<p class="warning"><strong>This installation has no mail server configured</strong>, so nothing can
            be sent from here. The requests would be made, but not delivered — see
            <a href="/admin/test-email">the mail test page</a>.</p>`
        : ''}
      ${dueReachable > 0
        ? html`<p class="info"><strong>${dueReachable}
            ${dueReachable === 1 ? 'client is' : 'clients are'} ticked because the year has come round</strong> —
            nothing is open for them and they were last asked in this month of an earlier year. Untick anybody you
            do not want to write to; nothing is sent until you press the button.</p>`
        : ''}`,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/templates">Templates</a></p>
          <h1>Ask everyone at once</h1>
          <p class="sub">One list, one deadline, one action — a request per client, each with its own link, all sent
          while you get on with something else.</p>
        </div>
      </div>

      ${templates.length === 0
        ? empty(
            'No template to send',
            'This works from a saved list, so that sixty clients are asked for the same set of documents rather than sixty slightly different ones.',
            html`<a class="btn primary" href="/templates">Make a template</a>`,
          )
        : reachable.length === 0
          ? empty(
              'No client can be emailed yet',
              'Every client on your list is missing an email address, and this action is entirely about writing to people.',
              html`<a class="btn primary" href="/clients">Go to clients</a>`,
            )
          : html`<form method="post" action="/ask-everyone" class="card">
              <h2>The list and the deadline</h2>
              <label for="template_id">Which list?</label>
              <select id="template_id" name="template_id" required>
                ${templates.map((template) => html`<option value="${template.id}"${chosen?.id === template.id ? ' selected' : ''}>${template.name} (${template.item_count} documents)</option>`)}
              </select>

              <label for="title">What is it for?</label>
              <input id="title" name="title" maxlength="200" required
                value="${chosen ? chosen.name : ''}" placeholder="2026 tax return">

              <div class="row">
                <div class="grow">
                  <label for="due">Needed by <span class="note">(optional)</span></label>
                  <input id="due" name="due" type="date">
                </div>
                <div class="grow">
                  <label for="days">The link works for</label>
                  <select id="days" name="days">
                    <option value="30">30 days</option>
                    <option value="60" selected>60 days</option>
                    <option value="120">120 days</option>
                    <option value="365">a year</option>
                  </select>
                </div>
              </div>

              <label for="client_note">A note for all of them <span class="note">(optional — it appears at the top of each client's page)</span></label>
              <textarea id="client_note" name="client_note" rows="3"
                placeholder="Here is the list for your 2026 filing. Please send these by the end of the month.">${chosen?.note ?? ''}</textarea>
              <p class="note">The same words go to everyone, so leave out anything only true of one client — any
              request can be edited afterwards.</p>

              <h2>Who to ask</h2>
              <p class="note">${reachable.length} of ${clients.length}
                ${clients.length === 1 ? 'client' : 'clients'} can be emailed.</p>
              <div class="pick">
                ${clients.map((client) => html`<label class="${client.email ? '' : 'off'}">
                  <input type="checkbox" name="client_id" value="${client.id}"${client.email ? '' : raw(' disabled')}${dueIds.has(client.id) ? raw(' checked') : ''}>
                  <span>
                    <span class="what">${client.name}</span>
                    <span class="who">${client.email
                      ? html`${client.email}${client.open_requests > 0 ? html` · ${client.open_requests} already open` : ''}${dueIds.has(client.id) ? html` · due for this year’s ask` : ''}`
                      : html`no email address — add one on their page first`}</span>
                  </span>
                </label>`)}
              </div>

              <div class="actions">
                <button type="submit" class="primary">Ask the ticked clients</button>
                ${mailer ? html`<button type="submit" name="everyone" value="1">Ask everyone who can be emailed</button>` : ''}
                <a class="btn ghost" href="/requests">Cancel</a>
              </div>
            </form>`}
    `,
  }));
}

/**
 * Make a request for each chosen client and send each one its own link.
 *
 * **Creation and sending are separated on purpose.** Making sixty requests is a fast database operation that
 * either happens or does not; sending sixty emails is sixty network round-trips, any of which can hang. Done
 * interleaved, a run that died at the thirtieth client would leave thirty clients in a state nobody could
 * describe. So every request exists before the first email is attempted, the run bounds itself in time, and
 * what it did not reach is reported as unsent *and finishable* rather than as lost.
 */
export async function askEveryone({ db, request, response, practitioner, practiceId, mailer, chaseBudgetMs = CHASE_BUDGET_MS }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));

  const template = templateFor(db, practiceId, field(fields, 'template_id') ?? '');
  const title = (field(fields, 'title') ?? '').trim();
  const due = (field(fields, 'due') ?? '').trim();
  const clientNote = (field(fields, 'client_note') ?? '').trim() || null;
  const days = Math.min(Math.max(Number(field(fields, 'days', '60')) || 60, 1), 365);

  if (!template) return fail(response, 400, 'Pick the list to send.', practitioner);
  if (template.items.length === 0) {
    return fail(response, 400, `${template.name} has no documents on it, so there would be nothing to ask for.`, practitioner);
  }
  if (title.length === 0) {
    return fail(response, 400, 'A title is required — it is what the client sees at the top of their page.', practitioner);
  }
  if (title.length > 200) return fail(response, 400, 'That title is longer than 200 characters.', practitioner);
  if ((clientNote?.length ?? 0) > 2000) {
    return fail(response, 400, 'That note is longer than 2000 characters.', practitioner);
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return fail(response, 400, 'That due date is not a date a browser would send.', practitioner);
  }

  // Who was asked for. The second button means exactly what it says — everyone who can be emailed — and both
  // paths end at the same list, so there is one thing to reason about afterwards.
  const all = clientsForBulkSend(db, practiceId);
  const asked = field(fields, 'everyone') === '1';
  const ticked = Array.isArray(fields.client_id) ? fields.client_id : fields.client_id ? [fields.client_id] : [];
  const wanted = asked
    ? all.filter((client) => client.email)
    : all.filter((client) => ticked.includes(client.id) && client.email);

  // Who could not be written to. When the practice ticked names, it is the ticked ones without an address; when
  // they asked for everyone, it is *every* client without one — because an "ask everyone" that quietly skips the
  // people it cannot reach is the exact omission this page exists to prevent, and the report has to name them for
  // the practice to be able to go and fix it.
  const withoutAddress = all.filter((client) => !client.email && (asked || ticked.includes(client.id)));
  if (wanted.length === 0) {
    return fail(
      response,
      400,
      ticked.length === 0
        ? 'Tick at least one client, or use the button that asks everyone who can be emailed.'
        : 'Every client you ticked is missing an email address, so there is nowhere to send to.',
      practitioner,
    );
  }
  if (!mailer) {
    return fail(
      response,
      400,
      'This installation has no mail server configured, so there is nothing this could send. Nothing was made — the requests would exist with nobody told about them.',
      practitioner,
    );
  }
  const items = template.items.map((item) => item.label);
  const origin = originOf(request);
  const practiceName = practiceFor(db, practiceId).name;

  // Every request first, each with its own link issued here rather than inside the send loop: a request that was
  // made is then one its client can already use, whatever the email does.
  const made = wanted.map((client) => {
    const requestId = createRequest(db, {
      practiceId,
      createdBy: practitioner.id,
      clientId: client.id,
      title,
      dueAt: due || null,
      clientNote,
      items,
    });
    const token = newToken();
    issueToken(db, {
      requestId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
    });

    // The template's per-document notes, which `createRequest` takes only labels for — carried here so a list
    // that says "the 2025 statement, not the 2024 one" goes on saying it on all sixty requests.
    const fresh = itemsOf(db, requestId);
    for (const [index, item] of template.items.entries()) {
      if (item.note && fresh[index]) {
        db.prepare('UPDATE request_item SET note = ? WHERE id = ?').run(item.note, fresh[index].id);
      }
    }

    return { client, requestId, token };
  });

  const results = [];
  const startedAt = Date.now();
  for (const [index, row] of made.entries()) {
    if (Date.now() - startedAt > chaseBudgetMs) {
      for (const rest of made.slice(index)) results.push({ row: rest, outcome: 'not-attempted' });
      break;
    }
    results.push(
      await sendOneOpening(db, row, { origin, title, dueAt: due || null, clientNote, items }, mailer, practiceName),
    );
  }

  return sendPage(response, 200, askEveryoneReportPage({
    practitioner,
    template,
    title,
    results,
    withoutAddress,
    elapsedMs: Date.now() - startedAt,
  }));
}

/**
 * One client's opening ask, sent.
 *
 * It goes through `openingDraft` — the same wording the single-request page drafts — so "here is what we need"
 * has exactly one home, and a practice that improves it improves it on every request rather than on most.
 */
async function sendOneOpening(db, { client, requestId, token }, { origin, title, dueAt, clientNote, items }, mailer, practiceName) {
  const message = openingDraft({
    clientName: client.name,
    title,
    dueAt,
    items,
    note: clientNote,
    link: `${origin}/r/${token}`,
    practiceName,
  });

  try {
    const { messageId } = await sendMail(mailer, {
      to: client.email,
      subject: message.subject,
      body: message.body,
      html: mailHtml(message.body, practiceName),
    });
    recordEvent(db, { requestId, kind: 'request.sent', detail: `${client.email} — ${messageId}` });
    return { row: { client, requestId }, outcome: 'sent', to: client.email, messageId };
  } catch (error) {
    // Recorded against the request it belongs to, so that client's history says the ask failed rather than
    // showing nothing ever happened.
    recordEvent(db, { requestId, kind: 'reminder.failed', detail: `opening ask: ${error.message}` });
    return { row: { client, requestId }, outcome: 'failed', to: client.email, error: error.message };
  }
}

/**
 * What happened, per client, for the bulk ask.
 *
 * The same shape as the chase's report and for the same reason: a bulk action whose result is "done" teaches a
 * practice to distrust it, and the first time a message quietly did not arrive they would go back to sending
 * them one at a time — which is the whole thing this feature exists to stop.
 *
 * The row for a request that was not reached says the important part out loud: **it exists.** Its link works,
 * its client is simply not holding it yet, and it can be sent from its own page.
 */
function askEveryoneReportPage({ practitioner, template, title, results, withoutAddress, elapsedMs }) {
  const sent = results.filter((entry) => entry.outcome === 'sent');
  const failed = results.filter((entry) => entry.outcome === 'failed');
  const later = results.filter((entry) => entry.outcome === 'not-attempted');
  const seconds = Math.round(elapsedMs / 1000);

  const outcomeOf = (entry) => (entry.outcome === 'sent'
    ? html`<strong>sent</strong> <span class="note">${entry.messageId}</span>`
    : entry.outcome === 'failed'
      ? html`<strong class="error">not sent</strong> <span class="note">${entry.error}</span>`
      : html`<span class="note">not sent — the run was out of time</span>`);

  return page({
    title: 'What happened',
    practitioner,
    here: '/templates',
    banner: later.length > 0
      ? html`<p class="warning"><strong>${later.length}
          ${later.length === 1 ? 'request was' : 'requests were'} made but not emailed</strong>, because the run
          reached its time budget. Nothing is lost: each one exists, its link works, and you can send it from the
          request itself — or leave it, and the chase will include it.</p>`
      : null,
    body: html`
      <h1>${results.length} ${results.length === 1 ? 'client' : 'clients'} asked</h1>
      <p>“${title}” from <strong>${template.name}</strong> — ${sent.length} sent, ${failed.length} failed,
      ${later.length} not sent${withoutAddress.length > 0
        ? html`, ${withoutAddress.length} with no email address`
        : ''} in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.</p>

      ${failed.length > 0
        ? html`<p class="error"><strong>${failed.length}
            ${failed.length === 1 ? 'message was' : 'messages were'} not sent.</strong> The request exists and its
            link works, so the client can still be given it — open the request and use “Email this request”, or
            reply to the failure in your mail server's log first.</p>`
        : ''}
      ${withoutAddress.length > 0
        ? html`<p class="note"><strong>${withoutAddress.length}
            ${withoutAddress.length === 1 ? 'client was' : 'clients were'} not asked</strong> because they have no
            email address. Nothing was made for them: ${withoutAddress
              .map((client) => client.name)
              .join(', ')} — add an address on <a href="/clients">the clients page</a> and ask again.</p>`
        : ''}

      <div class="scroll"><table>
        <colgroup><col class="w26"><col class="w32"><col class="w42"></colgroup>
        <thead><tr><th align="left">Client</th><th align="left">Request</th><th align="left">Outcome</th></tr></thead>
        <tbody>
          ${results.map((entry) => html`<tr>
            <td><span class="cell-t">${entry.row.client.name}</span></td>
            <td><a href="/requests/${entry.row.requestId}">${title}</a></td>
            <td>${outcomeOf(entry)}</td>
          </tr>`)}
          ${withoutAddress.map((client) => html`<tr>
            <td><span class="cell-t">${client.name}</span></td>
            <td><span class="muted">—</span></td>
            <td>${badge('no email address on this client', TONES.wrong)}</td>
          </tr>`)}
        </tbody>
      </table></div>

      <p class="note"><a href="/requests">Back to the board</a> &middot;
      <a href="/templates">Templates</a> &middot; <a href="/chase">the chase list</a></p>`,
  });
}

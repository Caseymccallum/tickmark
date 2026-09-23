/**
 * The board, and the request page behind it: what a practice looks at all day.
 *
 * **Step four of the split `docs/audit.md` §3 proposes** — the last of the four it names — and this file is that
 * section of `app.js`. Everything here answers one question: *whose turn is it?* `listRequests` is the board that
 * sorts every client by that answer, `viewRequest` is one request with its documents, the forms either side of them
 * (`newRequestForm`, `createRequestPage`) are how a request comes into being, and `requestsCsv` is the same board as
 * a file for the practice that keeps its own spreadsheet.
 *
 * Two decisions in here are worth a reader's attention, because both are the kind that rot quietly:
 *
 * 1. **A request's state is derived, never stored.** Every state word and every colour comes from the documents' own
 *    columns — received, checked, withdrawn, answered — so there is no column that can disagree with the list.
 * 2. **The orders are named once.** `REQUEST_ORDER`, `dueFirst` and `byClientName` are read by the page *and* by the
 *    export, so the screen and the CSV cannot sort differently — a divergence nobody reports, they just stop
 *    trusting the file.
 *
 * What is *not* here, though it is adjacent and remains in `app.js`: the templates a request can be started from,
 * the client records it points at, the chase list, and the bulk ask. Those are the pieces of the audit's table that
 * are still unstarted.
 */
import { agoWords, todayIn } from './clock.js';
import { now } from './db.js';
import { field, formFields, parseItems, readBody } from './http.js';
import { holdsKey } from './roles.js';
import {
  MAX_TEMPLATE_NAME,
  clientFor,
  clientSummaries,
  clientsDueForAsking,
  closedCount,
  countRequests,
  createRequest,
  findOrCreateClient,
  history,
  itemsOf,
  membersOf,
  practiceFor,
  practiceKeys,
  previousChecklistFor,
  progressForPractice,
  requestFor,
  requestProgress,
  requestsFor,
  templateFor,
  tokensFor,
  updateClient,
  uploadsOf,
} from './store.js';
import {
  REQUEST_STATE_WORDS,
  TONES,
  badge,
  empty,
  fail,
  html,
  jsonTag,
  page,
  raw,
  redirect,
  requireSignIn,
  section,
  sendCsv,
  sendPage,
  stateTone,
  tile,
} from './views.js';

/**
 * A template's list, as the lines the request form's textarea expects.
 *
 * A document's note goes on the same line, after an em dash, because that is how a practice types one — and it
 * is the same shape the duplicate-a-request path writes, so both ways of filling that textarea agree.
 */
function templateItemLines(template) {
  return template.items.map((item) => (item.note ? `${item.label} — ${item.note}` : item.label)).join('\n');
}

/**
 * Whose turn it is. An answered request sorts with the ones waiting on the practice rather than the ones waiting
 * on the client: somebody has to decide something, and the client is the one waiting for that.
 */
const REQUEST_ORDER = { 'to-check': 0, answered: 1, waiting: 2, ready: 3 };

/** An undated request sorts last: "no date" must not read as "due now". */
const dueFirst = (a, b) => (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');
const byClientName = (a, b) => a.client_name.localeCompare(b.client_name);

/**
 * The orders the board can be read in, defined once and used by both the page and the export.
 *
 * The list exists to answer "what do I do now?", so the default is **whose turn it is**: files to check
 * first, because chasing a client about a document that is already sitting there is the mistake that state
 * exists to prevent. The other orders exist because the question changes — at the end of a season it is
 * dates, and when a client rings up it is their name.
 *
 * Shared with the CSV export on purpose: a file whose rows are in a different order from the screen it was
 * downloaded from is a file somebody has to sort again by hand.
 */
const REQUEST_ORDERS = {
  state: (a, b) =>
    (REQUEST_ORDER[a.progress.state] ?? 9) - (REQUEST_ORDER[b.progress.state] ?? 9) ||
    dueFirst(a, b) ||
    byClientName(a, b),
  due: (a, b) => dueFirst(a, b) || byClientName(a, b),
  client: byClientName,
  asked: (a, b) => b.created_at.localeCompare(a.created_at),
};

/**
 * What a practice sees when they have not finished setting themselves up.
 *
 * The problem this closes is a first hour that says nothing. A new practice lands on an empty board after making
 * a key, and the things standing between them and a client sending a document are invisible: make a key, add a
 * client, ask for something, and — the one nobody would guess — **configure a mail server, or the chase cannot
 * reach anybody**. Each is discoverable by reading the right page, and none of them is discoverable by looking at
 * the board.
 *
 * Four decisions in it:
 *
 * 1. **The state is derived, never stored.** There is no "onboarded" flag to fall out of step with reality: a
 *    step is done when the database says so, so a practice arriving with a database already in use sees the right
 *    list, and one that has finished sees nothing at all.
 * 2. **It disappears on its own.** No dismissal and no "hide this" — a checklist somebody has to close becomes
 *    permanent furniture. Once the three essential steps are done it is gone.
 * 3. **Email is on the list and is not essential.** It is the one step a practice cannot deduce from the product,
 *    because everything else works without it: reminders are drafted and shown in full, they just cannot be sent.
 *    So it is listed, explained in a sentence, and does not hold the card open on its own.
 * 4. **It is the only thing on the board that is not about a client**, and it says when it will leave.
 */
function firstRunCard({ db, practiceId, practitioner, mailer }) {
  // A count, not a list: this card asks whether any request exists at all, and building every request's counts to
  // answer that was one of three identical passes over the items table on every board render.
  const requests = countRequests(db, practiceId);
  const team = membersOf(db, practiceId).filter((member) => !member.removedAt).length;

  const steps = [
    {
      done: Boolean(practitioner?.hasKey),
      title: 'Make your encryption key',
      why: 'One passphrase, held by you. Clients’ files are encrypted to this key in their browser, which is what makes the central promise true — and it is the only thing that cannot be recovered if it is lost.',
      href: '/setup',
      action: 'Make the key',
      essential: true,
    },
    {
      done: requests > 0,
      title: 'Ask a client for documents',
      why: 'Name the client as you go: the first request is what creates them, and their history starts there. You get a link to send with no account needed on their side, and a list to chase against.',
      href: '/requests/new',
      action: 'Make a request',
      essential: true,
    },
    {
      done: Boolean(mailer),
      title: 'Set up email, so the chase can reach a client',
      why: 'Everything works without this — reminders are drafted and shown in full — but nothing can actually be sent. One relay, one page of documentation, and a test page to prove it works.',
      href: '/admin/test-email',
      action: 'Test the mail relay',
      essential: false,
    },
    {
      done: team > 1,
      title: 'Invite someone, if there is someone',
      why: 'A second member gets their own passphrase and their own copy of the key. An assistant can chase clients without ever holding one.',
      href: '/members',
      action: 'Invite a member',
      essential: false,
    },
  ];

  // Nothing until the three that matter are done, and nothing ever again after that.
  if (steps.filter((step) => step.essential).every((step) => step.done)) return null;

  const left = steps.filter((step) => !step.done).length;
  return section(
    'Getting started',
    `${left} ${left === 1 ? 'thing' : 'things'} left. This goes away once the first two are done.`,
    html`<ul class="steps-list">
      ${steps.map((step) => html`<li class="${step.done ? 'done' : ''}">
        <span class="tick">${step.done ? '✓' : ''}</span>
        <span>
          <strong>${step.title}</strong>${step.essential ? '' : html` <span class="note">(optional)</span>`}
          ${step.done ? '' : html`<span class="cell-s">${step.why}</span>`}
          ${step.done ? '' : html`<div class="row tight"><a class="btn sm" href="${step.href}">${step.action}</a></div>`}
        </span>
      </li>`)}
    </ul>`,
  );
}

export function listRequests({ db, response, practitioner, url, practiceId, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;
  const showingClosed = url.searchParams.get('closed') === '1';
  const wanted = url.searchParams.get('state');
  const query = (url.searchParams.get('q') ?? '').trim();
  const sort = url.searchParams.get('sort') ?? 'state';
  // One read of the practice's own row, and one build of the request counts, for a handler that needs both in two
  // places each. Before this, the row was read twice and the counts were built three times — the table, the season
  // notice and the first-run card each asked independently, and none of them knew about the others.
  const practice = practiceFor(db, practiceId);
  const progress = progressForPractice(db, practiceId);
  const all = requestsFor(db, practiceId, { scope: showingClosed ? 'closed' : 'open', progress });
  const closed = closedCount(db, practiceId);
  // Overdue is a question about the practice's calendar, not Greenwich's: a due date of the 31st is late on
  // the 31st where they are, and answering it in UTC makes that answer wrong for part of every day — in the
  // direction that says "overdue" a day early in Auckland and a day late in Honolulu.
  const today = todayIn(practice.timezone);

  /**
   * The season notice: who is due an ask, said on the page a practice actually opens.
   *
   * `clientsDueForAsking` has existed since 2u and is accurate, and its one weakness was that it lived only on
   * the clients page — a practice who works from the board every morning would never be told that the year had
   * come round, which is the remembering half of "no scheduled requests" and the only half this product wants.
   *
   * Shown only on the board's home state — not the closed tab, not a filtered or searched list — because a
   * notice that follows somebody around stops being a notice. And it is information rather than a nag: it
   * appears when there is season work, and asking the clients removes them from the list, so it clears itself.
   */
  const seasonNotice =
    showingClosed || wanted || query
      ? null
      : clientsDueForAsking(db, practiceId, { timezone: practice.timezone, progress });

  const counts = {};
  for (const row of all) counts[row.progress.state] = (counts[row.progress.state] ?? 0) + 1;
  // Search before the state filter, so the count under the search box is "what matched" rather than
  // "what matched that also happens to be in the tab I am looking at", which nobody can act on.
  //
  // Matched against the client, the title and the address: an accountant looking for a request by the
  // address it came from is as likely as by the name, and matching a substring at all is what makes this
  // useful for the way a practice actually remembers things ("the 2025 one", "northwind").
  const needle = query.toLowerCase();
  const matching = needle
    ? all.filter((row) =>
        [row.client_name, row.title, row.client_email ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : all;

  const rows = matching
    .filter((row) => !wanted || row.progress.state === wanted)
    .sort(REQUEST_ORDERS[sort] ?? REQUEST_ORDERS.state);

  /**
   * A link back to this list with one thing changed, and everything else kept.
   *
   * Written once because there are now four filters that compose — tab, state, search, order — and a URL
   * built by hand at each call site is how one of them quietly gets dropped. An empty value removes its
   * parameter rather than sending `q=`, so the address bar stays readable and a link can be sent to
   * somebody else.
   */
  const href = (changes = {}) => {
    const params = new URLSearchParams();
    const merged = {
      closed: showingClosed ? '1' : '',
      state: wanted ?? '',
      q: query,
      sort: sort === 'state' ? '' : sort,
      ...changes,
    };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    const string = params.toString();
    return `/requests${string ? `?${string}` : ''}`;
  };

  const dueCell = (row) => {
    if (!row.due_at) return html`<span class="muted">no date</span>`;
    if (row.due_at < today && !showingClosed) {
      return html`${badge('overdue', TONES.wrong)} <span class="muted">${row.due_at}</span>`;
    }
    return row.due_at;
  };

  const stateBadge = (state) => badge(REQUEST_STATE_WORDS[state], stateTone(state));

  const table = rows.length === 0
    ? empty(
        query
          ? `Nothing matches “${query}”`
          : showingClosed
            ? 'Nothing has been closed yet'
            : wanted
              ? 'Nothing is in that state'
              : 'No requests yet',
        query
          ? html`The search looks at the client, the request and the address. <a href="${href({ q: '' })}">Clear it</a> to see everything again.`
          : showingClosed
            ? 'When a year is finished with, close the request: the record, the files and the client’s link all stay exactly as they are.'
            : wanted
              ? html`<a href="/requests">Show everything open</a>.`
              : html`Start one and send the client a link — it takes a minute, and the client needs no account.`,
        query || showingClosed || wanted ? null : html`<a class="btn primary" href="/requests/new">New request</a>`,
      )
    : html`<div class="scroll"><table class="board">
        <colgroup>
          <col class="c-client"><col class="c-request"><col class="c-state">
          <col class="c-due"><col class="c-out"><col class="c-check">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Client</th>
            <th align="left">Request</th>
            <th align="left">State</th>
            <th align="left">Due</th>
            <th align="right">Outstanding</th>
            <th align="right">To check</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td><span class="cell-t">${row.client_name}</span></td>
            <td>
              <a class="cell-t" href="/requests/${row.id}">${row.title}</a>
              <a class="cell-s" href="/requests/new?from=${row.id}">Duplicate</a>
            </td>
            <td><a href="/requests?state=${row.progress.state}">${stateBadge(row.progress.state)}</a></td>
            <td>${dueCell(row)}</td>
            <td align="right">${row.progress.outstanding === 0
              ? html`<span class="muted">—</span>`
              : html`<strong>${row.progress.outstanding}</strong>`}</td>
            <td align="right">${row.progress.toCheck === 0
              ? html`<span class="muted">—</span>`
              : html`<strong>${row.progress.toCheck}</strong>`}</td>
          </tr>`)}
        </tbody>
      </table></div>`;

  return sendPage(response, 200, page({
    title: showingClosed ? 'Closed requests' : 'Requests',
    practitioner,
    here: '/requests',
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>${showingClosed ? 'Closed requests' : 'Requests'}</h1>
          <p class="sub">${showingClosed
            ? 'Closed is a status, not a deletion — the record, the files and the client’s link all stay as they are.'
            : 'Each request is a short list of documents the client owes you, with a tick as each one arrives.'}</p>
        </div>
        <div class="do">
          ${showingClosed ? '' : html`<a class="btn primary" href="/requests/new">New request</a>`}
        </div>
      </div>
      ${showingClosed || wanted || query ? '' : firstRunCard({ db, practiceId, practitioner, mailer })}
      ${seasonNotice?.length
        ? html`<p class="info"><strong>${seasonNotice.length}
            ${seasonNotice.length === 1 ? 'client is' : 'clients are'} due to be asked.</strong>
            Nothing is open for them, and you asked around this time of year last time —
            <a href="/ask-everyone?due=1">start the ask</a>. The list arrives with those clients ticked,
            and nothing is sent until you press it.</p>`
        : ''}
      <div class="bar">
        <div class="seg">
          <a href="${href({ closed: '' })}"${showingClosed ? '' : raw(' aria-current="page"')}>Open</a>
          <a href="${href({ closed: '1' })}"${showingClosed ? raw(' aria-current="page"') : ''}>closed (${closed})</a>
        </div>
        ${html`<form class="search" method="get" action="/requests">
              ${showingClosed ? html`<input type="hidden" name="closed" value="1">` : ''}
              ${wanted ? html`<input type="hidden" name="state" value="${wanted}">` : ''}
              ${sort !== 'state' ? html`<input type="hidden" name="sort" value="${sort}">` : ''}
              <input type="search" name="q" value="${query}" placeholder="Client, request or address"
                aria-label="Search requests">
              <button type="submit">Search</button>
              ${query
                ? html`<a class="clear" href="${href({ q: '' })}">Clear</a>`
                : ''}
            </form>`}
      </div>
      ${rows.length > 1 || wanted || query
        ? html`<p class="note">${rows.length} ${rows.length === 1 ? 'request' : 'requests'}${query
            ? html` matching “${query}”`
            : ''}${wanted ? html` · filtered to <a href="${href({ state: '' })}">everything</a>` : ''}
            ${showingClosed
              ? ''
              : html` · <a href="${href({ sort: sort === 'due' ? '' : 'due' })}">${sort === 'due' ? 'by whose turn it is' : 'by due date'}</a>
                  · <a href="${href({ sort: sort === 'client' ? '' : 'client' })}">${sort === 'client' ? 'by whose turn it is' : 'by client'}</a>`}
            · <a class="clear" href="/requests.csv${href({}).replace('/requests', '')}">Download as CSV</a>${showingClosed
              ? ''
              : html` · at the end of a season, <a href="/requests/close">close several at once</a>`}</p>`
        : html`<p class="note">${showingClosed
            ? ''
            : html`At the end of a season, <a href="/requests/close">close several at once</a>. `}Start the whole
            year from one list with <a href="/ask-everyone">ask everyone at once</a>.</p>`}
      ${showingClosed || all.length === 0
        ? ''
        : html`<div class="tiles">
            ${(counts['to-check'] ?? 0) > 0
              ? tile(counts['to-check'], 'with files to check', {
                  href: '/requests?state=to-check',
                  tone: 'attn',
                  current: wanted === 'to-check',
                })
              : ''}
            ${(counts.answered ?? 0) > 0
              ? tile(counts.answered, 'with an answer to read', {
                  href: '/requests?state=answered',
                  tone: 'attn',
                  current: wanted === 'answered',
                })
              : ''}
            ${tile(counts.waiting ?? 0, 'waiting on clients', {
              href: '/requests?state=waiting',
              current: wanted === 'waiting',
            })}
            ${tile(counts.ready ?? 0, 'ready to work on', {
              href: '/requests?state=ready',
              current: wanted === 'ready',
            })}
            ${tile(all.length, showingClosed ? 'closed in total' : 'open in total', { href: '/requests' })}
          </div>`}
      ${table}
      ${showingClosed || all.length === 0
        ? ''
        : html`<p class="note">Something missing? <a href="/chase">chase everyone outstanding</a> — everyone, in one list.</p>`}`,
  }));
}
/**
 * The form a request is made from.
 *
 * `clients` is the practice's existing names, offered as an autocomplete list rather than as a select
 * box. A datalist keeps the field free text — a new client is still typed, not created somewhere else
 * first — while making the names that already exist visible at the moment the match is decided. That is
 * where a typo becomes a duplicate client, so that is where the choice belongs.
 *
 * `forClient` is the client a request is definitely for, carried in a hidden field. Hidden rather than
 * inferred from the name on submit, because it was already decided on the previous page: re-deciding it
 * by matching a name would mean a rename here silently produced a second client.
 */
function requestForm({ error = null, values = {}, clients = [], forClient = null } = {}) {
  return html`
    <h1>New request</h1>
    ${error ? html`<p class="error">${error}</p>` : ''}
    <form method="post" action="/requests" class="card">
      ${forClient ? html`<input type="hidden" name="client_id" value="${forClient}">` : ''}
      <div class="field">
        <label for="client">Client</label>
        <input id="client" name="client" required value="${values.client ?? ''}"
          list="client-names" autocomplete="off">
        ${clients.length > 0
          ? html`<datalist id="client-names">
              ${clients.map((client) => html`<option value="${client.name}">${client.email ?? ''}</option>`)}
            </datalist>
            <p class="form-hint">One of the ${clients.length} this practice already has, or a new one.
            A name that matches an existing client is theirs — with their address on it.</p>`
          : ''}
      </div>
      <div class="field">
        <label for="client_email">Client email <span class="note">(optional, for the reminder text)</span></label>
        <input id="client_email" name="client_email" type="email" value="${values.client_email ?? ''}">
        <p class="form-hint">Saved on the client, so the chase uses it from now on — typing it here also
        fixes it for them.</p>
      </div>
      <div class="field">
        <label for="title">What is this for?</label>
        <input id="title" name="title" required value="${values.title ?? ''}" placeholder="2025 return">
      </div>
      <div class="field">
        <label for="due">Due <span class="note">(optional)</span></label>
        <input id="due" name="due" type="date" value="${values.due ?? ''}">
      </div>
      <div class="field">
        <label for="client_note">A note for your client <span class="note">(optional — shown at the top of their page)</span></label>
        <textarea id="client_note" name="client_note" rows="3" maxlength="2000"
          placeholder="Hi Sarah, here is the list for your 2026 corporate tax filing. Please upload these by Friday.">${values.client_note ?? ''}</textarea>
      </div>
      <div class="field">
        <label for="items">What do you need? <span class="note">one document per line</span></label>
        <textarea id="items" name="items" rows="8" required placeholder="Bank statements for all accounts, 2025&#10;Signed engagement letter&#10;Photo ID">${values.items ?? ''}</textarea>
      </div>
      <button type="submit" class="primary">Create the request</button>
    </form>`;
}

export function newRequestForm({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;

  // Four ways in, and they compose:
  //
  // - `?from=<request id>` fills the form in from a request that already exists.
  // - `?for=<client id>` is "this is for them", so the client is filled in and carried.
  // - `?like=last` fills the checklist from that client's most recent request.
  // - `?template=<id>` fills the checklist and the note from a saved list.
  //
  // The first and the last are two versions of the same idea, and the difference is *where the list lives*.
  // Duplicating a request is right when the thing you are copying is one specific job; a template is right when
  // the list is the practice's standard and no single request is its home. Both fill the form in rather than
  // creating anything outright, so the practice sees and adjusts the list before it goes anywhere.
  //
  // What carries over is the title, the checklist and the note to the client — the note pre-filled rather
  // than dropped, because "please upload these by Friday" is usually still true next year and easier to edit
  // than to rewrite. The client does not carry over *from a request*: a duplicate exists for "next year" or
  // "another client with the same paperwork", and pre-filling last year's client is how a return goes to the
  // wrong person. Coming from a client's own page is the opposite case — there the client is the one thing
  // that is certainly right.
  const from = url?.searchParams?.get('from');
  const source = from ? requestFor(db, practiceId, from) : null;

  const forId = url?.searchParams?.get('for');
  const forClient = forId ? clientFor(db, practiceId, forId) : null;
  const likeLast = url?.searchParams?.get('like') === 'last';
  const previous = forClient && likeLast ? previousChecklistFor(db, practiceId, forClient.id) : null;

  const templateId = url?.searchParams?.get('template');
  const template = templateId ? templateFor(db, practiceId, templateId) : null;

  const clients = clientSummaries(db, practiceId).map((row) => ({ name: row.name, email: row.email }));

  const values = source
    ? {
        client: '',
        client_email: '',
        title: source.title,
        due: '',
        client_note: source.client_note ?? '',
        items: itemsOf(db, source.id)
          .filter((item) => !item.withdrawn)
          .map((item) => (item.note ? `${item.label} — ${item.note}` : item.label))
          .join('\n'),
      }
    : template
      ? {
          client: forClient?.name ?? '',
          client_email: forClient?.email ?? '',
          title: forClient ? '' : template.name,
          due: '',
          client_note: template.note ?? '',
          items: templateItemLines(template),
        }
      : forClient
        ? {
            client: forClient.name,
            client_email: forClient.email ?? '',
            title: previous?.title ?? '',
            items: (previous?.items ?? []).join('\n'),
          }
        : {};

  return sendPage(response, 200, page({
    title: 'New request',
    practitioner,
    here: source || forClient ? null : '/requests',
    banner: template
      ? html`<p class="note">Starting from <a href="/templates/${template.id}">${template.name}</a> —
          ${template.items.length} ${template.items.length === 1 ? 'document' : 'documents'} filled in below.
          Edit anything you like: the template itself is not changed, and nothing is created until you press the
          button.</p>`
      : source
      ? html`<p class="note">Duplicating <a href="/requests/${source.id}">${source.title}</a> — the
          checklist below is copied from it. Choose the client and, if you want one, a due date:
          nothing is created until you press the button, and the earlier request is not touched.</p>`
      : forClient
        ? html`<p class="note">For <a href="/clients/${forClient.id}">${forClient.name}</a> — the client
            is already chosen, so nothing here can file it against the wrong one.${previous && previous.items.length > 0
              ? html` Their last request's checklist is filled in below; change whatever is different
                  this year.`
              : ''}</p>`
        : null,
    body: requestForm({ values, clients, forClient: forClient?.id ?? null }),
  }));
}

export async function createRequestPage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const clientName = field(fields, 'client');
  const clientEmail = field(fields, 'client_email');
  const carriedClientId = field(fields, 'client_id');
  const title = field(fields, 'title');
  const due = field(fields, 'due');
  const clientNote = field(fields, 'client_note')?.trim() || null;
  const rawItems = typeof fields.items === 'string' ? fields.items : '';
  const items = parseItems(rawItems);
  const values = {
    client: clientName ?? '',
    client_email: clientEmail ?? '',
    title: title ?? '',
    due: due ?? '',
    client_note: clientNote ?? '',
    items: rawItems,
  };

  // The client the form was opened for, if it came from a client's page and still belongs to this
  // practice. Scoped by practice like every other read, so a hand-edited hidden field cannot borrow
  // somebody else's client — it simply stops being found.
  const carried = carriedClientId ? clientFor(db, practiceId, carriedClientId) : null;

  const problem = !clientName
    ? 'A client is required.'
    : !title
      ? 'A title is required.'
      : items.length === 0
        ? 'At least one document is required, one per line.'
        : (clientNote?.length ?? 0) > 2000
          ? 'The note for your client is longer than 2000 characters. Shorten it, or put the detail on the documents themselves.'
          : null;

  const clients = clientSummaries(db, practiceId).map((row) => ({ name: row.name, email: row.email }));
  const render = (error) => sendPage(response, 400, page({
    title: 'New request',
    practitioner,
    body: requestForm({ error, values, clients, forClient: carried?.id ?? null }),
  }));

  if (problem) return render(problem);

  // Two ways a request gets its client, and the difference is deliberate. Arriving from a client's own
  // page, the client is already decided — so the row is used, and the name on the form is applied to it
  // as a correction (a typo noticed at the last moment). Typing a name on a blank form is a match: an
  // existing client of that name, or a new one.
  let clientId;
  if (carried) {
    if (clientName.length > 200) return render('That name is longer than 200 characters.');
    const clash = db
      .prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
      .get(practiceId, clientName, carried.id);
    if (clash) {
      return render(
        `There is already a client called ${clientName}. Rename one of them on the clients page — two records with one name is how a request ends up filed against the wrong one.`,
      );
    }
    updateClient(db, {
      practiceId,
      clientId: carried.id,
      name: clientName,
      email: clientEmail || carried.email,
    });
    clientId = carried.id;
  } else {
    clientId = findOrCreateClient(db, {
      practiceId,
      createdBy: practitioner.id,
      name: clientName,
      email: clientEmail,
    });
  }

  const requestId = createRequest(db, {
    practiceId,
    createdBy: practitioner.id,
    clientId,
    title,
    dueAt: due,
    items,
    clientNote,
  });
  return redirect(response, `/requests/${requestId}`);
}

export function viewRequest({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  // A reminder that was just sent says so here. The confirmation has to be on the page the practice
  // lands on, because "did it go?" is the whole question a send raises, and the answer is otherwise
  // only in the history below.
  const sent = new URL(request.url, 'http://localhost').searchParams.get('sent');
  const sentWithoutLink = new URL(request.url, 'http://localhost').searchParams.get('nolink') === '1';
  const emailed = new URL(request.url, 'http://localhost').searchParams.get('emailed');
  const justContacted = new URL(request.url, 'http://localhost').searchParams.get('contacted') === '1';
  const checkedCount = new URL(request.url, 'http://localhost').searchParams.get('checked');

  const allItems = itemsOf(db, found.id);
  const live = allItems.filter((item) => !item.withdrawn);
  const withdrawn = allItems.filter((item) => item.withdrawn);
  const links = tokensFor(db, found.id);
  const filesFor = new Map();
  const extras = [];
  for (const upload of uploadsOf(db, found.id)) {
    // Files the client sent that nobody asked for. They belong to the request and to no item, so they are
    // gathered separately rather than being filed against a checklist line they do not answer.
    if (upload.request_item_id === null) {
      extras.push(upload);
      continue;
    }
    const list = filesFor.get(upload.request_item_id) ?? [];
    list.push(upload);
    filesFor.set(upload.request_item_id, list);
  }
  const filesOf = (item) => filesFor.get(item.id) ?? [];
  const received = live.filter((item) => filesOf(item).length > 0).length;
  const outstanding = live.filter((item) => filesOf(item).length === 0);
  const attention = live.filter((item) => item.needsAttention);
  // Computed from the same function the list uses, so the page and the board cannot disagree.
  const progress = requestProgress(db, found.id);
  const events = history(db, found.id);
  // What the client wrote in their own words, so the practice sees it beside the documents rather than only
  // in a mail client. The history below shows it too; this is the part that is meant to be noticed.
  const messages = events.filter((event) => event.kind === 'client.messaged');
  // When this client was last in touch by any means, for the line in the chasing card: the question the practice
  // asks before pressing "Draft a reminder" is "have I already spoken to them?", and until 2v the page could not
  // answer it for a phone call.
  const lastContact = events
    .filter((event) => event.kind === 'reminder.sent' || event.kind === 'request.contacted')
    .map((event) => event.at)
    .sort()
    .at(-1) ?? null;

  // The confirmation line, when the practice has just arrived from a send. Two of them, because "we asked
  // for it" and "we chased them for it" are different acts and the page should say which just happened.
  const emailedNotice = emailed
    ? html`<p class="success"><strong>Request sent.</strong> Its identifier is <code>${emailed}</code> — if
        the client says it never arrived, this is what to quote to your mail provider. The link inside it
        works for 30 days and can be revoked from this page.</p>`
    : null;

  // The confirmation line, when the practice has just arrived from a send.
  const sentNotice = sent
    ? html`<p class="${sentWithoutLink ? 'warning' : 'success'}"><strong>Reminder sent.</strong> Its
        identifier is <code>${sent}</code> — if a client says it never arrived, this is what to quote to
        your mail provider.${sentWithoutLink
          ? html` <strong>There was no link in the message</strong>, so the client cannot send anything
              from it — draft another reminder if that was not what you meant.`
          : ''}</p>`
    : null;

  /** What the practice can say about one item — which is what makes the list a living thing. */
  const controlsFor = (item) => html`
    ${item.received
      ? item.checked
        ? html`<form method="post" action="/requests/${found.id}/items/${item.id}/uncheck" class="inline">
            <button type="submit">Not checked after all</button>
          </form>`
        : html`<form method="post" action="/requests/${found.id}/items/${item.id}/check" class="inline">
            <button type="submit">Checked it</button>
          </form>`
      : ''}
    ${item.needsAttention
      ? html`<form method="post" action="/requests/${found.id}/items/${item.id}/clear-attention" class="inline">
          <button type="submit">Dealt with</button>
        </form>`
      : html`<form method="post" action="/requests/${found.id}/items/${item.id}/attention" class="inline">
          <input type="text" name="attention_note" placeholder="why? the client sees this" maxlength="500">
          <button type="submit">Needs attention</button>
        </form>`}
    <form method="post" action="/requests/${found.id}/items/${item.id}/withdraw" class="inline">
      <button type="submit">Stop asking</button>
    </form>`;

  // The practice's own words about a document, and — behind a disclosure — the ability to correct them. A
  // disclosure rather than a second always-visible form: renaming is rare, and a row with three inputs in it
  // is a row nobody can read.
  const labelCell = (item) => html`
    <span class="cell-t">${item.label}</span>
    ${item.note ? html`<span class="cell-s">${item.note}</span>` : ''}
    ${found.closed_at
      ? ''
      : html`<details class="rename">
          <summary>Wrong words?</summary>
          <form method="post" action="/requests/${found.id}/items/${item.id}/relabel" class="stack">
            <input type="text" name="label" value="${item.label}" maxlength="200" required
              aria-label="What this document is called">
            <input type="text" name="note" value="${item.note ?? ''}" maxlength="500"
              placeholder="a note for the client (optional)" aria-label="A note for the client">
            <div class="row tight">
              <button type="submit">Save</button>
            </div>
            <span class="status"></span>
          </form>
        </details>`}`;

  const rows = live.map((item) => html`<tr>
    <td>${labelCell(item)}</td>
    <td>${item.needsAttention
      ? html`${badge('needs attention', TONES.wrong)}${item.attentionNote ? html`<span class="cell-s">${item.attentionNote}</span>` : ''}`
      : !item.received && item.clientSays
        ? html`${badge('client says:', TONES.waiting)}<span class="cell-s">${item.clientSays}</span>`
        : item.received
          ? item.checked
            ? badge('checked', TONES.done)
            : html`${badge('to check', TONES.todo)}<span class="cell-s">nobody has looked at this yet</span>`
          : badge('outstanding', TONES.waiting)}</td>
    <td>${filesOf(item).length === 0
      ? html`<span class="muted">—</span>`
      : filesOf(item).map((file) => html`<div class="file">
          <span class="name">${file.filename}</span>
          <span class="note">${file.uploaded_at.slice(0, 10)}</span>
          <button type="button" class="save" disabled
                  data-url="/requests/${found.id}/files/${file.id}"
                  data-name="${file.filename}">Save</button>
          <span class="status note"></span>
          ${file.client_note ? html`<div class="note">they said: ${file.client_note}</div>` : ''}
        </div>`)}</td>
    <td>${found.closed_at ? html`<span class="muted">closed</span>` : controlsFor(item)}</td>
  </tr>`);

  // The wrapped keys travel in the page because the decryption happens here. They leak nothing — the
  // server already stores them, and they are useless without the passphrase — and they have to be
  // here, or the plaintext would have to be produced by the server, which is the one thing that must
  // not happen. All of them, because a file sent before the last rotation is encrypted to an older
  // key.
  const keys = practiceKeys(db, practiceId, practitioner.id);

  return sendPage(response, 200, page({
    title: found.title,
    practitioner,
    here: '/requests',
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a>${found.closed_at ? html` · closed` : ''}</p>
          <h1>${found.title}</h1>
          <p class="sub">For ${found.client_name}${found.due_at ? html` · needed by ${found.due_at}` : ''}${withdrawn.length > 0 ? html` · ${withdrawn.length} no longer asked for` : ''}</p>
        </div>
        <div class="do">
          ${found.closed_at || allItems.filter((item) => !item.withdrawn).length === 0
            ? ''
            : html`<form method="post" action="/requests/${found.id}/send" class="inline">
                <button type="submit" class="primary">Email this request</button>
              </form>`}
          <a class="btn" href="/requests/${found.id}/edit">Edit</a>
          <a class="btn" href="/requests/new?from=${found.id}">Duplicate</a>
        </div>
      </div>
      ${emailedNotice}
      ${checkedCount && /^\d+$/.test(checkedCount)
        ? html`<p class="success"><strong>${checkedCount} document${checkedCount === '1' ? '' : 's'} checked.</strong>
            Each one is recorded against the document it belongs to, so the history below says who looked at what and
            when — the same rows the per-document buttons write.</p>`
        : ''}
      ${justContacted
        ? html`<p class="success"><strong>Recorded.</strong> Nothing was sent — this is in the record, and it
            counts against your chase cadence, so the batch run will leave them alone until you would be back in
            touch anyway.</p>`
        : ''}
      ${found.client_note ? html`<div class="greeting">${found.client_note}</div>` : ''}
      ${sentNotice}
      <p class="count">${received} of ${live.length} received${found.due_at ? html`, due ${found.due_at}` : ''}${withdrawn.length > 0 ? html` · ${withdrawn.length} no longer asked for` : ''}.</p>
      ${found.closed_at
        ? html`<p class="info"><strong>Closed.</strong> Nothing has been deleted — the client’s link still
            works, and reopening puts it back on the list exactly as it was.</p>`
        : ''}
      ${found.closed_at || progress.items === 0
        ? ''
        : progress.state === 'ready'
          ? html`<p class="success"><strong>Ready to work on.</strong>
              Everything asked for has arrived and been checked.${progress.checked > 0
                ? html` Last checked against ${progress.checked} document${progress.checked === 1 ? '' : 's'}.`
                : ''}</p>`
          : progress.state === 'to-check'
            ? html`<p class="warning"><strong>Files to check.</strong> ${progress.toCheck}
                ${progress.toCheck === 1 ? 'document has' : 'documents have'} arrived and nothing has looked
                at ${progress.toCheck === 1 ? 'it' : 'them'} yet. "Received" is not "ready" — do this before
                chasing anything else, because what is already here is the thing a client is least likely
                to send twice.</p>
              <form method="post" action="/requests/${found.id}/check-all">
                <div class="actions">
                  <button type="submit" class="primary">Mark all ${progress.toCheck} as checked</button>
                </div>
                <p class="note">One press for the usual case: you downloaded them, read them, and they are fine.
                Each one is still checked off on its own in the record, exactly as the buttons beside it do. If a
                document needs sending again, use that button instead — checking it says somebody looked, and the
                flag is what keeps it outstanding.</p>
              </form>`
            : progress.state === 'answered'
              ? html`<p class="warning"><strong>The client has answered.</strong> ${progress.clientSaid}
                  ${progress.clientSaid === 1 ? 'document has' : 'documents have'} an answer from them —
                  see the list below. They are waiting on a decision: if the answer is fine, take the
                  document off the list; if it is not, that is a conversation rather than another
                  reminder.</p>`
              : progress.needsAttention > 0 && progress.received === progress.items
                ? html`<p class="warning"><strong>Waiting on a replacement.</strong> Everything asked for has
                    arrived, but ${progress.needsAttention} of them
                    ${progress.needsAttention === 1 ? 'is' : 'are'} going to be sent again — the list below says
                    which and why, and the client's page says the same. The next reminder asks for them.</p>`
                : html`<p class="note">Waiting on the client for ${progress.outstanding} of
                    ${progress.items} ${progress.items === 1 ? 'document' : 'documents'}.</p>`}
      ${attention.length > 0
        ? html`<p class="warning"><strong>${attention.length === 1 ? 'One document needs attention' : `${attention.length} documents need attention`}:</strong>
            ${attention.map((item) => item.label).join(', ')}. The client's page says what is wrong with
            each one, and the next reminder asks for them again.</p>`
        : ''}
      <p class="note"><a href="/requests/new?from=${found.id}">Duplicate this request</a> — the title and
      checklist are copied into a new draft; you choose the client and the due date. For next year,
      or for another client with the same paperwork.</p>
      ${live.length > 0
        ? html`<details class="rename">
            <summary>Keep this list for next time</summary>
            <form method="post" action="/requests/${found.id}/save-as-template" class="stack">
              <label for="template-name">What should the list be called?</label>
              <input id="template-name" name="name" maxlength="${MAX_TEMPLATE_NAME}" value="${found.title}">
              <div class="row tight"><button type="submit">Save as a template</button></div>
            </form>
            <p class="note">A template is a starting point you can use for one client or for everyone at once.
            It copies what is on this request now; the request itself is not changed, and changing the template
            later will not change this.</p>
          </details>`
        : ''}
      ${keys.length > 0 && received > 0
        ? html`<div class="unlock">
            <label for="passphrase">Your passphrase, to open what has arrived</label>
            <input id="passphrase" type="password" autocomplete="current-password">
            <button type="button" id="unlock">Unlock</button>
            <p id="unlock-status" class="note">It is used in this browser and sent nowhere. Unlocking
            keeps the keys in this tab so that saving several files does not mean typing it again.</p>
          </div>`
        : ''}
      <div class="scroll"><table class="items">
        <colgroup>
          <col class="c-doc"><col class="c-state"><col class="c-files"><col class="c-say">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Document</th>
            <th align="left">State</th>
            <th align="left">Files</th>
            <th align="left">What you can say</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${!found.closed_at
        ? html`<form method="post" action="/requests/${found.id}/items" class="card">
            <label for="new-items">Remembered something else? <span class="note">one document per line</span></label>
            <textarea id="new-items" name="items" rows="3" placeholder="The 2024 statements as well"></textarea>
            <button type="submit">Add to this request</button>
          </form>`
        : ''}
      ${withdrawn.length > 0
        ? html`<section class="card"><h2>No longer being asked for</h2>
            <ul>${withdrawn.map((item) => html`<li>${item.label}
              <form method="post" action="/requests/${found.id}/items/${item.id}/restore" class="inline">
                <button type="submit">Ask for it again</button>
              </form></li>`)}</ul>
            <p class="note">Withdrawn rather than deleted: the client's page stops asking, and the
            record keeps saying it was once asked for.</p></section>`
        : ''}
      <section class="card">
        <h2>The link for this client</h2>
        ${links.length === 0
          ? html`<p class="note">No link has been created yet. A link is how the client sends anything —
              they need no account, and it can be revoked at any time.</p>`
          : html`<ul class="plain">
              ${links.map((link) => html`<li>
                <span class="note">created ${link.created_at}, expires ${link.expires_at}</span>
                ${link.revoked_at
                  ? html` ${badge('revoked', TONES.done_for)}`
                  : html` <form method="post" action="/requests/${found.id}/revoke" class="inline">
                      <input type="hidden" name="token_id" value="${link.id}">
                      <button type="submit">Revoke</button>
                    </form>`}
              </li>`)}
            </ul>`}
        <form method="post" action="/requests/${found.id}/link" class="inline">
          <label for="days">A new link, valid for
            <select id="days" name="days">
              <option value="7">7 days</option>
              <option value="30" selected>30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <button type="submit">Create a link</button>
        </form>
      </section>
      <section class="card">
        <h2>Chasing this client</h2>
        ${outstanding.length > 0
          ? html`<p>${outstanding.length} still outstanding:
                ${outstanding.map((item) => item.label).join(', ')}.</p>
              <form method="post" action="/requests/${found.id}/remind" class="inline">
                <label for="remind-days">The reminder's link, valid for
                  <select id="remind-days" name="days">
                    <option value="7">7 days</option>
                    <option value="30" selected>30 days</option>
                    <option value="90">90 days</option>
                  </select>
                </label>
                <button type="submit">Draft a reminder</button>
              </form>`
          : html`<p><strong>Everything asked for has arrived.</strong> There is nothing to chase.</p>`}
        ${lastContact
          ? html`<p class="note">Last contact: ${agoWords(lastContact, now())}.</p>`
          : ''}

        <h3>Been in touch another way?</h3>
        <form method="post" action="/requests/${found.id}/contact" class="stack">
          <label for="contact-note">What happened? <span class="note">it goes in the record, and it is what stops the chase writing to them again</span></label>
          <input id="contact-note" name="note" maxlength="200" required
            placeholder="Phoned — Sarah says the statements are with the bank">
          <div class="row tight"><button type="submit">Record it</button></div>
        </form>
        <p class="note">A phone call, a letter, a conversation in the office — anything that is not an email from
        here. <strong>Nothing is sent and the client is not told:</strong> this is you making the record true, so the
        tool knows you have already spoken to them.</p>
      </section>
      ${messages.length > 0
        ? html`<section class="card">
            <h2>In the client's own words</h2>
            <p class="note">Written on their page, and kept with this request. Nothing here needs answering
            through this tool — it is here so the reason a document is late is beside the documents.</p>
            ${messages.map((event) => html`<div class="said">
              <p class="note"><span class="when">${event.at}</span></p>
              <p>${event.detail}</p>
            </div>`)}
          </section>`
        : ''}
      ${extras.length > 0
        ? html`<section class="card">
            <h2>Sent without being asked</h2>
            <p class="note">Files the client sent that are not on the checklist. They are encrypted the same
            way as everything else, and they answer nothing — so they do not count toward what is outstanding.</p>
            <div class="scroll"><table>
              <thead><tr><th align="left">File</th><th align="left">Arrived</th><th align="left">Open</th></tr></thead>
              <tbody>
                ${extras.map((upload) => html`<tr>
                  <td><span class="cell-t">${upload.filename}</span>
                    ${upload.client_note ? html`<span class="cell-s">${upload.client_note}</span>` : ''}</td>
                  <td class="note">${upload.uploaded_at}</td>
                  <td><a class="btn sm" href="/requests/${found.id}/files/${upload.id}">Download</a></td>
                </tr>`)}
              </tbody>
            </table></div>
          </section>`
        : ''}
      <section class="card">
        <h2>What has happened</h2>
        <ul class="plain">
          ${events.map((event) => html`<li><code>${event.kind}</code> <span class="note">${event.at}${event.detail ? ` — ${event.detail}` : ''}</span></li>`)}
        </ul>
      </section>
      <section class="card">
        <h2>The file itself</h2>
        ${found.closed_at
          ? html`<p>Closed ${found.closed_at}. It stays on the list of closed requests, and
                nothing has been deleted.</p>
              <div class="actions">
                <form method="post" action="/requests/${found.id}/reopen"><button type="submit">Reopen it</button></form>
              </div>`
          : html`<p class="note">Closing is a status, not a deletion: the record, the files and the
                client's link all stay exactly as they are.</p>
              <div class="actions">
                <form method="post" action="/requests/${found.id}/close"><button type="submit">Close this request</button></form>
              </div>`}
      </section>
      ${received > 0 && !holdsKey(practitioner.role)
        ? html`<p class="note"><strong>${received} ${received === 1 ? 'document has' : 'documents have'} arrived,
            and you cannot open ${received === 1 ? 'it' : 'them'}.</strong> Your role holds no copy of the
            practice key, so nothing here decrypts for you — that is what the role means rather than a
            setting somebody chose. An owner can make you a copy; it needs a passphrase from you, and it
            takes a moment on the members page.</p>`
        : ''}
      ${keys.length > 0 ? jsonTag('key-records', { keys: keys.map((key) => ({ id: key.id, wrapped: key.wrappedPrivateKey })) }) : ''}
      ${received > 0 && holdsKey(practitioner.role) ? raw('<script type="module" src="/assets/download.js"></script>') : ''}`,
  }));
}

/**
 * The board as a spreadsheet.
 *
 * This exists because of what the request actually is: an accountant reconciling a season works in a
 * spreadsheet, and a page that cannot be got out of the tool is a page they retype. It honours the same
 * filters as the page it comes from — same tab, same state, same search — because an export that ignores
 * the filter somebody just applied is an export they have to filter again by hand.
 *
 * What it carries is deliberately not everything: the counts that answer "what is outstanding" and the
 * dates that answer "what is late", in the order the screen shows them. Not the client's documents, not
 * the history, not anything the practice would not want in a file they might email to a colleague.
 */
export function requestsCsv({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const showingClosed = url.searchParams.get('closed') === '1';
  const wanted = url.searchParams.get('state');
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const sort = url.searchParams.get('sort') ?? 'state';

  const rows = requestsFor(db, practiceId, { scope: showingClosed ? 'closed' : 'open' })
    .filter((row) => !wanted || row.progress.state === wanted)
    .filter((row) =>
      query
        ? [row.client_name, row.title, row.client_email ?? ''].join(' ').toLowerCase().includes(query)
        : true,
    )
    .sort(REQUEST_ORDERS[sort] ?? REQUEST_ORDERS.state)
    .map((row) => [
      row.client_name,
      row.client_email ?? '',
      row.title,
      REQUEST_STATE_WORDS[row.progress.state] ?? row.progress.state,
      row.progress.items,
      row.progress.received,
      row.progress.outstanding,
      row.progress.toCheck,
      row.due_at ?? '',
      row.created_at.slice(0, 10),
      row.closed_at ? row.closed_at.slice(0, 10) : '',
    ]);

  return sendCsv(response, showingClosed ? 'tickmark-closed-requests.csv' : 'tickmark-requests.csv', [
    ['Client', 'Address', 'Request', 'State', 'Documents', 'Received', 'Outstanding', 'To check', 'Due', 'Asked', 'Closed'],
    ...rows,
  ]);
}

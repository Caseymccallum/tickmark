/**
 * The client records, and every document in one list.
 *
 * The half of the practice's side that is about *people and files* rather than about requests: the documents page
 * with its search and its CSV, the client directory, and one client's own record — the page the year-two workflow
 * starts from, because it is where the last checklist is carried forward. The tenth module to leave `app.js`, and
 * one of the four sections `docs/splitting.md` still had to move.
 *
 * Two things here are promises rather than features, and both are the kind a page has to state rather than keep
 * quiet about.
 *
 * 1. **The documents search reads metadata, never contents.** The server has never seen a document's contents —
 *    that is the whole design, and `docs/encryption.md` says so — which is why `filesPage` says what it searched
 *    and what it could not. A practice that finds nothing needs to tell *no such file* from *a search that cannot
 *    read*, and a page that stays quiet about the difference turns a limit into a suspicion. Every row is derived
 *    from columns the practice already owns: filename, client, request title, arrival, size, and the note a client
 *    left beside a file.
 * 2. **The list pages, and the export does not.** `FILES_PER_PAGE` is one screenful of scanning — every upload is a
 *    row forever, so this is the one list in the product that cannot grow without bound — and `filesCsv` and
 *    `clientsCsv` exist for the practice that reconciles a season in a spreadsheet, filtered exactly as the page on
 *    screen is.
 */
import { dateIn, monthIn } from './clock.js';
import { field, formFields, readBody } from './http.js';
import {
  clientFor,
  clientSummaries,
  clientsDueForAsking,
  filesForPractice,
  fileCountFor,
  history,
  progressForPractice,
  outstandingOf,
  practiceFor,
  previousChecklistFor,
  requestsForClient,
  updateClient,
} from './store.js';
import { TONES, badge, empty, fail, html, page, redirect, REQUEST_STATE_WORDS, requireSignIn, section, sendCsv, sendPage, stateTone, tile } from './views.js';

/**
 * How many documents the page draws at a time. The documents table is the one list here that grows
 * without bound — every upload is a row forever — so it is the one list that pages. A hundred is a
 * screenful of scanning; the CSV export gives the whole list for the spreadsheet case.
 */
const FILES_PER_PAGE = 100;

/**
 * Every document, in one list, with a box to look for one.
 *
 * **The search looks at what the server has, and the page is honest about that.** Filenames, clients, request
 * titles, and the note a client left beside a file — never the contents, because the server has never seen a
 * document's contents. Somebody typing "2024 statement" and finding nothing needs to know whether that is
 * because they have no such file or because the search cannot read, and a page that stays quiet about it turns a
 * limitation into a suspicion.
 *
 * What it is for is the search a practice does in May: *which client sent the thing I am thinking of*, *what did
 * they call it*, *when did it arrive*. All three are metadata, and all three are here.
 */
export function filesPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim();
  // One page of the newest, and a link for more — see `FILES_PER_PAGE`. One extra row is fetched to
  // know whether "more" is honest rather than hopeful.
  const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
  const files = filesForPractice(db, practiceId, { query, limit: FILES_PER_PAGE + 1, offset: from });
  const more = files.length > FILES_PER_PAGE;
  const shown = more ? files.slice(0, FILES_PER_PAGE) : files;
  const total = fileCountFor(db, practiceId);
  const practice = practiceFor(db, practiceId);

  const rows = shown.map((file) => html`<tr>
    <td>
      <span class="cell-t">${file.filename}</span>
      ${file.clientNote ? html`<span class="cell-s">they said: ${file.clientNote}</span>` : ''}
    </td>
    <td class="cell-t">${file.client}</td>
    <td>
      <a href="/requests/${file.requestId}">${file.title}</a>
      ${file.item
        ? html`<span class="cell-s">${file.item}</span>`
        : html`<span class="cell-s">sent without being asked</span>`}
    </td>
    <td class="note">${dateIn(practice?.timezone, new Date(file.uploadedAt))}</td>
    <td class="num note">${readableSize(file.sizeBytes)}</td>
    <td><a class="btn sm" href="/requests/${file.requestId}/files/${file.id}">Download</a></td>
  </tr>`);

  return sendPage(response, 200, page({
    title: 'Documents',
    practitioner,
    here: '/files',
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Documents</h1>
          <p class="sub">Everything clients have sent you, newest first. To ask for something, or to see what is
          still outstanding, the <a href="/requests">board</a> is the place for that.</p>
        </div>
        <div class="do">
          <a class="btn" href="/files.csv${query ? `?q=${encodeURIComponent(query)}` : ''}">Download as CSV</a>
        </div>
      </div>

      <form method="get" action="/files" class="card search-page">
        <input type="search" name="q" value="${query}" placeholder="A filename, a client, a request…"
          aria-label="Search documents" autofocus>
        <button type="submit">Search</button>
        ${query ? html`<a class="btn ghost sm" href="/files">Clear</a>` : ''}
        <p class="note"><strong>This searches the names, not the contents.</strong> The server has never seen
        inside a document — that is the whole point of the product — so it can find
        <code>statements-oct.pdf</code> and cannot find “the page with the overdraft on it”. Your own file names
        and the notes clients leave are what it has to work with.</p>
      </form>

      ${files.length === 0
        ? query
          ? empty(
              'Nothing matches that',
              html`No document, client or request matches “${query}”. Remember that this searches names rather than
              contents — try the client's name, or part of the filename.`,
              html`<a class="btn" href="/files">Show everything</a>`,
            )
          : empty(
              'No documents yet',
              'When a client sends something through a link, it appears here — and it stays searchable by name.',
              html`<a class="btn primary" href="/requests/new">Ask for something</a>`,
            )
        : html`
            <p class="note">${shown.length} ${shown.length === 1 ? 'document' : 'documents'}${query
              ? html` matching “${query}” of ${total} in total`
              : ''}.</p>
            <div class="scroll"><table class="wide">
              <colgroup>
                <col class="w30"><col class="w17"><col class="w23">
                <col class="w12"><col class="w8"><col class="w10">
              </colgroup>
              <thead><tr>
                <th align="left">File</th><th align="left">Client</th><th align="left">Request</th>
                <th align="left">Arrived</th><th align="right">Size</th><th align="left"></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table></div>
            ${more
              ? html`<p class="note">Showing ${from + 1}–${from + shown.length} of ${total}.
                  <a href="/files?q=${encodeURIComponent(query)}&amp;from=${from + FILES_PER_PAGE}">Show more</a>.</p>`
              : from > 0
                ? html`<p class="note">Showing ${from + 1}–${from + shown.length} of ${total}.
                    <a href="/files?q=${encodeURIComponent(query)}">Back to the newest</a>.</p>`
                : ''}`}`,
  }));
}

/** The same list as a spreadsheet, honouring the same search. */
export function filesCsv({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim();
  const practice = practiceFor(db, practiceId);

  return sendCsv(response, 'tickmark-documents.csv', [
    ['File', 'Client', 'Request', 'Document asked for', 'Arrived', 'Size (bytes)', 'Client note'],
    ...filesForPractice(db, practiceId, { query }).map((file) => [
      file.filename,
      file.client,
      file.title,
      file.item ?? 'sent without being asked',
      dateIn(practice?.timezone, new Date(file.uploadedAt)),
      file.sizeBytes,
      file.clientNote ?? '',
    ]),
  ]);
}

/** Bytes in the units a person reads, for a table where "1048576" is not an answer. */
function readableSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The practice's clients: who they work for, and what each one still owes.
 *
 * Until this page existed a client was only reachable *through* one of their requests, which meant the
 * answer to "who do I work for, and who is late?" was a request board read sideways. A practice has
 * clients; requests are what it does about them. The order of those two facts had stopped matching the
 * order of the screens.
 *
 * The address column is not decoration either: a client with no address is a client the chase cannot
 * write to, and the only way to notice that was to reach the chase and find them listed as
 * unreachable. Here it is a state, on the row, with a place to fix it.
 */
export function listClients({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim();
  // The counts are built once and handed to both callers below. `clientsDueForAsking` works by filtering the client
  // list, so without this it asked for the very same counts a second time — the same pattern the board had.
  const progress = progressForPractice(db, practiceId);
  const everyone = clientSummaries(db, practiceId, progress);
  const needle = query.toLowerCase();
  const timezone = practiceFor(db, practiceId).timezone;
  // Who is due is computed for the *whole* practice, not for what is on screen: the tile counts the work, and a
  // count that changed when somebody typed in the search box would be a count nobody could act on.
  const due = clientsDueForAsking(db, practiceId, { timezone, progress, clients: everyone });
  const dueIds = new Set(due.map((row) => row.id));
  const onlyDue = url.searchParams.get('due') === '1';

  const searched = needle
    ? everyone.filter((row) => `${row.name} ${row.email ?? ''}`.toLowerCase().includes(needle))
    : everyone;
  const rows = onlyDue ? searched.filter((row) => dueIds.has(row.id)) : searched;
  const owing = rows.filter((row) => row.progress.outstanding > 0);
  const noAddress = rows.filter((row) => !row.email);
  const justSaved = url.searchParams.get('saved');

  const table = rows.length === 0
    ? empty(
        query
          ? `Nothing matches “${query}”`
          : onlyDue
            ? 'Nobody is due an ask this month'
            : 'No clients yet',
        query
          ? html`The search looks at the name and the address. <a href="/clients">Clear it</a> to see everyone again.`
          : onlyDue
            ? html`This list is the clients nothing is open for whose last ask was in this month of an earlier
                year. Either nobody is on an annual cycle that comes round now, or everybody has already been
                asked. <a href="/clients">Show everyone</a>.`
            : 'A client appears here the first time you ask them for something — type a name on a new request and they are kept.',
        query || onlyDue ? null : html`<a class="btn primary" href="/requests/new">New request</a>`,
      )
    : html`<div class="scroll"><table class="clients">
        <colgroup>
          <col class="c-name"><col class="c-mail"><col class="c-open">
          <col class="c-out"><col class="c-reminded"><col class="c-do">
        </colgroup>
        <thead>
          <tr>
            <th align="left">Client</th>
            <th align="left">Address</th>
            <th align="right">Open</th>
            <th align="right">Outstanding</th>
            <th align="left">Last contact</th>
            <th align="left"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`<tr>
            <td>
              <a class="cell-t" href="/clients/${row.id}">${row.name}</a>
              ${dueIds.has(row.id)
                ? html`<span class="cell-s">last asked ${dateIn(timezone, new Date(row.last_request_at))}</span>`
                : row.closed_requests > 0
                  ? html`<span class="cell-s">${row.open_requests} open · ${row.closed_requests} closed</span>`
                  : ''}
            </td>
            <td>${row.email
              ? row.email
              : html`${badge('no address', TONES.wrong)}`}</td>
            <td align="right">${row.open_requests === 0
              ? html`<span class="muted">—</span>`
              : row.open_requests}</td>
            <td align="right">${row.progress.outstanding === 0
              ? html`<span class="muted">—</span>`
              : html`<strong>${row.progress.outstanding}</strong>`}</td>
            <td>${row.last_contact_at
              ? html`<span class="muted">${dateIn(timezone, new Date(row.last_contact_at))}</span>`
              : html`<span class="muted">never</span>`}</td>
            <td>
              <a class="btn sm" href="/requests/new?for=${row.id}">New request</a>
            </td>
          </tr>`)}
        </tbody>
      </table></div>`;

  return sendPage(response, 200, page({
    title: 'Clients',
    practitioner,
    here: '/clients',
    banner: justSaved
      ? html`<p class="success"><strong>Saved.</strong> ${justSaved} is what this practice will call them
          from now on, and every request of theirs moves with the record.</p>`
      : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Clients</h1>
          <p class="sub">Everyone this practice asks for documents, and what each of them still owes.</p>
        </div>
        <div class="do">
          <a class="btn primary" href="/requests/new">New request</a>
        </div>
      </div>
      <div class="bar">
        ${everyone.length === 0
          ? ''
          : html`<form class="search" method="get" action="/clients">
              <input type="search" name="q" value="${query}" placeholder="Name or address"
                aria-label="Search clients">
              <button type="submit">Search</button>
              ${query ? html`<a class="clear" href="/clients">Clear</a>` : ''}
            </form>`}
      </div>
      ${query
        ? html`<p class="note">${rows.length} ${rows.length === 1 ? 'client' : 'clients'} matching
            “${query}” · <a href="/clients.csv${query ? `?q=${encodeURIComponent(query)}` : ''}">Download as CSV</a></p>`
        : everyone.length > 0
          ? html`<p class="note"><a href="/clients.csv">Download as CSV</a> — everyone, with what each of
              them still owes.</p>`
          : ''}
      ${rows.length === 0
        ? ''
        : html`<div class="tiles">
            ${tile(rows.length, rows.length === 1 ? 'client' : 'clients')}
            ${due.length > 0
              ? tile(due.length, 'due to be asked', {
                  href: '/clients?due=1',
                  tone: 'attn',
                  current: onlyDue,
                })
              : tile(0, 'due to be asked')}
            ${owing.length > 0
              ? tile(owing.length, 'still owe something', { href: '/chase', tone: 'attn' })
              : tile(0, 'still owe something')}
            ${noAddress.length > 0
              ? tile(noAddress.length, 'with no address', { tone: 'warn' })
              : tile(0, 'missing an address')}
          </div>`}
      ${onlyDue && rows.length > 0
        ? html`<div class="card">
            <h2>The year coming round</h2>
            <p>These ${rows.length === 1 ? 'is a client' : 'are clients'} nothing is open for, whose last ask was in
            <strong>${monthIn(timezone)}</strong> of an earlier year — so this is the month they were asked last
            time. That is the whole rule: no cycle length to configure, and the list empties itself as you ask each
            one, because an open request takes them off it.</p>
            <p class="note">Nothing here has been sent, and nothing will be without you pressing a button: the next
            step shows every client and every address before anything leaves the building.</p>
            <div class="actions">
              <a class="btn primary" href="/ask-everyone?due=1">Ask them all again</a>
              <a class="btn" href="/clients">Show everyone</a>
            </div>
          </div>`
        : ''}
      ${noAddress.length > 0
        ? html`<p class="note">A client with no address is left out of every reminder — open one and add
            it. The chase names them rather than dropping them quietly, but an address is faster.</p>`
        : ''}
      ${table}`,
  }));
}

/**
 * The directory as a spreadsheet: who the practice works for, and what each one owes.
 *
 * Same reasoning as the board's export, and the same filters: a practice reconciling a season works in a
 * spreadsheet, and the list they want to sort by their own column is the one with the counts on it.
 */
export function clientsCsv({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const rows = clientSummaries(db, practiceId)
    .filter((row) => (query ? `${row.name} ${row.email ?? ''}`.toLowerCase().includes(query) : true))
    .map((row) => [
      row.name,
      row.email ?? '',
      row.open_requests,
      row.closed_requests,
      row.progress.outstanding,
      row.last_contact_at ? row.last_contact_at.slice(0, 10) : '',
      row.created_at.slice(0, 10),
    ]);

  return sendCsv(response, 'tickmark-clients.csv', [
    ['Client', 'Address', 'Open requests', 'Closed requests', 'Outstanding', 'Last contact', 'First asked'],
    ...rows,
  ]);
}

/**
 * Save a client's name and address.
 *
 * The name is required because a client with no name cannot be found in the list, and the address is
 * optional because plenty of clients are only ever chased by phone — but clearing it is a decision
 * made here, on purpose, which is why an empty field on *this* form clears it while an empty field on
 * a request form does not.
 *
 * A name that is already taken by another client is refused rather than merged. Two records with one
 * name is how a request ends up filed against the wrong one, and merging is a decision about which
 * history survives — not something to do silently because somebody typed a name that matched.
 */
export async function saveClient({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = clientFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no client at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const name = (field(fields, 'name') ?? '').trim();
  const email = (field(fields, 'email') ?? '').trim();
  if (!name) return fail(response, 400, 'A client needs a name.', practitioner);
  if (name.length > 200) return fail(response, 400, 'That name is longer than 200 characters.', practitioner);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(response, 400, 'That does not look like an email address.', practitioner);
  }

  const clash = db
    .prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(practiceId, name, found.id);
  if (clash) {
    return fail(
      response,
      400,
      `There is already a client called ${name}. Two records with one name is how a request ends up filed against the wrong one — rename this one, or use the other.`,
      practitioner,
    );
  }

  updateClient(db, { practiceId, clientId: found.id, name, email: email || null });
  return redirect(response, `/clients/${found.id}?saved=1`);
}

/**
 * One client: who they are, everything asked of them, and the two things a practice does about them.
 *
 * The reuse is the point of the page. "The same as last year" is the year-two workflow, and it is why
 * the new-request button carries the client with it and offers their most recent checklist — the
 * biggest repeat cost in the research was the same list rebuilt from scratch every January.
 */
export function viewClient({ db, response, practitioner, params, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = clientFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no client at that address.', practitioner);

  const requests = requestsForClient(db, practiceId, found.id);
  const open = requests.filter((row) => !row.closed_at);
  const closed = requests.filter((row) => row.closed_at);
  const wanted = open.reduce((total, row) => total + outstandingOf(db, row.id).length, 0);
  const previous = previousChecklistFor(db, practiceId, found.id);
  const justSaved = url.searchParams.get('saved');

  const rowFor = (request) => html`<tr>
    <td><a class="cell-t" href="/requests/${request.id}">${request.title}</a></td>
    <td>${request.closed_at
      ? badge('closed', TONES.done_for)
      : badge(REQUEST_STATE_WORDS[request.progress.state], stateTone(request.progress.state))}</td>
    <td align="right">${request.progress.received} / ${request.progress.items}</td>
    <td>${request.due_at ?? html`<span class="muted">no date</span>`}</td>
    <td><span class="muted">${request.created_at.slice(0, 10)}</span></td>
  </tr>`;

  return sendPage(response, 200, page({
    title: found.name,
    practitioner,
    here: '/clients',
    banner: justSaved ? html`<p class="success"><strong>Saved.</strong></p>` : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/clients">Clients</a></p>
          <h1>${found.name}</h1>
          <p class="sub">${found.email ?? 'No address yet — reminders cannot be sent to them'}</p>
        </div>
        <div class="do">
          <a class="btn primary" href="/requests/new?for=${found.id}">New request</a>
        </div>
      </div>
      ${requests.length > 0
        ? html`<div class="tiles">
            ${tile(open.length, open.length === 1 ? 'open request' : 'open requests')}
            ${tile(wanted, 'still outstanding', { tone: wanted > 0 ? 'attn' : null })}
            ${tile(closed.length, closed.length === 1 ? 'closed request' : 'closed requests')}
          </div>`
        : ''}
      ${requests.length === 0
        ? empty(
            `${found.name} has nothing outstanding`,
            'Ask them for something and everything they send appears here, with the requests they have had before.',
            html`<a class="btn primary" href="/requests/new?for=${found.id}">Ask for documents</a>`,
          )
        : html`<section class="card">
            <h2>Everything asked of them</h2>
            <div class="scroll"><table class="items">
              <colgroup>
                <col class="c-title"><col class="c-state"><col class="c-received">
                <col class="c-due"><col class="c-asked">
              </colgroup>
              <thead>
                <tr>
                  <th align="left">Request</th>
                  <th align="left">State</th>
                  <th align="right">Received</th>
                  <th align="left">Due</th>
                  <th align="left">Asked</th>
                </tr>
              </thead>
              <tbody>${requests.map(rowFor)}</tbody>
            </table></div>
          </section>`}
      <section class="card">
        <h2>Their details</h2>
        <form method="post" action="/clients/${found.id}">
          <div class="field">
            <label for="name">What this practice calls them</label>
            <input id="name" name="name" required maxlength="200" value="${found.name}">
            <p class="form-hint">Fixing a typo here moves every request of theirs with it — which is why
            a client typed twice by mistake is a thing you can repair rather than live with.</p>
          </div>
          <div class="field">
            <label for="email">Their address <span class="note">for reminders</span></label>
            <input id="email" name="email" type="email" value="${found.email ?? ''}">
            <p class="form-hint">Leave it empty to remove the address: reminders then name them as
            unreachable rather than being sent nowhere.</p>
          </div>
          <button type="submit">Save</button>
        </form>
      </section>
      ${previous.items.length > 0
        ? html`<section class="card">
            <h2>Last time they were asked</h2>
            <p class="note">${previous.title ?? 'A previous request'} asked for
            ${previous.items.length} ${previous.items.length === 1 ? 'document' : 'documents'}:</p>
            <ul class="plain">${previous.items.map((label) => html`<li>${label}</li>`)}</ul>
            <div class="actions">
              <a class="btn" href="/requests/new?for=${found.id}&amp;like=last">Start one like this</a>
            </div>
          </section>`
        : ''}`,
  }));
}

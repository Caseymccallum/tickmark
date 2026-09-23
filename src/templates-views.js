/**
 * The templates a practice reuses, and the one page that closes several requests at once.
 *
 * The eleventh module to leave `app.js`, and one of the three sections `docs/splitting.md` had left to move: the
 * templates pages and the lists they keep — make one, rename it, add to it, take something off it, delete it, start a
 * request from it — plus `closeSeveral`, which sits here rather than beside the requests because it is the same shape
 * of page: a list of things to tick, and one button at the bottom.
 *
 * Two things are load-bearing.
 *
 * 1. **A template is a starting point, not a record.** A request copies its items at the moment it is made and nothing
 *    ever refers back, which is why this is the one thing in the product that can be deleted outright: deleting a
 *    template discards a draft, and cannot change what any client was ever asked for.
 * 2. **The first template usually comes from a request** — `saveAsTemplate` is how — because nobody retypes forty lines
 *    in order to stop retyping forty lines.
 */
import { field, formFields, parseItems, readBody } from './http.js';
import {
  MAX_TEMPLATE_NAME,
  addTemplateItems,
  clientSummaries,
  closeRequest,
  createTemplate,
  deleteTemplate,
  removeTemplateItem,
  renameTemplate,
  templateFor,
  templateItemsOf,
  templatesOf,
  itemsOf,
  requestFor,
  requestsFor,
} from './store.js';
import { badge, empty, fail, html, page, redirect, REQUEST_STATE_WORDS, requireSignIn, section, sendPage, stateTone } from './views.js';

// ---------------------------------------------------------------------------------
// Templates — the lists a practice uses every year
// ---------------------------------------------------------------------------------

/**
 * Every request in this product used to be built from nothing, which is fine the first time and absurd the
 * fifty-first: the same forty document names, typed again, for the fifty-first client.
 *
 * A template is that list given a name and kept. It is a *starting point* rather than a record — a request
 * copies its items at the moment it is made, and nothing ever refers back — which is why this is the one
 * thing in the product that can be deleted outright. Deleting a template discards a draft; it cannot change
 * what any client was ever asked for.
 *
 * Templates are made here, or from a request that already has the right list on it, which is how the first
 * one usually appears: nobody retypes forty lines in order to stop retyping forty lines.
 */
export function templatesPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const templates = templatesOf(db, practiceId);
  const made = url.searchParams.get('made');
  const removed = url.searchParams.get('removed');
  const reachable = clientSummaries(db, practiceId).filter((client) => client.email).length;

  return sendPage(response, 200, page({
    title: 'Templates',
    practitioner,
    here: '/templates',
    banner: made
      ? html`<p class="success"><strong>Saved.</strong> Use it for one client, or ask everyone at once.</p>`
      : removed
        ? html`<p class="success"><strong>Deleted.</strong> Requests already made from it are untouched — they
            copied what they needed at the time.</p>`
        : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a></p>
          <h1>Lists you use again</h1>
          <p class="sub">A checklist kept under a name, so the same request is not typed out for every client.</p>
        </div>
        <div class="do">
          ${reachable > 0
            ? html`<a class="btn primary" href="/ask-everyone">Ask everyone at once</a>`
            : html`<a class="btn" href="/clients">Add a client first</a>`}
        </div>
      </div>

      ${templates.length === 0
        ? empty('No templates yet', 'Make one below — or open a request and save its list, which is less typing if the list already exists.')
        : html`<div class="scroll"><table>
            <thead><tr>
              <th class="w34">Name</th>
              <th class="w10">Documents</th>
              <th class="w30">Standing note</th>
              <th class="num w26">Use it</th>
            </tr></thead>
            <tbody>
              ${templates.map((template) => html`<tr>
                <td><a class="cell-t" href="/templates/${template.id}">${template.name}</a></td>
                <td><span class="badge off">${template.item_count}</span></td>
                <td>${template.note ? html`<span class="cell-s">${template.note}</span>` : html`<span class="muted">—</span>`}</td>
                <td class="num">
                  <a class="btn sm" href="/requests/new?template=${template.id}">One client</a>
                  <a class="btn sm" href="/ask-everyone?template=${template.id}">Everyone</a>
                </td>
              </tr>`)}
            </tbody>
          </table></div>`}

      ${section('Save a new list', html`
        <form method="post" action="/templates" class="card">
          <label for="name">What is it called?</label>
          <input id="name" name="name" maxlength="${MAX_TEMPLATE_NAME}" required
            placeholder="Sole trader — annual accounts">
          <label for="items">The documents, one per line</label>
          <textarea id="items" name="items" rows="8" required
            placeholder="Photo ID&#10;Bank statements, all accounts&#10;Last year's return"></textarea>
          <label for="note">A standing note to the client <span class="note">(optional — editable per client)</span></label>
          <input id="note" name="note" maxlength="2000" placeholder="Please send these by the end of the month.">
          <div class="actions"><button type="submit" class="primary">Save this list</button></div>
        </form>`)}
    `,
  }));
}

/** Make a template from a typed list. */
export async function createTemplatePage({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const name = (field(fields, 'name') ?? '').trim();
  const note = (field(fields, 'note') ?? '').trim() || null;
  const items = parseItems(field(fields, 'items') ?? '');

  if (name.length === 0) return fail(response, 400, 'A template needs a name so it can be found again.', practitioner);
  if (name.length > MAX_TEMPLATE_NAME) {
    return fail(response, 400, `That name is longer than ${MAX_TEMPLATE_NAME} characters.`, practitioner);
  }
  if (items.length === 0) return fail(response, 400, 'A template needs at least one document, one per line.', practitioner);

  const id = createTemplate(db, { practiceId, createdBy: practitioner.id, name, note, items });
  return redirect(response, `/templates/${id}`);
}

/** One template: what is on it, what it is called, and how to get rid of it. */
export function templatePage({ db, response, practitioner, practiceId, params, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = templateFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no list at that address.', practitioner);
  const added = url.searchParams.get('added');
  const reachable = clientSummaries(db, practiceId).filter((client) => client.email).length;

  return sendPage(response, 200, page({
    title: found.name,
    practitioner,
    here: '/templates',
    banner: added === null
      ? null
      : added === '0'
        ? html`<p class="warning">Everything on that list was already on this one, so nothing was added.</p>`
        : html`<p class="success">${added} ${added === '1' ? 'document' : 'documents'} added.</p>`,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/templates">Templates</a></p>
          <h1>${found.name}</h1>
          <p class="sub">${found.items.length}
            ${found.items.length === 1 ? 'document' : 'documents'}, kept to be used again</p>
        </div>
        <div class="do">
          <a class="btn" href="/requests/new?template=${found.id}">Use for one client</a>
          ${reachable > 0 ? html`<a class="btn primary" href="/ask-everyone?template=${found.id}">Ask everyone</a>` : ''}
        </div>
      </div>

      ${section('What it asks for', html`
        ${found.items.length === 0
          ? empty('Nothing on it yet', 'Add the documents below, one per line.')
          : html`<div class="scroll"><table>
              <thead><tr><th class="w78">Document</th><th class="num w22">Remove</th></tr></thead>
              <tbody>
                ${found.items.map((item) => html`<tr>
                  <td><span class="cell-t">${item.label}</span>${item.note ? html`<span class="cell-s">${item.note}</span>` : ''}</td>
                  <td class="num">
                    <form method="post" action="/templates/${found.id}/items/${item.id}/remove" class="inline">
                      <button type="submit" class="sm danger">Remove</button>
                    </form>
                  </td>
                </tr>`)}
              </tbody>
            </table></div>`}
        <form method="post" action="/templates/${found.id}/items" class="stack">
          <label for="items">Add documents, one per line</label>
          <textarea id="items" name="items" rows="4" placeholder="Payroll summary&#10;VAT returns"></textarea>
          <div class="actions"><button type="submit">Add them</button></div>
        </form>`)}

      ${section('Its name and standing note', html`
        <form method="post" action="/templates/${found.id}">
          <label for="name">Name</label>
          <input id="name" name="name" value="${found.name}" maxlength="${MAX_TEMPLATE_NAME}" required>
          <label for="note">A standing note to the client <span class="note">(a starting point, editable per client)</span></label>
          <input id="note" name="note" value="${found.note ?? ''}" maxlength="2000"
            placeholder="Please send these by the end of the month.">
          <div class="actions"><button type="submit" class="primary">Save</button></div>
        </form>
        <form method="post" action="/templates/${found.id}/delete">
          <p class="note">Deleting a template does not touch a single request made from it — those copied what
          they needed when they were made.</p>
          <div class="actions"><button type="submit" class="danger">Delete this template</button></div>
        </form>`)}
    `,
  }));
}

/** Rename a template, or change its standing note. */
export async function saveTemplate({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = templateFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no list at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const name = (field(fields, 'name') ?? '').trim();
  if (name.length === 0) return fail(response, 400, 'A template needs a name.', practitioner);
  if (name.length > MAX_TEMPLATE_NAME) {
    return fail(response, 400, `That name is longer than ${MAX_TEMPLATE_NAME} characters.`, practitioner);
  }
  if ((field(fields, 'note') ?? '').length > 2000) {
    return fail(response, 400, 'That note is longer than 2000 characters.', practitioner);
  }

  renameTemplate(db, practiceId, found.id, { name, note: field(fields, 'note') ?? '' });
  return redirect(response, `/templates/${found.id}`);
}

/** Grow a template's list. */
export async function addTemplateItemsPage({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = templateFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no list at that address.', practitioner);

  const fields = formFields(await readBody(request));
  const labels = parseItems(field(fields, 'items') ?? '');
  const added = addTemplateItems(db, { templateId: found.id, labels });
  return redirect(response, `/templates/${found.id}?added=${added}`);
}

/** Take one document off a template. The row goes; nothing points at it. */
export function removeTemplateItemPage({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  if (!removeTemplateItem(db, practiceId, params[0], params[1])) {
    return fail(response, 404, 'There is no such document on that list.', practitioner);
  }
  return redirect(response, `/templates/${params[0]}`);
}

/** Delete a template outright — the one place in the product that really removes a row. */
export function deleteTemplatePage({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  if (!deleteTemplate(db, practiceId, params[0])) {
    return fail(response, 404, 'There is no list at that address.', practitioner);
  }
  return redirect(response, '/templates?removed=1');
}

/**
 * Save the list already on a request as a template.
 *
 * This is how the first template usually appears. A practice that has just built a good checklist by hand has
 * no reason to type it out again in another page, and a template that has to be retyped is a template nobody
 * makes.
 */
export async function saveAsTemplate({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;
  const found = requestFor(db, practiceId, params[0]);
  if (!found) return fail(response, 404, 'There is no request at that address.', practitioner);

  const items = itemsOf(db, found.id).filter((item) => !item.withdrawn);
  if (items.length === 0) {
    return fail(response, 400, 'There is nothing on this request to save.', practitioner);
  }

  const fields = formFields(await readBody(request));
  const typed = (field(fields, 'name') ?? '').trim();
  const id = createTemplate(db, {
    practiceId,
    createdBy: practitioner.id,
    // The request's own title is the obvious name, and it is what the practice would have typed anyway.
    name: (typed || found.title).slice(0, MAX_TEMPLATE_NAME),
    note: found.client_note,
    items: items.map((item) => item.label),
  });

  // The notes on individual documents come across too — they are as much a part of the list as the labels are,
  // and a template that quietly dropped them would ask for the right documents with none of the guidance.
  for (const item of items) {
    if (!item.note) continue;
    const made = templateItemsOf(db, id).find((row) => row.label === item.label);
    if (made) db.prepare('UPDATE template_item SET note = ? WHERE id = ?').run(item.note, made.id);
  }

  return redirect(response, `/templates/${id}?made=1`);
}

/**
 * Closing a season, rather than one request at a time.
 *
 * Everything else in this product can be done in a batch — chase everyone, filter the board, export the list —
 * and closing was the last one-at-a-time operation in the year's cycle, which is exactly the moment when there
 * are forty of them and no patience left.
 *
 * **The software suggests; the practice decides.** The ones with nothing outstanding are ticked already,
 * because a request where every document has arrived and been checked is finished by the product's own
 * definition. The rest are listed unticked with what is still missing, because "close the year" is not the
 * same as "abandon what is outstanding" and the difference should be a deliberate tick rather than a
 * side-effect of pressing a button.
 */
export function closeSeveralPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const open = requestsFor(db, practiceId, { scope: 'open' });
  const finished = open.filter((row) => row.progress.state === 'ready');
  const rest = open.filter((row) => row.progress.state !== 'ready');
  const justClosed = url.searchParams.get('closed');
  const nothingDone = url.searchParams.get('nothing') === '1';

  const pick = (row) => html`<label>
    <input type="checkbox" name="request_id" value="${row.id}"${row.progress.state === 'ready' ? ' checked' : ''}>
    <span>
      <span class="what">${row.title}</span>
      <span class="who">${row.client_name} · ${badge(
        REQUEST_STATE_WORDS[row.progress.state],
        stateTone(row.progress.state),
      )}${
        row.progress.state === 'ready'
          ? ''
          : html` ${row.progress.outstanding} still outstanding, ${row.progress.toCheck} to check`
      }</span>
    </span>
  </label>`;

  return sendPage(response, 200, page({
    title: 'Close several requests',
    practitioner,
    here: '/requests',
    banner: justClosed
      ? html`<p class="success"><strong>${justClosed} closed.</strong> Nothing was deleted — they are on the
          closed tab, the clients' links still work, and any of them can be reopened from its own page.</p>`
      : nothingDone
        ? html`<p class="warning"><strong>Nothing was ticked</strong>, so nothing was closed. That is worth
            saying rather than doing something surprising.</p>`
        : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <p class="crumbs"><a href="/requests">Requests</a></p>
          <h1>Close several at once</h1>
          <p class="sub">The end of a season, done in one go. Closing is a status, not a deletion: the record,
          the files and each client's link all stay exactly as they are.</p>
        </div>
      </div>
      ${open.length === 0
        ? empty('Nothing is open', 'Every request is already closed.', html`<a class="btn" href="/requests">Back to the board</a>`)
        : html`<form method="post" action="/requests/close" class="card">
            <h2>Tick the ones that are finished</h2>
            ${finished.length > 0
              ? html`<p class="note">${finished.length}
                  ${finished.length === 1 ? 'request has' : 'requests have'} nothing outstanding, so
                  ${finished.length === 1 ? 'it is' : 'they are'} ticked already.</p>`
              : ''}
            <div class="pick">${finished.map(pick)}</div>
            ${rest.length > 0
              ? html`<h3>Still owed something</h3>
                  <p class="note">Closing these stops the chase for them. If a document is on its way, leave
                  the request open — it can always be closed later.</p>
                  <div class="pick">${rest.map(pick)}</div>`
              : ''}
            <div class="actions">
              <button type="submit" class="primary">Close the ticked requests</button>
              <a class="btn ghost" href="/requests">Cancel</a>
            </div>
          </form>`}`,
  }));
}

/** Close whichever requests were ticked, and report how many rather than doing it quietly. */
export async function closeSeveral({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const ticked = Array.isArray(fields.request_id) ? fields.request_id : fields.request_id ? [fields.request_id] : [];

  let closed = 0;
  for (const id of ticked) {
    // One at a time through the single-request path, so each request records its own event and the bulk
    // route cannot drift from the individual one. `closeRequest` refuses one already closed, which is why
    // the count is what the function returns rather than the length of the list.
    if (closeRequest(db, practiceId, id)) closed += 1;
  }

  return redirect(response, closed > 0 ? `/requests/close?closed=${closed}` : '/requests/close?nothing=1');
}

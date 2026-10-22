import { html, page, sendPage } from '../src/views.js';

/** A small private-mode guide rendered by the regular app page shell. */
export function demoGuide(paths) {
  return async (request, response, url) => {
    if (request.method !== 'GET' || url.pathname !== '/demo') return false;
    const body = html`<section class="card"><p class="eyebrow">FICTIONAL DATA · PRIVATE LOCAL DEMO</p>
      <h1>Welcome to the Tickmark demonstration</h1>
      <p>Every practice, person and document here is fictional. This local instance has no email, SMS or billing connection.</p>
      <ol>
        <li><a href="${paths.board}">Open the practice request board</a> to see requests waiting on a client and files awaiting review.</li>
        <li><a href="${paths.review}">Review Rowan Northstar’s arrival</a>, then use the real review action to accept it.</li>
        <li><a href="${paths.clientUpload}">Open Morgan Meadow’s client link</a> and select one of the fictional PDFs in the demo folder. The client page uses Tickmark’s normal browser encryption before upload.</li>
        <li>Return to <a href="${paths.board}">the practice board</a>, open Morgan’s request, and review the new arrival. Its request history records the arrival and review.</li>
        <li><a href="${paths.newRequest}">Create a request</a> using another fictional name. The production request flow creates the client and checklist.</li>
        <li><a href="${paths.chase}">Preview reminders</a>; this demo has no external mail or SMS provider. <a href="${paths.templates}">Templates</a> are available in the workspace navigation.</li>
      </ol>
      <p><a href="${paths.completed}">See a completed example</a> · <a href="${paths.overdue}">See an overdue replacement request</a>.</p>
    </section>`;
    sendPage(response, 200, page({ title: 'Fictional local demonstration', body, signIn: true }));
    return true;
  };
}

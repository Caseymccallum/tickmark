/**
 * The client's side: the page behind a link, and everything a client can do on it.
 *
 * **The second step of the split `docs/audit.md` §3 proposes** — the one it describes as "~600 lines, touched by five
 * routes". Who the caller is here is unusual for this codebase: none of it is authenticated. The token in the path is
 * the whole of the authorization — 256 random bits, stored only as a digest — which is why the page says outright
 * that whoever holds the link can upload, and why the checks that matter are about the *shape* of what arrives
 * (`acceptEnvelope`) rather than about who sent it.
 *
 * This is the file closest to the product's central claim, and it enforces it on the way in: the envelope check reads
 * only the head of what was just written, and the key check records which key sealed it. Both are **one
 * implementation for both kinds of upload**, because a second copy would be a second place for "the server stores
 * bytes it cannot read" to become false — and a document nobody asked for is not a lesser case of that.
 *
 * Deliberately *not* here: the practice's own pages for the same documents. Opening a file, checking it off and
 * replacing it are the signed-in surface, and they stay in `src/app.js`.
 */
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { readHead } from './blobs.js';
import { dateIn } from './clock.js';
import { newId, now } from './db.js';
import { field, formFields, originOf, readBody, spoolBody } from './http.js';
import { notifyPracticeOfChange } from './notices.js';
import {
  MAX_CLIENT_MESSAGE,
  history,
  itemInRequest,
  itemsOf,
  practiceFor,
  recordClientMessage,
  recordUpload,
  setClientSays,
  tokenLookup,
  uploadsOf,
} from './store.js';
import { TONES, badge, empty, fail, html, jsonTag, page, raw, redirect, sendJson, sendPage } from './views.js';
// The envelope format, so that the server can tell an encrypted upload from a plaintext one — which is the whole of
// what it can do with it. It cannot use the rest of that module: the key needed to open an envelope is wrapped under
// a passphrase this process has never seen.
import { ENVELOPE_VERSION, HEADER_BYTES, readEnvelope } from '../web/tickmark-crypto.js';

/**
 * What a client can say instead of nothing.
 *
 * A client who cannot produce a document is otherwise stuck: they can upload a file or they can go
 * quiet, and going quiet is indistinguishable from not having read the request. These two sentences give
 * them a third option, and they are stored in the client's own words alongside the label.
 */
const CLIENT_SAYS = {
  'send-later': 'I will send this later',
  'do-not-have': 'I do not have this',
};

/**
 * The client's page. No account, no session — the token in the path is the whole of the
 * authorization, which is why it is 256 random bits and why only its digest is stored.
 */
export function clientPage({ db, response, params, maxUploadBytes, url }) {
  const found = tokenLookup(db, params[0]);

  if (found.state === 'expired') {
    return sendPage(response, 410, page({
      signIn: false,
      title: 'This link has expired',
      body: html`<h1>This link has expired</h1>
        <p>Ask the practice to send a new one — they can make one in a moment.</p>`,
    }));
  }
  if (found.state === 'revoked') {
    return sendPage(response, 410, page({
      signIn: false,
      title: 'This link has been cancelled',
      body: html`<h1>This link has been cancelled</h1>
        <p>Ask whoever sent it to you for a new one.</p>`,
    }));
  }
  if (found.state === 'unknown') {
    return sendPage(response, 404, page({
      signIn: false,
      title: 'No such link',
      body: html`<h1>No such link</h1>
        <p>Check the address you were sent: it may have wrapped across two lines in an
        email, or lost a character on the way.</p>`,
    }));
  }

  const open = found.request;
  // Who is asking. A client who has never heard of Tickmark and has just been emailed a link by an unknown
  // address needs the practice's name in front of them before the list — otherwise the page they land on
  // says "Documents requested" and never says by whom, which is exactly what a phishing page says.
  const practice = practiceFor(db, open.practice_id);
  // Withdrawn items are not asked for. They stay visible to the practice — the request page shows them
  // — but a client asked again for something the practice has stopped wanting is a client who stops
  // trusting the list.
  const items = itemsOf(db, open.id).filter((item) => !item.withdrawn);

  // What the client has already sent, by name and date. This is a **receipt**, and it is here because of
  // the question it answers: "did you get it?" is the phone call this page exists to prevent, and the
  // person best placed to answer it is the one holding the link. They chose the filenames, so showing
  // them back is not a disclosure — it is their own message returning to them.
  const answers = new Map();
  const extras = [];
  for (const upload of uploadsOf(db, open.id)) {
    // An upload with no item is the client's own document — something nobody asked for. It goes in a list of
    // its own rather than beside a checklist line, because it is not an answer to anything.
    if (upload.request_item_id === null) {
      extras.push(upload);
      continue;
    }
    const list = answers.get(upload.request_item_id) ?? [];
    list.push(upload);
    answers.set(upload.request_item_id, list);
  }
  const received = items.filter((item) => (answers.get(item.id) ?? []).length > 0).length;

  // What the client has said in their own words, newest last, so the page shows them the message they sent
  // rather than only telling the practice about it. Same reasoning as the receipt above.
  const said = history(db, open.id).filter((event) => event.kind === 'client.messaged');

  // What the browser is allowed to compare a newly picked file against. Deliberately **name, size and date
  // only** — the three facts this page already shows the client on the rows below, so the check discloses
  // nothing that was not already on the screen. A hash of the contents would catch more and is the one thing
  // this product will not hold; the reasoning is in web/preflight.js, and there is a test that fails if a hash
  // ever appears in this payload.
  const alreadySent = [...answers.values(), ...extras.map((upload) => [upload])]
    .flat()
    .map((upload) => ({
      name: upload.filename,
      bytes: upload.size_bytes,
      at: dateIn(practice?.timezone, new Date(upload.uploaded_at)),
    }));

  if (!open.practice_public_key) {
    return sendPage(response, 503, page({
      signIn: false,
      title: 'This link is not ready',
      body: html`<h1>This link is not ready</h1>
        <p>The practice has not finished setting up its encryption key, so there is nothing to
        encrypt your documents to yet. Ask them to send the link again once it is done.</p>`,
    }));
  }

  const rows = items.map((item) => html`<tr>
    <td>
      <span class="cell-t">${item.label}</span>
      ${item.note ? html`<span class="cell-s">${item.note}</span>` : ''}
      ${(answers.get(item.id) ?? []).map((upload) => html`<span class="cell-s">you sent
        <strong>${upload.filename}</strong> on ${dateIn(practice?.timezone, new Date(upload.uploaded_at))}</span>`)}
    </td>
    <td>${item.needsAttention
      ? html`${badge('please send this again', TONES.wrong)}${item.attentionNote ? html`<span class="cell-s">${item.attentionNote}</span>` : ''}`
      : (answers.get(item.id) ?? []).length > 0
        ? badge('received', TONES.done)
        : item.clientSays
          ? html`${badge('you said:', TONES.waiting)}<span class="cell-s">${item.clientSays}</span>`
          : badge('still needed', TONES.waiting)}</td>
    <td>
      <form class="upload" method="post" action="/r/${params[0]}/items/${item.id}">
        <input type="file" name="file" required>
        <input type="text" name="note" placeholder="anything we should know? (optional)" maxlength="500">
        <div class="row">
          <button type="submit">Send</button>
          <span class="status"></span>
        </div>
      </form>
      ${item.received
        ? ''
        : html`<form method="post" action="/r/${params[0]}/items/${item.id}/says" class="inline says">
            ${Object.entries(CLIENT_SAYS).map(([value, words]) => html`
              <button type="submit" name="says" value="${value}" class="ghost sm">${words}</button>`)}
          </form>`}
    </td>
  </tr>`);

  return sendPage(response, 200, page({
    title: `${practice?.name ?? 'Documents requested'} — ${open.title}`,
    // No sign-in link: a client has no account, and offering one is offering a door that is not
    // theirs. The practice's pages keep their own header, because there the link is the point.
    signIn: false,
    banner: html`<p class="note"><strong>What you send is encrypted in this browser before it
      leaves it.</strong> Only the practice can open it. What the server can still see is the
      name of the file, which document it answers, and when it arrived — so name files the way
      you would name an envelope, not the way you would name a letter.</p>`,
    body: html`
      <div class="client">
        <p class="eyebrow">${practice?.name ?? 'Documents requested'}</p>
        <h1>${open.title}</h1>
        <p class="who">${open.client_name}${open.due_at ? html` · needed by ${open.due_at}` : ''}</p>
        ${url.searchParams.get('said') === '1'
          ? html`<p class="success"><strong>Message sent.</strong> The practice has it, and it is kept with
              this request — you will see it below, and they will see it beside the documents.</p>`
          : ''}
        ${open.client_note ? html`<div class="greeting">${open.client_note}</div>` : ''}
        ${items.length === 0
          ? ''
          : received === items.length
            ? html`<p class="success"><strong>Thank you — everything asked for has arrived.</strong>
                ${items.length === 1 ? 'The document you sent is' : `All ${items.length} documents are`}
                with the practice. If they need anything else they will be in touch, and this page stays
                here if you want to check what you sent.</p>`
            : html`<p class="count">You have sent ${received} of ${items.length}
                ${items.length === 1 ? 'document' : 'documents'}.</p>`}
        <div class="scroll"><table>
          <thead><tr><th align="left">Document</th><th align="left">State</th><th align="left">Send it</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="note">If you cannot send one of these, say so with the buttons beside it — the practice
        would rather know than keep asking. Neither button takes it off the list; that is their call.</p>
        ${items.length === 0
          ? html`<p>Nothing is being asked of you at the moment. Add the practice's address to your
              contacts, in case they ask for something later.</p>`
          : ''}
        ${extras.length > 0
          ? html`<h2>Anything else you have sent</h2>
              <p class="note">Documents you sent that were not on the list. The practice has them.</p>
              <ul class="plain">${extras.map((upload) => html`<li>
                  <strong>${upload.filename}</strong>
                  <span class="note"> — sent on ${dateIn(practice?.timezone, new Date(upload.uploaded_at))}</span>
                </li>`)}</ul>`
          : ''}
        <h2>Send something that was not asked for</h2>
        <p class="note">If you have a document the practice has not asked for — a letter, a form, anything
        you think they need — this is the safe way to send it. It is encrypted the same way as everything
        else, and they will see it attached to this request.</p>
        <form class="upload" method="post" action="/r/${params[0]}/extra">
          <input type="file" name="file" required>
          <input type="text" name="note" placeholder="what is it? (optional)" maxlength="500">
          <div class="row">
            <button type="submit">Send it</button>
            <span class="status"></span>
          </div>
        </form>
        <h2>Send a message</h2>
        <p class="note">For anything that is not a file — the statements are in the post, you have changed
        your address, the bank said five days. It goes to the practice with this request, and it stays here
        so you can see what you said.</p>
        <form method="post" action="/r/${params[0]}/message" class="stack">
          <textarea name="body" rows="3" required maxlength="${MAX_CLIENT_MESSAGE}"
            placeholder="Anything the practice should know"></textarea>
          <div class="row"><button type="submit">Send the message</button></div>
        </form>
        ${said.length > 0
          ? html`<div class="said">
              <h3>What you have told them</h3>
              ${said.map((event) => html`<p class="note">
                <span class="when">${dateIn(practice?.timezone, new Date(event.at))}</span>
                ${event.detail}</p>`)}
            </div>`
          : ''}
        ${practice?.contact_email || practice?.contact_phone
          ? html`<h2>Asking the practice something</h2>
              <p class="note">If this page is not the right place for it — anything about fees, deadlines,
              or a document you would rather discuss first — the practice can be reached at:</p>
              <ul class="plain">
                ${practice.contact_email
                  ? html`<li><a href="mailto:${practice.contact_email}">${practice.contact_email}</a></li>`
                  : ''}
                ${practice.contact_phone ? html`<li>${practice.contact_phone}</li>` : ''}
              </ul>`
          : ''}
        <p class="note">Nothing here needs an account. Come back to this page with the same
        link to send the rest — the list shows what has already arrived.</p>
      </div>
      ${jsonTag('practice-key', { keyId: open.practice_key_id, publicKey: JSON.parse(open.practice_public_key) })}
      ${jsonTag('upload-limit', { maxBytes: maxUploadBytes })}
      ${jsonTag('already-sent', alreadySent)}
      ${raw('<script type="module" src="/assets/upload.js"></script>')}`,
  }));
}

/**
 * The one throttle on a client link: 30 writes a minute, per link.
 *
 * A link is a bearer token and the write routes behind it accept whatever arrives — messages, "I do not
 * have this", uploads. The per-link storage ceiling bounds *bytes*, and nothing bounded *count of acts*:
 * a holder (or a leaker) could fill the event record and the request page with messages forever. This is
 * the cheapest honest bound. It counts every write attempt — refused ones included — and says so plainly
 * when it refuses, because a silent drop is the failure mode this product exists to avoid.
 */
function clientWriteAllowed({ clientLimiter, token, response }) {
  const key = `client-write:${token}`;
  if ((clientLimiter?.blockedFor(key) ?? 0) > 0) {
    fail(response, 429, 'That link has been used a lot in the last minute. Wait a moment and try again — nothing was lost.');
    return false;
  }
  clientLimiter?.failed(key);
  return true;
}

/**
 * The client saying something other than sending a file.
 *
 * Two sentences, both of which a practice would rather have than silence: "I do not have this" and "I
 * will send this later". The item stays on the list either way — whether to stop asking is the
 * practice's decision — and the client can take it back by saying nothing again.
 */
export async function clientSays({ db, request, response, params, mailer, clientLimiter }) {
  const [token, itemId] = params;
  if (!clientWriteAllowed({ clientLimiter, token, response })) return;
  const found = tokenLookup(db, token);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const item = itemInRequest(db, found.request.id, itemId);
  if (!item) return fail(response, 404, 'That document is not part of this request.');

  const fields = formFields(await readBody(request));
  const asked = field(fields, 'says');
  if (!Object.hasOwn(CLIENT_SAYS, asked)) {
    return fail(response, 400, 'That is not one of the answers this page offers. Nothing was changed.');
  }

  // A client can clear their own answer by choosing the same one again — otherwise the sentence would be
  // stuck on the practice's list with no way to withdraw it from the side that said it.
  const same = item.client_says === CLIENT_SAYS[asked];
  setClientSays(db, found.request.practice_id, found.request.id, itemId, same ? null : CLIENT_SAYS[asked]);
  redirect(response, `/r/${token}`);

  // After the client has their answer back, and never before it — the same rule as an upload, for the same
  // reason. Clearing an answer ("actually, I will send it") is as much news as giving one, so both notify: the
  // practice needs to know the document is coming, not that their last reminder is still standing.
  //
  // No event is recorded for the client's words here: `setClientSays` already writes `item.client-said` or
  // `item.client-said-cleared`, so the record is the client's sentence and this is only the practice being told
  // about it. Two events for one action would be one event too many.
  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
}

/**
 * Take an encrypted file from a client, check it, and put it somewhere.
 *
 * One implementation for both kinds of upload, because the checks that matter are the same and a second copy
 * of them is a second place for the product's central claim to become false. In particular the envelope check
 * and the key check happen for a document nobody asked for exactly as they do for an answer: a file the
 * server can read is a file the server can read, whatever the checklist says about it.
 *
 * Returns null when it has already answered the request with a failure, which is this file's idiom — `fail`
 * writes the response, so a caller only has to return.
 */
async function acceptEnvelope({ db, request, response, blobDir, maxUploadBytes, maxRequestBytes, maxRequestFiles, requestId, requestItemId = null }) {
  const type = String(request.headers['content-type'] ?? '');
  if (!type.startsWith('application/octet-stream')) {
    return fail(response, 415, 'This page sends files as raw bytes, which needs JavaScript to be enabled.');
  }

  // **Before a byte is read.** The ceiling is checked ahead of the body for the same reason the per-file limit
  // is enforced by `readBody`: refusing after reading two gigabytes has already spent the memory the refusal was
  // meant to save. It also means a refused upload leaves nothing behind — no file on disk and no row.
  const spent = db
    .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM upload WHERE request_id = ?')
    .get(requestId);
  if (spent.files >= maxRequestFiles) {
    return fail(
      response,
      413,
      `This link has reached its limit of ${maxRequestFiles} files. Nothing was stored. Ask the practice to send a fresh link, or to raise the limit.`,
    );
  }

  // The size is only known after reading, so this is checked against what has already arrived plus the ceiling,
  // and enforced again below once the length is known. Two checks rather than one because they answer different
  // questions: this one refuses early, the other refuses exactly.
  if (spent.bytes >= maxRequestBytes) {
    return fail(
      response,
      413,
      `This link has reached its ${(maxRequestBytes / 1024 / 1024 / 1024).toFixed(1)} GB limit. Nothing was stored. Ask the practice to send a fresh link.`,
    );
  }

  // Before anything is read or written: the header helper, because the key check below needs it and a
  // rejected upload should leave nothing behind.
  const header = (name, fallback, limit) =>
    request.headers[name] ? decodeURIComponent(String(request.headers[name])).slice(0, limit) : fallback;

  // **Streamed straight to disk** — spooled beside the blobs and moved under the request's directory
  // only once the upload is accepted, so a refused upload leaves *nothing* behind: no row, no file,
  // and not even the empty directory the final path would need. The old path assembled the whole
  // file in memory first, which made the per-file ceiling a *memory* ceiling times every concurrent
  // client.
  const uploadId = newId();
  await mkdir(blobDir, { recursive: true });
  const spoolPath = join(blobDir, `${uploadId}.incoming`);
  const spooled = await spoolBody(request, maxUploadBytes, spoolPath);
  const drop = () => unlink(spoolPath).catch(() => {});
  if (spooled.bytes === 0) {
    await drop();
    return fail(response, 400, 'That file was empty.');
  }

  // The exact check, now that the length is known. `spent` above could only refuse a link that had *already*
  // crossed the line; this one refuses the file that would cross it.
  if (spent.bytes + spooled.bytes > maxRequestBytes) {
    const left = Math.max(0, maxRequestBytes - spent.bytes);
    await drop();
    return fail(
      response,
      413,
      `That file would take this link past its limit. ${(left / 1024 / 1024).toFixed(1)} MB is left of ${(maxRequestBytes / 1024 / 1024 / 1024).toFixed(1)} GB. Nothing was stored.`,
    );
  }

  // The server refuses a file it could read. Storing one and calling it encrypted would make
  // the product's central claim false in a way nobody would notice until it mattered. Only the header
  // is read back: an envelope is decided by its first bytes and its length, and the body stays on disk
  // where it already is.
  const envelope =
    spooled.bytes < HEADER_BYTES + 1
      ? { ok: false, reason: 'too short to be an envelope' }
      : readEnvelope(await readHead(spoolPath));
  if (!envelope.ok) {
    await drop();
    return fail(
      response,
      400,
      `Only encrypted uploads are accepted, and that one is not one (${envelope.reason}). Nothing was stored.`,
    );
  }

  // Which key the client sealed this to. The browser says, because the bytes cannot: an envelope's
  // header carries the *ephemeral* key it was made with, not the recipient it was made for. The claim
  // is checked before it is recorded, and a wrong one is refused rather than stored as unknown — this
  // column is what decides whether a key can ever be discarded, so a false answer is worse than none.
  const claimedKey = header('x-key-id', null, 64);
  let keyId = null;
  if (claimedKey !== null) {
    const key = db
      .prepare(
        `SELECT k.id FROM practice_key k JOIN request r ON r.practice_id = k.practice_id
          WHERE k.id = ? AND r.id = ?`,
      )
      .get(claimedKey, requestId);
    if (!key) {
      await drop();
      return fail(response, 400, 'That upload named a key this practice does not have. Nothing was stored.');
    }
    keyId = key.id;
  }

  // Moved under the request's directory only now that it is accepted — see the spool note above. A
  // rename on the same volume is the cheap kind; a crash before it leaves an unreferenced `.incoming`
  // file and no row, which is the safe direction (and swept by hand if it ever happens).
  const directory = join(blobDir, requestId);
  await mkdir(directory, { recursive: true });
  const storagePath = join(directory, `${uploadId}.bin`);
  await rename(spoolPath, storagePath);

  recordUpload(db, {
    id: uploadId,
    requestId,
    requestItemId,
    filename: header('x-file-name', 'upload.bin', 255),
    mime: header('x-file-type', 'application/octet-stream', 120),
    sizeBytes: spooled.bytes,
    sha256: spooled.sha256,
    storagePath,
    clientNote: header('x-note', null, 500),
    keyId,
    at: now(),
  });

  return { uploadId, bytes: spooled.bytes };
}

/**
 * A file the client sent that nobody asked for.
 *
 * This closes the product's last route out of itself. Before it, a client holding a link who also had the VAT
 * return, a covering letter or last year's return had one way to send it: email, in the clear, outside the
 * record, with none of the protection the page they were already looking at exists to provide. The practice
 * then held a document with nowhere to live.
 *
 * It answers no item, so it clears nothing and marks nothing received — the checklist is what the practice
 * asked for, and a client's own addition is not an answer to a question.
 */
export async function receiveExtra({ db, request, response, params, blobDir, maxUploadBytes, maxRequestBytes, maxRequestFiles, mailer, clientLimiter }) {
  if (!clientWriteAllowed({ clientLimiter, token: params[0], response })) return;
  const found = tokenLookup(db, params[0]);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const stored = await acceptEnvelope({
    db,
    request,
    response,
    blobDir,
    maxUploadBytes,
    maxRequestBytes,
    maxRequestFiles,
    requestId: found.request.id,
  });
  if (!stored) return;

  sendJson(response, 201, { ok: true, extra: true, bytes: stored.bytes, envelope: ENVELOPE_VERSION });

  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
}

/**
 * The client writing to the practice with no file attached.
 *
 * The two buttons beside each item cover "I do not have this" and "I will send it later". Everything else a
 * client might need to say — "I posted it", "the bank said five days", "my name changed" — had no route
 * except an email, which is the record this page exists to keep them out of.
 *
 * A form post rather than an upload: there is nothing to encrypt, and pretending otherwise would be worse
 * than useless. The practice's page shows the words and the history keeps them.
 */
export async function clientMessage({ db, request, response, params, mailer, clientLimiter }) {
  if (!clientWriteAllowed({ clientLimiter, token: params[0], response })) return;
  const found = tokenLookup(db, params[0]);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const fields = formFields(await readBody(request));
  const body = (field(fields, 'body') ?? '').trim();
  if (body.length === 0) {
    return fail(response, 400, 'There was nothing in that message. Type something and send it again.');
  }
  // Refused rather than trimmed: a message the client cannot see the end of is not the message they wrote.
  if (body.length > MAX_CLIENT_MESSAGE) {
    return fail(
      response,
      400,
      `That is longer than ${MAX_CLIENT_MESSAGE} characters, which is more than the practice can read in a list. Nothing was sent.`,
    );
  }

  recordClientMessage(db, { requestId: found.request.id, body });
  redirect(response, `/r/${params[0]}?said=1`);

  // After the client has their answer back, and never before it — the same rule the uploads follow.
  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
}

/**
 * The client's upload, sent by the page's own script as a raw body, as the answer to an item the practice
 * asked for. The checks and the storage are in `acceptEnvelope`; what is here is the part that is about
 * *items* — that the item exists, that it belongs to this request, and that the practice is still asking.
 *
 * The filename arrives in a header and is recorded as a *label* only. It is never used to
 * build a path, so a filename like `../../etc/passwd` cannot become one — the bytes are
 * stored under an id this process generated. That property is what makes the storage layer
 * safe to write without a sanitiser, and it needs no test to stay true as long as nobody
 * starts joining the filename into a path.
 */
export async function receiveUpload({ db, request, response, params, blobDir, maxUploadBytes, maxRequestBytes, maxRequestFiles, mailer, clientLimiter }) {
  const [token, itemId] = params;
  if (!clientWriteAllowed({ clientLimiter, token, response })) return;
  const found = tokenLookup(db, token);
  if (found.state !== 'open') {
    return fail(response, 410, 'This link no longer works. Ask the practice for a new one.');
  }

  const item = itemInRequest(db, found.request.id, itemId);
  if (!item) return fail(response, 404, 'That document is not part of this request.');
  if (item.withdrawn_at) {
    // A client may be holding a page from before the practice stopped asking. Saying so is better than
    // storing a file that nothing is waiting for, or than a "not found" that reads like their mistake.
    return fail(response, 409, 'The practice is no longer asking for that one. Refresh the page to see the current list.');
  }

  const stored = await acceptEnvelope({
    db,
    request,
    response,
    blobDir,
    maxUploadBytes,
    maxRequestBytes,
    maxRequestFiles,
    requestId: found.request.id,
    requestItemId: item.id,
  });
  if (!stored) return;

  sendJson(response, 201, { ok: true, received: item.label, bytes: stored.bytes, envelope: ENVELOPE_VERSION });

  // After the client has their answer, and never before it. Awaiting this here would put the practice's mail
  // server in the path of somebody else's upload: a relay that has gone quiet would turn a client's successful
  // file into a spinner, and a relay that refuses would turn it into an error that is not their fault.
  await notifyPracticeOfChange({
    db,
    requestRow: found.request,
    mailer,
    origin: originOf(request),
  });
}

/**
 * The practice's key: making one, seeing them, moving files onto a new one, changing a passphrase.
 *
 * **Step three of the split `docs/audit.md` §3 proposes.** What is here is the only part of the product that handles
 * key material, and all of it is done without ever being able to use it: the server validates the *shape* of a key —
 * that it is a P-256 JWK, that the wrapped record is one this version would have written, that its KDF cost is inside
 * what this version accepts — and then stores blobs it cannot open. `publicKeyProblem`, `wrappedKeyProblem` and
 * `keyProblem` are that whole idea in three functions.
 *
 * The re-encryption pass is the one operation a *browser* performs rather than the server, and the reason is the
 * product's central claim: opening a file with the old key and sealing it to the new one needs the passphrase, so the
 * work happens in the tab and the server only learns where the bytes ended up. `pendingFor` is the whole of the resume
 * logic — a file that has been moved stops appearing in that list — which is why closing the browser halfway through
 * loses nothing but the time already spent, with no progress table and no cursor to get out of step with the files.
 *
 * One thing was mended on the way in: the note describing the keys page had drifted several hundred lines away from
 * its function, sitting above `saveKeys`. It is now where it belongs — above `keysPage`.
 */
import { open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readHead } from './blobs.js';
import { newId, now } from './db.js';
import { field, formFields, readBody, spoolBody } from './http.js';
import { tellOwners } from './notices.js';
import {
  addPracticeKey,
  allPracticeKeys,
  filesPerKey,
  history,
  practiceFor,
  practiceKeys,
  replaceUpload,
  replaceWrappedKey,
  retirePracticeKey,
  uploadsSealedTo,
} from './store.js';
import { TONES, badge, empty, fail, html, jsonTag, page, raw, redirect, requireSignIn, section, sendJson, sendPage } from './views.js';
import { HEADER_BYTES, KDF_MAX_ITERATIONS, readEnvelope } from '../web/tickmark-crypto.js';

/**
 * The files still sealed to a key, for a re-encryption pass to work through.
 *
 * **This endpoint is the whole of the resume logic.** A file that has been moved is no longer sealed to
 * the old key, so it stops appearing here — which means closing the browser halfway through a pass loses
 * nothing but the time already spent, and reopening the page starts from wherever the data got to. No
 * progress table, no session, no cursor to get out of step with the files themselves.
 */
export function pendingFor({ db, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;

  const key = db
    .prepare('SELECT id, deleted_at FROM practice_key WHERE id = ? AND practice_id = ?')
    .get(params[0], practiceId);
  if (!key) return fail(response, 404, 'There is no key with that id in this practice.', practitioner);
  if (key.deleted_at) return sendJson(response, 200, { files: [], retired: true, keyId: key.id });

  const files = uploadsSealedTo(db, key.id, practiceId).map((row) => ({
    id: row.id,
    filename: row.filename,
    // Where the browser fetches the envelope, and where it will post the new one. The download is the
    // ordinary file route, so the pass needs no separate way of reading a document.
    url: `/requests/${row.request_id}/files/${row.id}`,
  }));

  return sendJson(response, 200, { files, retired: false, keyId: key.id });
}

/**
 * Replace one stored envelope with the same document sealed to a newer key.
 *
 * The practice's private key never comes near this: the browser decrypts, re-encrypts, and posts bytes the
 * server cannot read — the same property as an upload. What the server does is what it can honestly do:
 * check the bytes are a well-formed envelope, check the named key belongs to this practice and is live,
 * write them somewhere new, and move the row.
 *
 * **It cannot check the plaintext is the same document**, because that would need the private key. What
 * stands in place of that check is on the browser side, which verifies the round trip before posting; this
 * route's job is to refuse anything that is not an envelope, so a broken re-encryption cannot overwrite a
 * good file with rubbish.
 */
export async function reencryptFile({ db, request, response, practitioner, practiceId, params, maxUploadBytes }) {
  if (!requireSignIn({ practitioner, response })) return;

  const type = String(request.headers['content-type'] ?? '');
  if (!type.startsWith('application/octet-stream')) {
    return fail(response, 415, "This route takes the new envelope as raw bytes, which needs the page's own script.");
  }

  const keyId = String(request.headers['x-key-id'] ?? '');
  if (!keyId) return fail(response, 400, 'The new key has to be named, or there is no record of what opens the file now.');

  const existing = db
    .prepare(
      `SELECT u.id, u.storage_path FROM upload u
         JOIN request r ON r.id = u.request_id
        WHERE u.id = ? AND r.practice_id = ?`,
    )
    .get(params[0], practiceId);
  if (!existing) return fail(response, 404, 'There is no file with that id.', practitioner);

  // Written under a name of its own, so the file the row currently points at is untouched until the row
  // moves. See the note on `replaceUpload` for why that order is the one that cannot lose a document.
  // Spooled to disk like the upload that made it, for the same reason.
  const storagePath = join(dirname(existing.storage_path), `${newId()}.bin`);
  const spooled = await spoolBody(request, maxUploadBytes, storagePath);
  const drop = () => unlink(storagePath).catch(() => {});
  if (spooled.bytes === 0) {
    await drop();
    return fail(response, 400, 'That upload was empty. Nothing was replaced.');
  }

  const envelope =
    spooled.bytes < HEADER_BYTES + 1
      ? { ok: false, reason: 'too short to be an envelope' }
      : readEnvelope(await readHead(storagePath));
  if (!envelope.ok) {
    await drop();
    return fail(
      response,
      400,
      `Only an encrypted file can replace an encrypted file, and that one is not one (${envelope.reason}). Nothing was replaced.`,
    );
  }

  const replaced = replaceUpload(db, practiceId, {
    uploadId: existing.id,
    keyId,
    storagePath,
    sizeBytes: spooled.bytes,
    sha256: spooled.sha256,
  });

  if (!replaced.ok) {
    // The new bytes are referenced by nothing, so they go rather than becoming an orphan. A failure to
    // remove them is not worth reporting: the document is intact either way.
    await unlink(storagePath).catch(() => {});
    const why = {
      'not-found': 'There is no file with that id.',
      'no-such-key': "That key is not one of this practice's, or it has been retired.",
      already: 'That file is already sealed to that key, so there was nothing to do.',
    }[replaced.why] ?? 'That file could not be re-encrypted.';
    return fail(response, 400, why, practitioner);
  }

  // The old bytes go last: the row has moved, so nothing reads them now. A failure here leaves an orphan,
  // which is untidy and harmless — removing them before the row moved would not be.
  await unlink(replaced.previousPath).catch(() => {});

  return sendJson(response, 200, { ok: true, id: existing.id, filename: replaced.filename, keyId });
}

/**
 * Retire a key: its wrapped copies are destroyed and the row stays as a record.
 *
 * The page asks for a typed word rather than offering a button, because the consequence is not obvious and
 * is not reversible: a retired key cannot open the files it once opened, **including any copy of those
 * files the practice has kept elsewhere**. A backup of the data directory taken before the pass is a set of
 * envelopes nothing can open afterwards. That sentence belongs on the page, and the typing is what makes a
 * person read it.
 */
export async function retireKey({ db, request, response, practitioner, practiceId, params }) {
  if (!requireSignIn({ practitioner, response })) return;

  const fields = formFields(await readBody(request));
  if (field(fields, 'confirm') !== 'retire') {
    return fail(
      response,
      400,
      'That key was not retired. The word has to be typed, because retiring it cannot be undone.',
      practitioner,
    );
  }

  const result = retirePracticeKey(db, practiceId, params[0]);
  if (!result.ok) {
    const why = {
      'not-found': 'There is no such key in this practice.',
      current: 'That is the current key — new files are sealed to it, so it cannot be retired.',
      already: 'That key has already been retired.',
      'holds-files': `That key still opens ${result.held} ${result.held === 1 ? 'file' : 'files'}. Move ${
        result.held === 1 ? 'it' : 'them'
      } to a newer key first, or the file cannot be read again.`,
    }[result.why] ?? 'That key could not be retired.';
    return fail(response, 400, why, practitioner);
  }

  return redirect(response, `/keys?retired=${encodeURIComponent(params[0])}`);
}

/**
 * The no-JavaScript answer to the move button.
 *
 * Re-sealing a stored document needs the private key, and the private key only ever exists in the browser.
 * There is no server-side version of this to fall back to, so a browser without the script gets a sentence
 * saying that rather than a 404 — or, worse, a button that looks like it worked.
 */
export function moveWithoutScript({ response, practitioner }) {
  if (!requireSignIn({ practitioner, response })) return;
  return fail(
    response,
    415,
    "Moving files needs the page's own script, because the key never leaves the browser. Nothing was changed.",
    practitioner,
  );
}

// ---------------------------------------------------------------------------------
// The practice's key
// ---------------------------------------------------------------------------------

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const MIN_ITERATIONS = 100000;

/**
 * Everything about a submitted key that the server can check without being able to use it.
 *
 * The server cannot verify that a key is *good* — it cannot open it, and that is the point.
 * What it can do is refuse something that is not a key at all, and refuse a record that would
 * protect the practice's own private half so weakly that the promise is nominal. A hostile
 * client could still store nonsense for its own account, which harms nobody but itself.
 */
function publicKeyProblem(publicKeyJson) {
  let publicKey;
  try {
    publicKey = JSON.parse(publicKeyJson);
  } catch {
    return 'That public key could not be read.';
  }
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256') {
    return 'That is not a P-256 public key.';
  }
  if (!BASE64URL_32.test(String(publicKey.x ?? '')) || !BASE64URL_32.test(String(publicKey.y ?? ''))) {
    return 'That public key is not the shape a P-256 point has.';
  }
  return null;
}

function wrappedKeyProblem(wrapped) {
  const parts = String(wrapped).split('$');
  if (parts.length !== 6 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha-256') {
    return 'That key record is not in the form Tickmark writes.';
  }
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > KDF_MAX_ITERATIONS) {
    return `That key record asks for an amount of work outside what this version accepts (${MIN_ITERATIONS} to ${KDF_MAX_ITERATIONS} rounds).`;
  }
  return null;
}

function keyProblem(publicKeyJson, wrapped) {
  return publicKeyProblem(publicKeyJson) ?? wrappedKeyProblem(wrapped);
}

export function setupForm({ db, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const existing = practiceKeys(db, practiceId, practitioner.id);
  const first = existing.length === 0;
  return sendPage(response, 200, page({
    title: first ? 'Set up encryption' : 'Add a new key',
    practitioner,
    body: html`
      <div class="hero">
        <p class="eyebrow">${first ? 'Step one of one' : 'Keys'}</p>
        <h1>${first ? 'One passphrase, and then clients can send you files' : 'A new key, for files that arrive from now on'}</h1>
        <p class="lead">Tickmark makes a key pair in this browser. The public half is kept here; the private half
        never leaves your browser except wrapped under a passphrase, which is never sent either. That
        is what makes the promise real rather than polite: whoever runs this server — including you —
        can hold a client's documents without being able to read them.</p>
      </div>
      ${first
        ? html`<div class="danger">
              <p><strong>WARNING: Tickmark uses zero-knowledge encryption. If you lose this
              passphrase, your saved documents cannot be recovered by anyone.</strong></p>
              <p>Please save it immediately in a secure password manager (e.g., 1Password,
              Bitwarden).</p>
            </div>`
        : ''}
      ${first
        ? ''
        : html`<p class="warning"><strong>A new key does not re-encrypt anything.</strong> Files your
            clients have already sent stay encrypted to the key they arrived under, and you go on
            being able to open them. A new key changes what happens to the <em>next</em> file — so it
            is the right response to a key being exposed, and it is not an undo for a copy somebody
            has already taken.</p>`}
      <form id="setup" method="post" action="/setup" class="card narrow">
        <div class="field">
          <label for="passphrase">Passphrase</label>
          <input id="passphrase" name="passphrase" type="password" required autocomplete="new-password">
        </div>
        <div class="field">
          <label for="again">The same passphrase again</label>
          <input id="again" name="again" type="password" required autocomplete="new-password">
        </div>
        ${first
          ? html`<label for="saved-passphrase" class="check">
              <input id="saved-passphrase" type="checkbox">
              <span>I have saved this passphrase in a secure password manager (or somewhere else safe).</span>
            </label>`
          : ''}
        <button type="submit" ${first ? 'disabled' : ''}>Make the key</button>
        <div class="status note"></div>
      </form>
      <p class="note">Nothing can recover this passphrase and nothing can reset it.
      If you lose it, the files clients send you become unreadable — by you, by anyone. Write it
      down somewhere that is not this server.</p>
      ${raw('<script type="module" src="/assets/setup.js"></script>')}`,
  }));
}

export async function saveKeys({ db, request, response, practitioner, practiceId, mailer }) {
  if (!requireSignIn({ practitioner, response })) return;

  const fields = formFields(await readBody(request));
  const publicKeyJson = field(fields, 'public_key');
  const wrapped = field(fields, 'wrapped_private_key');
  const problem = keyProblem(publicKeyJson, wrapped);
  if (problem) return fail(response, 400, problem, practitioner);

  // Read before the insert below: "did this practice already have a key?" is what separates a
  // rotation from a first setup.
  const hadKey = practiceKeys(db, practiceId, practitioner.id).length > 0;
  addPracticeKey(db, practiceId, {
    publicKey: JSON.parse(publicKeyJson),
    wrappedPrivateKey: wrapped,
    createdBy: practitioner.id,
  });
  redirect(response, '/keys');

  // **The one change this product emails about unprompted, and the reason is detection.** A member
  // adding a key of their own is exactly the attack `src/totp.js` describes: from that moment every
  // client document is sealed to them, and *nothing anywhere looks wrong*. It cannot be prevented —
  // the member is legitimately signed in — so the only defence is that the practice hears about it
  // while it is still a routine rotation. Sent after the response, best effort, never the actor's
  // problem if the relay is down.
  //
  // **The first key is silent on purpose.** At setup there is one member — the person pressing the
  // button — no clients have been sent anything, and "a key was added" addressed to the person who
  // just made it is noise. The announcement matters when a key arrives at a practice that already
  // has one, which is precisely the rotation-or-hijack moment it exists for.
  if (hadKey) {
    await tellOwners(db, practiceId, mailer, {
      subject: `A new encryption key was added at ${practiceFor(db, practiceId)?.name ?? 'the practice'}`,
      lines: [
        `${practitioner.email} added a new encryption key.`,
        '',
        'Documents clients send from now on will be sealed to it. Everything already here is untouched.',
        '',
        'This is the one change that quietly decides who can read what arrives next, so it is worth a glance even when it is routine.',
      ],
    });
  }
  return;
}

/**
 * The practice's keys: what exists, which one is current, and how to change a passphrase.
 *
 * Rotation is presented as what it is, and there is no button to delete an old key. Deleting one
 * would orphan every file encrypted to it, and a button that destroys a practice's access to its own
 * clients' documents should not exist until there is a way to re-encrypt those files first.
 */
export function keysPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const every = allPracticeKeys(db, practiceId, practitioner.id);
  const live = every.filter((key) => key.deletedAt === null);
  const retired = every.filter((key) => key.deletedAt !== null);
  const counts = filesPerKey(db, practiceId);
  const unaccounted = counts.get(null) ?? 0;
  const current = live[0] ?? null;
  const justRetired = url.searchParams.get('retired');

  /**
   * A key that has been retired is history, not a control.
   *
   * Its wrapped copies are gone, so there is no passphrase form, nothing to move and nothing to do — and
   * showing a control that cannot work is the same mistake as a Send button with no mail server. What it
   * keeps is the date it was made and the date it stopped opening anything, which is the record deleting
   * the row would have thrown away.
   */
  const retiredRows = retired.map((key) => html`<tr>
    <td>${key.createdAt.slice(0, 19).replace('T', ' ')}</td>
    <td>${badge('retired', TONES.done_for)} ${(key.deletedAt ?? '').slice(0, 10)} — its copies were destroyed, so it opens nothing</td>
  </tr>`);

  const rows = live.map((key) => {
    const holds = counts.get(key.id) ?? 0;
    return html`<tr>
      <td>${key.createdAt.slice(0, 19).replace('T', ' ')}</td>
      <td>${key === current
        ? html`${badge(html`<strong>current</strong>`, TONES.done)} new files are encrypted to this one`
        : html`<span class="muted">older — opens the files sent while it was current</span>`}</td>
      <td>${holds}</td>
      <td>
        <form class="passphrase" data-key-id="${key.id}" method="post" action="/keys/${key.id}/passphrase">
          <input type="password" name="old" placeholder="current passphrase" required autocomplete="current-password">
          <input type="password" name="fresh" placeholder="new passphrase" required autocomplete="new-password">
          <input type="password" name="again" placeholder="the new one again" required autocomplete="new-password">
          <button type="submit">Change the passphrase</button>
          <span class="status note"></span>
        </form>
        ${key === current || holds === 0
          ? ''
          : html`<form class="reencrypt" data-key-id="${key.id}" method="post" action="/keys/${key.id}/move">
              <input type="password" name="passphrase" placeholder="this key's passphrase" required autocomplete="current-password">
              <input type="password" name="current_passphrase" placeholder="the current key's passphrase, if it differs" autocomplete="current-password">
              <button type="submit">Move ${holds} ${holds === 1 ? 'file' : 'files'} to the current key</button>
              <span class="status note"></span>
              <progress value="0" max="${holds}"></progress>
            </form>`}
        ${key === current || holds > 0
          ? ''
          : html`<form method="post" action="/keys/${key.id}/retire">
              <input type="text" name="confirm" placeholder="type: retire" required autocomplete="off">
              <button type="submit">Retire this key</button>
            </form>`}
      </td>
    </tr>`;
  });

  return sendPage(response, 200, page({
    title: 'Keys',
    practitioner,
    here: '/keys',
    banner: live.length === 0
      ? html`<p class="warning">This practice has no key yet, so it cannot be sent files.
          <a href="/setup">Make one</a>.</p>`
      : justRetired
        ? html`<p class="success"><strong>Retired.</strong> Its wrapped copies have been destroyed, so it
            cannot open anything. The record of it stays below — and any copy of a file sealed to it that
            you kept or backed up cannot be opened any more.</p>`
        : null,
    body: html`
      <div class="page-head">
        <div class="titles">
          <h1>Keys</h1>
          <p class="sub">Every file a client sends is sealed to one of these, in the client's own
          browser. The server holds the wrapped copies and can open none of them.</p>
        </div>
        <div class="do">
          <a class="btn" href="/setup">Make a new key</a>
        </div>
      </div>
      ${live.length === 0
        ? html`<p class="info">There is no key yet. <a href="/setup">Make one</a> and clients can start
            sending.</p>`
        : html`<div class="scroll"><table class="keys">
            <colgroup><col class="w15"><col class="w21"><col class="w9"><col class="w55"></colgroup>
            <thead>
              <tr>
                <th align="left">Made</th>
                <th align="left">What it is for</th>
                <th align="left">Files</th>
                <th align="left">Passphrase</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table></div>`}
      ${unaccounted > 0
        ? html`<p class="note">${unaccounted} file${unaccounted === 1 ? '' : 's'} arrived before Tickmark
            recorded which key was used, so which key opens ${unaccounted === 1 ? 'it' : 'them'} is not written
            down anywhere. Nothing is lost — the key that opens a file is whichever one decrypts it — but it
            means those files are not counted in the column above, and <strong>moving files to a new key
            cannot touch them</strong>, because the pass works from that count.</p>`
        : ''}
      <section class="card">
        <h2>Retiring an old key</h2>
        <p class="note"><strong>Moving files to a new key is what makes an old key retirable.</strong> This
        browser fetches each file, opens it with the old key's passphrase, seals it to the current key, and
        checks the round trip before anything is replaced — the server only ever handles bytes it cannot read.
        If you close this page halfway through, nothing is lost: a file that has been moved is no longer sealed
        to the old key, so the count above <em>is</em> the progress, and pressing the button again carries on
        from where it stopped.</p>
        <p class="note"><strong>Retiring a key cannot be undone, and it reaches further than this server.</strong>
        It destroys the practice's copies, so the files here are fine once they have been moved — but
        <em>any copy of a file still on the old key that you have kept or backed up</em> becomes unopenable,
        because the key that opened it will not exist. Move everything first, then retire.</p>
        <p class="note">Changing a passphrase does not change the key, so nothing has to be
        re-encrypted and no file becomes unopenable. Store the new one somewhere that is not this
        server: a copy of a key without its passphrase is a file nobody can open.</p>
      </section>
      ${retired.length > 0
        ? html`<section class="card">
            <h2>Retired keys</h2>
            <div class="scroll"><table>
              <thead><tr><th align="left">Made</th><th align="left">What became of it</th></tr></thead>
              <tbody>${retiredRows}</tbody>
            </table></div>
            <p class="note">Kept as a record rather than deleted: a key that vanished would take with it the
            only evidence of what it opened.</p>
          </section>`
        : ''}
      ${live.length > 0
        ? jsonTag('key-records', {
            currentKeyId: current?.id ?? null,
            currentPublicKey: current?.publicKey ?? null,
            keys: live.map((key) => ({ id: key.id, wrapped: key.wrappedPrivateKey, publicKey: key.publicKey })),
          })
        : ''}
      ${live.length > 0 ? raw('<script type="module" src="/assets/keys.js"></script>') : ''}
      ${live.length > 1 && (counts.get(live[1].id) ?? 0) > 0
        ? raw('<script type="module" src="/assets/reencrypt.js"></script>')
        : ''}`,
  }));
}

/**
 * Accept a key re-wrapped under a new passphrase.
 *
 * The server cannot check the old passphrase, because checking it would mean being able to open the
 * record — which is the thing it must not be able to do. What it does check is that the new record
 * is one it would have written: the right shape, and a KDF cost inside what this version accepts.
 */
export async function changePassphrase({ db, request, response, practitioner, params, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const wrapped = field(fields, 'wrapped_private_key');

  const problem = wrappedKeyProblem(wrapped);
  if (problem) return fail(response, 400, problem, practitioner);

  const changed = replaceWrappedKey(db, practiceId, practitioner.id, params[0], wrapped);
  if (!changed) return fail(response, 404, 'There is no key of yours with that id.', practitioner);
  return redirect(response, '/keys');
}


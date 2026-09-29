/**
 * The client's upload, in a browser: encrypt the file, then send the envelope.
 *
 * Loaded as a module by the client's page. It is small enough to read in one go, which is the
 * point — a client being asked to trust this with a bank statement should be able to.
 *
 * The plaintext never leaves this function's scope: what goes over the network is the output
 * of `encryptFile`, and the practice's public key is the only thing needed to make it.
 */
import { encryptFile } from './tickmark-crypto.js';
import { duplicateOf, looksEncryptedPdf, readableBytes } from './preflight.js';

const keyElement = document.getElementById('practice-key');
const limitElement = document.getElementById('upload-limit');
const sentElement = document.getElementById('already-sent');

// The practice's per-file ceiling, injected by the server. Nothing here is a security decision —
// the server still refuses oversized uploads itself — but a client who finds out their 50 MB scan
// will not go by watching a browser tab crash is a client who never sends anything. Tell them at
// the moment they pick the file, in their own units, before any encrypting starts.
const maxBytes = limitElement ? JSON.parse(limitElement.textContent).maxBytes : Number.POSITIVE_INFINITY;

// What this client has already sent to this request: names, sizes and dates, all of which are on their own page
// already. The reasoning for comparing on those two facts and not a hash of the contents is in preflight.js.
const alreadySent = sentElement ? JSON.parse(sentElement.textContent) : [];

const readable = readableBytes;

/**
 * Whether a picked file is an encrypted PDF, judged from its two ends.
 *
 * Only the ends are read, so this costs nothing on a 20 MB scan — and the file never leaves the browser, which
 * is the whole reason the check is possible here and not on the server.
 */
async function looksPasswordProtected(file) {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!isPdf) return false;
  const window = 4096;
  const head = new Uint8Array(await file.slice(0, window).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - window)).arrayBuffer());
  return looksEncryptedPdf({ name: file.name, type: file.type, head, tail });
}

if (keyElement) {
  // `{ keyId, publicKey }`. The id travels back with the upload so the server can record which key the
  // envelope was sealed to — nothing about the bytes says so, because an envelope's header carries the
  // ephemeral key rather than the recipient. That record is what decides whether a key can ever be
  // discarded, so it is worth the extra field.
  const { keyId, publicKey } = JSON.parse(keyElement.textContent);
  const say = (form, text, blocked = false) => {
    const status = form.querySelector('.status');
    status.textContent = text;
    status.classList.toggle('warn', text.length > 0 && !blocked);
  };

  for (const form of document.querySelectorAll('form.upload')) {
    const fileInput = form.querySelector('input[type=file]');
    const sendButton = form.querySelector('button[type=submit]');

    // The moment files are chosen, not the moment a button is pressed: a client who picked the
    // wrong file should learn it while they are still looking at the picker, and the send button
    // stays dead until they pick something that can actually be accepted.
    //
    // Two of the checks warn rather than stop. Only the size limit is a refusal, because the server
    // would refuse it anyway and a dead button is the honest signal. A locked PDF or a file that looks
    // like an earlier one is a judgement, the client may not be able to do anything about it, and
    // refusing to send the only copy somebody has would be worse than the problem being prevented —
    // see web/preflight.js.
    //
    // It validates *every* picked file, because a client who chose three files needs to hear about
    // the one that is too large before any of them are encrypted, not after the first two went.
    const validate = async () => {
      const files = [...fileInput.files];
      if (files.length === 0) {
        sendButton.disabled = false;
        say(form, '');
        return;
      }

      const warnings = [];
      let blocked = false;

      const oversized = files.filter((file) => file.size > maxBytes);
      if (oversized.length > 0) {
        warnings.push(
          `${oversized.length === 1 ? 'This file is' : `These ${oversized.length} files are`} too large ` +
            `(${oversized.map((file) => `${file.name} ${readable(file.size)}`).join(', ')}). ` +
            `Your practice's maximum upload limit per file is ${readable(maxBytes)}.` +
            ' Try exporting a smaller version — most scanners can make a smaller PDF.',
        );
        blocked = true;
      }

      // The checks below read the files, which takes a moment on a large scan — so the disabling and
      // the message happen after the awaiting, and nothing is said in the meantime. A half-second of
      // silence is better than a message that changes under the reader's eyes.
      try {
        for (const file of files) {
          if (file.size > maxBytes) continue;
          if (await looksPasswordProtected(file)) {
            warnings.push(
              `${file.name} looks like a password-protected PDF — your practice will not be able to open it.` +
                ' If you can, save or print a copy without the password first.',
            );
            continue;
          }
          const twin = duplicateOf(file, alreadySent);
          if (twin) {
            warnings.push(
              `You already sent a file called ${twin.name} (${readable(twin.bytes)}) on ${twin.at}.` +
                ' If this is a different document, send it anyway.',
            );
          }
        }
      } catch {
        // Reading a file is best-effort. A browser that cannot slice a file is not a reason to stop
        // somebody sending their documents.
      }

      sendButton.disabled = blocked;
      say(form, warnings.join(' '), blocked);
    };

    fileInput.addEventListener('change', validate);

    // A desktop convenience that costs nothing on a phone: dropping files on the form is the same as
    // choosing them, so the picker is not the only way in.
    for (const kind of ['dragover', 'dragenter']) {
      form.addEventListener(kind, (event) => {
        event.preventDefault();
        form.classList.add('dropping');
      });
    }
    form.addEventListener('dragleave', () => form.classList.remove('dropping'));
    form.addEventListener('drop', (event) => {
      event.preventDefault();
      form.classList.remove('dropping');
      const dropped = event.dataTransfer?.files ?? [];
      if (dropped.length > 0) {
        fileInput.files = dropped;
        validate();
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const files = [...fileInput.files];
      if (files.length === 0) return;

      // A backstop beside the change listener, for a form submitted without a change event.
      const oversized = files.find((file) => file.size > maxBytes);
      if (oversized) {
        say(
          form,
          `${oversized.name} is too large (${readable(oversized.size)}). Your practice's maximum upload limit per file is ${readable(maxBytes)}.`,
        );
        return;
      }

      // Each file is encrypted and sent as its own envelope, one after another: the route takes one
      // file at a time, and a batch that stops halfway says where it stopped rather than pretending.
      // The client's note goes with each, because it is what they said about what they are sending.
      const note = form.querySelector('input[name=note]')?.value ?? '';
      try {
        let sent = 0;
        for (const file of files) {
          const where = files.length > 1 ? ` (${sent + 1} of ${files.length})` : '';
          say(form, `Encrypting ${file.name}${where} — ${Math.round(file.size / 1024)} KB…`);
          const plaintext = new Uint8Array(await file.arrayBuffer());
          const envelope = await encryptFile(publicKey, plaintext);

          say(form, `Sending ${file.name}${where}…`);
          const response = await fetch(form.action, {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-file-name': encodeURIComponent(file.name),
              'x-file-type': file.type || 'application/octet-stream',
              // The client's own words about what they sent. A header, like the filename, because the
              // body is the encrypted file and nothing else may travel in it.
              'x-note': encodeURIComponent(note),
              // Which key sealed it, so the practice can tell later which files a key is holding.
              ...(keyId ? { 'x-key-id': keyId } : {}),
              // Which checklist line this answers, when the form offers one (the practice adding a
              // file for a client). Absent on the client's page, where each row is already a line.
              ...(form.querySelector('select[name=item]')?.value
                ? { 'x-item-id': form.querySelector('select[name=item]').value }
                : {}),
            },
            body: envelope,
          });

          if (!response.ok) {
            const page = await response.text();
            const words = page.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
            // One file needs no name in its own failure; a batch does, or the client cannot tell which.
            say(form, files.length > 1 ? `Could not send ${file.name}: ${words}` : words);
            return;
          }
          sent += 1;
        }
        location.reload();
      } catch (error) {
        say(form, `That did not work: ${error.message}`);
      }
    });
  }
}
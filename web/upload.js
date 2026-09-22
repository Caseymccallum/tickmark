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

    // The moment a file is chosen, not the moment a button is pressed: a client who picked the
    // wrong file should learn it while they are still looking at the picker, and the send button
    // stays dead until they pick one that can actually be accepted.
    //
    // Two of the three checks warn rather than stop. Only the size limit is a refusal, because the server
    // would refuse it anyway and a dead button is the honest signal. A locked PDF or a file that looks like an
    // earlier one is a judgement, the client may not be able to do anything about it, and refusing to send the
    // only copy somebody has would be worse than the problem being prevented — see web/preflight.js.
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) {
        sendButton.disabled = false;
        say(form, '');
        return;
      }

      const warnings = [];
      let blocked = false;

      if (file.size > maxBytes) {
        warnings.push(
          `This file is too large (${readable(file.size)}). Your practice's maximum upload limit per file is ${readable(maxBytes)}.` +
            ' Try exporting a smaller version — most scanners can make a smaller PDF.',
        );
        blocked = true;
      }

      // Both of the checks below read the file, which takes a moment on a large scan — so the disabling and
      // the message happen after the awaiting, and nothing is said in the meantime. A half-second of silence is
      // better than a message that changes under the reader's eyes.
      try {
        if (!blocked && (await looksPasswordProtected(file))) {
          warnings.push(
            'This looks like a password-protected PDF — your practice will not be able to open it.' +
              ' If you can, save or print a copy without the password first.',
          );
        }
      } catch {
        // Reading the file is best-effort. A browser that cannot slice a file is not a reason to stop
        // somebody sending their documents.
      }

      const twin = duplicateOf(file, alreadySent);
      if (!blocked && twin) {
        warnings.push(
          `You already sent a file called ${twin.name} (${readable(twin.bytes)}) on ${twin.at}.` +
            ' If this is a different document, send it anyway.',
        );
      }

      sendButton.disabled = blocked;
      say(form, warnings.join(' '), blocked);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = fileInput.files[0];
      if (!file) return;

      // A backstop beside the change listener, for a form submitted without a change event.
      if (file.size > maxBytes) {
        say(
          form,
          `This file is too large (${readable(file.size)}). Your practice's maximum upload limit per file is ${readable(maxBytes)}.`,
        );
        return;
      }

      try {
        say(form, `Encrypting ${file.name} (${Math.round(file.size / 1024)} KB)…`);
        const plaintext = new Uint8Array(await file.arrayBuffer());
        const envelope = await encryptFile(publicKey, plaintext);

        say(form, `Sending ${Math.round(envelope.length / 1024)} KB…`);
        const response = await fetch(form.action, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
            'x-file-type': file.type || 'application/octet-stream',
            // The client's own words about what they sent. A header, like the filename, because the
            // body is the encrypted file and nothing else may travel in it.
            'x-note': encodeURIComponent(form.querySelector('input[name=note]')?.value ?? ''),
            // Which key sealed it, so the practice can tell later which files a key is holding.
            ...(keyId ? { 'x-key-id': keyId } : {}),
          },
          body: envelope,
        });

        if (response.ok) {
          location.reload();
          return;
        }
        const page = await response.text();
        say(form, page.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
      } catch (error) {
        say(form, `That did not work: ${error.message}`);
      }
    });
  }
}
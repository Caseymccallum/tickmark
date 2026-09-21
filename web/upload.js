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

const keyElement = document.getElementById('practice-key');
const limitElement = document.getElementById('upload-limit');

// The practice's per-file ceiling, injected by the server. Nothing here is a security decision —
// the server still refuses oversized uploads itself — but a client who finds out their 50 MB scan
// will not go by watching a browser tab crash is a client who never sends anything. Tell them at
// the moment they pick the file, in their own units, before any encrypting starts.
const maxBytes = limitElement ? JSON.parse(limitElement.textContent).maxBytes : Number.POSITIVE_INFINITY;

const readable = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

if (keyElement) {
  // `{ keyId, publicKey }`. The id travels back with the upload so the server can record which key the
  // envelope was sealed to — nothing about the bytes says so, because an envelope's header carries the
  // ephemeral key rather than the recipient. That record is what decides whether a key can ever be
  // discarded, so it is worth the extra field.
  const { keyId, publicKey } = JSON.parse(keyElement.textContent);
  const say = (form, text) => {
    form.querySelector('.status').textContent = text;
  };

  for (const form of document.querySelectorAll('form.upload')) {
    const fileInput = form.querySelector('input[type=file]');
    const sendButton = form.querySelector('button[type=submit]');

    // The moment a file is chosen, not the moment a button is pressed: a client who picked the
    // wrong file should learn it while they are still looking at the picker, and the send button
    // stays dead until they pick one that can actually be accepted.
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) {
        sendButton.disabled = false;
        say(form, '');
        return;
      }
      if (file.size > maxBytes) {
        say(
          form,
          `This file is too large (${readable(file.size)}). Your practice's maximum upload limit per file is ${readable(maxBytes)}.` +
            ' Try exporting a smaller version — most scanners can make a smaller PDF.',
        );
        sendButton.disabled = true;
        return;
      }
      sendButton.disabled = false;
      say(form, '');
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
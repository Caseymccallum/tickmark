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

if (keyElement) {
  const publicKey = JSON.parse(keyElement.textContent);
  const say = (form, text) => {
    form.querySelector('.status').textContent = text;
  };

  for (const form of document.querySelectorAll('form.upload')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = form.querySelector('input[type=file]').files[0];
      if (!file) return;

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
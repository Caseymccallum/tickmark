/**
 * The practice's key, made in the browser.
 *
 * This is the only moment at which the private key exists unwrapped. It is generated here, the
 * passphrase that protects it is typed here, and what is sent to the server is a public key and
 * a wrapped blob. The passphrase is not sent, and cannot be — nothing in this file transmits it.
 */
import { MIN_PASSPHRASE, generatePracticeKey } from './tickmark-crypto.js';

const form = document.getElementById('setup');

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('.status');
    const passphrase = form.querySelector('#passphrase').value;
    const again = form.querySelector('#again').value;

    if (passphrase.normalize('NFC').length < MIN_PASSPHRASE) {
      status.textContent = `Use at least ${MIN_PASSPHRASE} characters.`;
      return;
    }
    if (passphrase !== again) {
      status.textContent = 'Those two passphrases are not the same.';
      return;
    }

    try {
      status.textContent = 'Making the key…';
      const { publicKey, wrappedPrivateKey } = await generatePracticeKey(passphrase);

      status.textContent = 'Saving it…';
      const response = await fetch('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          public_key: JSON.stringify(publicKey),
          wrapped_private_key: wrappedPrivateKey,
        }),
      });

      if (response.ok) {
        location.href = '/requests';
        return;
      }
      const page = await response.text();
      status.textContent = page.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch (error) {
      status.textContent = `That did not work: ${error.message}`;
    }
  });
}
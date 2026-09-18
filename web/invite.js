/**
 * Accepting an invitation, in the browser.
 *
 * The secret comes from the link's fragment, which the browser never sends to a server. This page opens
 * the sealed blob with it, re-seals the same key under the new member's own passphrase, and posts only
 * the re-sealed record. The passphrase fields are cleared before submitting, so what travels is the
 * sealed copy and nothing else — and the server refuses the submission if those fields arrive filled,
 * which is what happens when this script did not run.
 */
import { MIN_PASSPHRASE, openInviteBytes, sealPrivateKey } from './tickmark-crypto.js';

const element = document.getElementById('invite-blob');
const form = document.getElementById('accept-form');

if (element && form) {
  const { sealed } = JSON.parse(element.textContent);
  const status = document.getElementById('accept-status');
  const passphraseField = form.querySelector('#passphrase');
  const againField = form.querySelector('#again');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const secret = location.hash.replace(/^#/, '');
    if (secret.length === 0) {
      status.textContent = 'This page is missing the part of the link that opens the key. Use the link exactly as it was sent — the part after the # is what opens it.';
      return;
    }

    const passphrase = passphraseField.value;
    if (passphrase.normalize('NFC').length < MIN_PASSPHRASE) {
      status.textContent = `Use at least ${MIN_PASSPHRASE} characters.`;
      return;
    }
    if (passphrase !== againField.value) {
      status.textContent = 'Those two are not the same.';
      return;
    }

    try {
      status.textContent = 'Opening the invitation…';
      const bytes = await openInviteBytes(sealed, secret);

      status.textContent = 'Sealing the key with your passphrase…';
      const wrapped = await sealPrivateKey(bytes, passphrase);

      form.querySelector('#wrapped_private_key').value = wrapped;
      passphraseField.value = '';
      againField.value = '';

      status.textContent = 'Joining…';
      form.submit();
    } catch (error) {
      status.textContent = error.message;
    }
  });
}
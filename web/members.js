/**
 * Creating an invitation, in the browser.
 *
 * The passphrase is typed here, the practice's key is unwrapped here, and the key is sealed here under a
 * **secret generated here** — which never leaves the page except inside the link's fragment. The server
 * receives a blob it cannot open and asks for nothing else, because there is nothing else it could check.
 *
 * Why this is a fetch and not a form: the secret has to survive the response. A normal form post would
 * navigate to a new page, and the secret would be gone with the old one.
 */
import { newInviteSecret, privateKeyBytesForTransfer, wrapBytesForInvite } from './tickmark-crypto.js';

const element = document.getElementById('invite-key');
const form = document.getElementById('invite-form');

if (element && form) {
  const key = JSON.parse(element.textContent);
  const status = document.getElementById('invite-status');
  const link = document.getElementById('invite-link');
  const passphraseField = form.querySelector('#passphrase');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      status.textContent = 'Opening your key…';
      const bytes = await privateKeyBytesForTransfer(key.wrapped, passphraseField.value);

      // Sealed under a secret that exists only in this page and in the link it is about to be put in.
      const secret = newInviteSecret();
      status.textContent = 'Sealing a copy for the invitation…';
      const sealed = await wrapBytesForInvite(bytes, secret);

      status.textContent = 'Asking the server to record it…';
      const response = await fetch('/members/invite', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ key_id: key.keyId, sealed_key: sealed }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        status.textContent = body.error ?? 'That did not work.';
        return;
      }

      // The password field has done its job. Leaving it filled keeps a passphrase in a form for as long
      // as the tab is open, which is a small thing that is easy to avoid.
      passphraseField.value = '';

      status.textContent = `Ready. It works once, and it stops working after ${body.days} days.`;
      link.hidden = false;
      link.textContent = '';
      const code = document.createElement('code');
      code.textContent = `${location.origin}/invite/${body.token}#${secret}`;
      link.append(code);
    } catch (error) {
      // Including "does not open this key", which is the one the practice is most likely to see: a
      // mistyped passphrase changes nothing and seals nothing.
      status.textContent = error.message;
    }
  });
}
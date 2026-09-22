/**
 * Creating an invitation, in the browser.
 *
 * The passphrase is typed here, the practice's key is unwrapped here, and the key is sealed here under a
 * **secret generated here** — which never leaves the page except inside the link's fragment. The server
 * receives a blob it cannot open and asks for nothing else, because there is nothing else it could check.
 *
 * **Two kinds of invitation, and the difference is decided here rather than on the server.** An *assistant*
 * invitation carries no key, so there is nothing to unwrap and nothing to seal — the whole point being that
 * the person who accepts it cannot read what clients send. The server could never produce that on its own:
 * it has no key to withhold, and "do not seal one" is an instruction only the browser can carry out. So the
 * role picker selects a different path through this file, and the passphrase field disappears with it.
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
  const roleField = form.querySelector('#invite-role');
  const passphraseRow = form.querySelector('#passphrase-row');

  // The passphrase is only needed to hand over a key, so it stops being asked for the moment the choice is
  // an assistant. Hiding it rather than leaving it optional: a field somebody does not need is a field they
  // will fill in, and a passphrase typed into a form that never uses it is a passphrase in a browser for no
  // reason.
  const syncRows = () => {
    if (passphraseRow) passphraseRow.hidden = roleField?.value === 'assistant';
  };
  roleField?.addEventListener('change', syncRows);
  syncRows();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const role = roleField?.value ?? 'accountant';
    const assistant = role === 'assistant';

    try {
      const fields = { role };

      if (!assistant) {
        status.textContent = 'Opening your key…';
        const bytes = await privateKeyBytesForTransfer(key.wrapped, passphraseField.value);

        // Sealed under a secret that exists only in this page and in the link it is about to be put in.
        const secret = newInviteSecret();
        status.textContent = 'Sealing a copy for the invitation…';
        fields.sealed_key = await wrapBytesForInvite(bytes, secret);
        fields.key_id = key.keyId;
        fields.secret = secret;
      } else {
        status.textContent = 'Making an invitation that carries no key…';
      }

      status.textContent = 'Asking the server to record it…';
      const response = await fetch('/members/invite', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(fields),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        status.textContent = body.error ?? 'That did not work.';
        return;
      }

      // The password field has done its job. Leaving it filled keeps a passphrase in a form for as long
      // as the tab is open, which is a small thing that is easy to avoid.
      if (passphraseField) passphraseField.value = '';

      status.textContent = body.keyed
        ? `Ready. They will be able to open what clients send. It works once, and it stops working after ${body.days} days.`
        : `Ready. They will be able to chase documents but not open them. It works once, and it stops working after ${body.days} days.`;
      link.hidden = false;
      link.textContent = '';
      const code = document.createElement('code');
      // The fragment only exists for a keyed invitation, because that is where the secret lives. An
      // assistant's link is a plain address — there is no secret to carry.
      code.textContent = body.keyed
        ? `${location.origin}/invite/${body.token}#${fields.secret}`
        : `${location.origin}/invite/${body.token}`;
      link.append(code);
    } catch (error) {
      // Including "does not open this key", which is the one the practice is most likely to see: a
      // mistyped passphrase changes nothing and seals nothing.
      status.textContent = error.message;
    }
  });
}
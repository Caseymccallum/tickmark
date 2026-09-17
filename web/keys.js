/**
 * Changing a passphrase, in the browser.
 *
 * The old passphrase is typed here, the key is unwrapped here, and the new passphrase seals it here.
 * The server receives a record it cannot open, exactly as when the key was first made — it has no
 * way to check the old passphrase, because checking would require being able to open the record,
 * which is the thing that must not be possible.
 *
 * Nothing is re-encrypted. The key is the same key, sealed differently, so every file stays
 * readable and none of this touches a stored document.
 */
import { MIN_PASSPHRASE, rewrapPrivateKey } from './tickmark-crypto.js';

const element = document.getElementById('key-records');

if (element) {
  const records = new Map(JSON.parse(element.textContent).keys.map((key) => [key.id, key.wrapped]));

  for (const form of document.querySelectorAll('form.passphrase')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('.status');
      const keyId = form.dataset.keyId;
      const [oldField, freshField, againField] = ['old', 'fresh', 'again'].map((name) => form.querySelector(`[name=${name}]`));
      const fresh = freshField.value;

      if (fresh.normalize('NFC').length < MIN_PASSPHRASE) {
        status.textContent = `Use at least ${MIN_PASSPHRASE} characters.`;
        return;
      }
      if (fresh !== againField.value) {
        status.textContent = 'Those two are not the same.';
        return;
      }

      try {
        status.textContent = 'Unwrapping the key…';
        const wrapped = await rewrapPrivateKey(records.get(keyId), oldField.value, fresh);

        status.textContent = 'Saving…';
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ wrapped_private_key: wrapped }),
        });

        if (response.ok) {
          location.href = '/keys';
          return;
        }
        const page = await response.text();
        status.textContent = page.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      } catch (error) {
        // Including "that passphrase does not open this key", which is the one the practice is most
        // likely to see and the one that means nothing has changed.
        status.textContent = error.message;
      }
    });
  }
}
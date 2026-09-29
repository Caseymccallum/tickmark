/**
 * The recovery sheet, both halves of it.
 *
 * "Make a sheet" takes the current key and the passphrase that opens it, seals the same key under a
 * fresh secret the browser just made, saves that copy, and puts the secret on screen **once** to
 * print. The secret is never sent anywhere — which is precisely why the saved copy opens nothing to
 * anyone who has taken the database.
 *
 * "Recover" is the same operation backwards: the printed secret opens the saved copy, which is then
 * sealed under a new passphrase. It is the same key, so every file the practice has ever sent still
 * opens; nothing is re-encrypted and no colleague's copy is touched.
 */
import { MIN_PASSPHRASE, newRecoverySecret, rewrapPrivateKey } from './tickmark-crypto.js';

const keyRecords = document.getElementById('key-records');
const recoveryRecord = document.getElementById('recovery-record');

const recordData = keyRecords ? JSON.parse(keyRecords.textContent) : { keys: [], currentKeyId: null };
const keys = new Map(recordData.keys.map((key) => [key.id, key.wrapped]));
const currentKeyId = recordData.currentKeyId;
const sheet = recoveryRecord ? JSON.parse(recoveryRecord.textContent) : null;

// --- make a recovery sheet ------------------------------------------------------------------
for (const form of document.querySelectorAll('form.recovery-sheet')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('.status');
    const passphrase = form.querySelector('[name=passphrase]').value;

    try {
      status.textContent = 'Sealing a copy\u2026';
      const secret = newRecoverySecret();
      const wrapped = await rewrapPrivateKey(keys.get(currentKeyId), passphrase, secret);

      status.textContent = 'Saving\u2026';
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ recovery_wrapping: wrapped }),
      });
      if (!response.ok) {
        status.textContent = await problemFrom(response);
        return;
      }

      showSheet(secret);
    } catch (error) {
      // Most often "that passphrase does not open this key" — nothing has changed.
      status.textContent = error.message;
    }
  });
}

// --- recover from a recovery sheet -----------------------------------------------------------
for (const form of document.querySelectorAll('form.recover')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('.status');
    const [secretField, freshField, againField] = ['secret', 'fresh', 'again'].map((name) => form.querySelector(`[name=${name}]`));
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
      status.textContent = 'Opening the sheet\u2026';
      const wrapped = await rewrapPrivateKey(sheet.wrapped, secretField.value.trim(), fresh);

      status.textContent = 'Saving\u2026';
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ wrapped_private_key: wrapped }),
      });
      if (response.ok) {
        location.href = '/keys?recovered=1';
        return;
      }
      status.textContent = await problemFrom(response);
    } catch (error) {
      // The usual one: "that secret does not open this sheet" — mistyped, or not this practice's.
      status.textContent = error.message;
    }
  });
}

async function problemFrom(response) {
  const page = await response.text();
  return page.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Put the secret on screen once, to print and keep. It is never stored and never sent. */
function showSheet(secret) {
  const sheetEl = document.getElementById('recovery-sheet');
  if (!sheetEl) return;
  sheetEl.querySelector('.secret').textContent = secret;
  sheetEl.hidden = false;
  sheetEl.querySelector('.print').addEventListener('click', () => window.print());
  sheetEl.scrollIntoView();
}
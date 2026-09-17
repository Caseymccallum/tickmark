/**
 * The practice's side of the download: unlock the key once, then open files in the page.
 *
 * Before this existed, opening what a client sent meant the command line tool. That is the last
 * place the product required a terminal, and this is the replacement for it.
 *
 * ## What happens here, in order
 *
 * 1. The passphrase is typed into a field on this page and never leaves it. It is used to unwrap the
 *    private key, which is then held **in a variable in this tab** so that saving three files does
 *    not mean paying for PBKDF2 three times — 600,000 rounds is about a second, which is the point.
 * 2. Saving a file fetches the **envelope** — ciphertext — from the server, opens it here, and hands
 *    the plaintext to the browser as a download.
 * 3. The plaintext exists in this tab's memory for as long as it takes to make the download, and
 *    nowhere else. It is never sent anywhere, and there is nothing on the server that could send it.
 *
 * The wrapped key is embedded in this page as JSON. That leaks nothing: the server already stores
 * it, and it is useless without the passphrase. It has to be here, or the decryption could not
 * happen in the browser at all, which would put the plaintext back on the server.
 */
import { decryptEnvelope, unwrapPracticeKey } from './tickmark-crypto.js';

const keyElement = document.getElementById('wrapped-key');
const passphraseField = document.getElementById('passphrase');
const unlockButton = document.getElementById('unlock');
const unlockStatus = document.getElementById('unlock-status');

/** The unwrapped private key, for this page only. Never stored, never sent. */
let privateKey = null;

const setStatus = (element, text) => {
  if (element) element.textContent = text;
};

/** Every save button, enabled only once there is a key to open files with. */
const saveButtons = () => [...document.querySelectorAll('button.save')];

function setUnlocked(unlocked) {
  for (const button of saveButtons()) button.disabled = !unlocked;
  if (passphraseField) passphraseField.disabled = unlocked;
  if (unlockButton) unlockButton.disabled = unlocked;
}

async function unlock() {
  const passphrase = passphraseField?.value ?? '';
  if (passphrase.length === 0) {
    setStatus(unlockStatus, 'Type your passphrase first.');
    return false;
  }
  setStatus(unlockStatus, 'Unwrapping your key…');
  try {
    privateKey = await unwrapPracticeKey(JSON.parse(keyElement.textContent).wrapped, passphrase);
    // Cleared from the field as soon as it has been used, so it is not sitting on screen for the
    // rest of the session.
    passphraseField.value = '';
    setUnlocked(true);
    setStatus(unlockStatus, 'Key unlocked for this tab. You can save files now.');
    return true;
  } catch {
    privateKey = null;
    setUnlocked(false);
    setStatus(unlockStatus, 'That passphrase does not open this key.');
    return false;
  }
}

if (keyElement) {
  setUnlocked(false);

  unlockButton?.addEventListener('click', unlock);
  passphraseField?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      unlock();
    }
  });

  for (const button of saveButtons()) {
    button.addEventListener('click', async () => {
      const status = button.parentElement.querySelector('.status');
      if (!privateKey && !(await unlock())) return;

      const name = button.dataset.name;
      try {
        setStatus(status, `Fetching ${name}…`);
        const response = await fetch(button.dataset.url);
        if (!response.ok) {
          setStatus(status, `The server refused that: ${response.status}`);
          return;
        }
        const envelope = new Uint8Array(await response.arrayBuffer());

        setStatus(status, `Opening ${name}…`);
        const plaintext = await decryptEnvelope(privateKey, envelope);

        // The plaintext goes straight to a download and is not rendered. Putting it on the page
        // would mean a client's bank statement as DOM, in a tab that also runs whatever else the
        // practice has open.
        const url = URL.createObjectURL(new Blob([plaintext], { type: 'application/octet-stream' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name || 'document';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // Revoking immediately can cancel the download in some browsers, so it waits.
        setTimeout(() => URL.revokeObjectURL(url), 60000);

        setStatus(status, `Saved ${name} (${plaintext.length} bytes).`);
      } catch (error) {
        setStatus(status, `That file could not be opened: ${error.message}`);
      }
    });
  }
}
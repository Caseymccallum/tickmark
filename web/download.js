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
import { decryptWithKeys, unwrapPracticeKey } from './tickmark-crypto.js';
import { zip } from './zip.js';

const keyElement = document.getElementById('key-records');
const passphraseField = document.getElementById('passphrase');
const unlockButton = document.getElementById('unlock');
const unlockStatus = document.getElementById('unlock-status');
// "Download everything": the same key and the same envelopes, but every file packed into one archive.
// It reads its list from `#file-list` — the names the request page already worked out — so it deals
// only in bytes and never invents a name.
const downloadAllButton = document.getElementById('download-all');
const downloadAllStatus = document.getElementById('download-all-status');
const fileListElement = document.getElementById('file-list');

/** The unwrapped private keys, for this page only. Never stored, never sent. */
let privateKeys = [];

const setStatus = (element, text) => {
  if (element) element.textContent = text;
};

/** Every save button, enabled only once there is a key to open files with. */
const saveButtons = () => [...document.querySelectorAll('button.save')];

function setUnlocked(unlocked) {
  for (const button of saveButtons()) button.disabled = !unlocked;
  if (downloadAllButton) downloadAllButton.disabled = !unlocked;
  if (passphraseField) passphraseField.disabled = unlocked;
  if (unlockButton) unlockButton.disabled = unlocked;
}

async function unlock() {
  const passphrase = passphraseField?.value ?? '';
  if (passphrase.length === 0) {
    setStatus(unlockStatus, 'Type your passphrase first.');
    return false;
  }

  const records = JSON.parse(keyElement.textContent).keys;
  setStatus(unlockStatus, `Unwrapping ${records.length === 1 ? 'your key' : `${records.length} keys`}…`);

  // One passphrase, and it may not open every key: a practice that rotated and chose a new
  // passphrase at the same time has keys sealed differently, and the ones that do not open are
  // skipped rather than treated as a failure. What matters is how many opened, and the page says.
  const opened = [];
  for (const record of records) {
    try {
      opened.push(await unwrapPracticeKey(record.wrapped, passphrase));
    } catch {
      // Not this passphrase, for this key.
    }
  }

  passphraseField.value = '';
  if (opened.length === 0) {
    privateKeys = [];
    setUnlocked(false);
    setStatus(unlockStatus, 'That passphrase does not open any of this practice\'s keys.');
    return false;
  }

  privateKeys = opened;
  setUnlocked(true);
  setStatus(
    unlockStatus,
    opened.length === records.length
      ? 'Key unlocked for this tab. You can save files now.'
      : `${opened.length} of ${records.length} keys unlocked. Files sent under the others will not open with this passphrase.`,
  );
  return true;
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
      if (privateKeys.length === 0 && !(await unlock())) return;

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
        const plaintext = await decryptWithKeys(privateKeys, envelope);

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

/**
 * "Download everything": open each envelope here and pack the documents into one archive.
 *
 * The plaintext of every file exists in this tab for exactly as long as it takes to build the zip,
 * and never anywhere else — the archive is assembled from bytes already in memory and handed to the
 * browser as one download. There is no request that could carry a document, and no server step that
 * could see one: what is fetched is ciphertext and what is saved is the practice's own, opened here.
 */
if (downloadAllButton && fileListElement) {
  downloadAllButton.addEventListener('click', async () => {
    if (privateKeys.length === 0 && !(await unlock())) return;

    const { archive, files } = JSON.parse(fileListElement.textContent);
    if (!Array.isArray(files) || files.length === 0) {
      setStatus(downloadAllStatus, 'There is nothing here to save yet.');
      return;
    }

    try {
      const entries = [];
      let step = 0;
      for (const file of files) {
        step += 1;
        setStatus(downloadAllStatus, `Opening ${step} of ${files.length} — ${file.name.split('/').pop()}…`);
        const response = await fetch(file.url);
        if (!response.ok) throw new Error(`the server refused ${file.name} (${response.status})`);
        const envelope = new Uint8Array(await response.arrayBuffer());
        entries.push({ name: file.name, bytes: await decryptWithKeys(privateKeys, envelope) });
      }

      setStatus(downloadAllStatus, `Packing ${entries.length} ${entries.length === 1 ? 'file' : 'files'}…`);
      const packed = zip(entries);

      // One download for the whole request, under the name the request page chose.
      const url = URL.createObjectURL(new Blob([packed], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = archive || 'documents.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      setStatus(downloadAllStatus, `Saved ${archive} — ${entries.length} ${entries.length === 1 ? 'file' : 'files'}.`);
    } catch (error) {
      // The usual one is "none of this practice's keys opens that file": the passphrase unlocked the
      // keys but one document was sealed to a key it does not include. Nothing is packed and saved as
      // a half-archive — that would be a file that quietly lost a document.
      setStatus(downloadAllStatus, `Nothing was packed: ${error.message}`);
    }
  });
}
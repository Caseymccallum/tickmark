/**
 * Moving a practice's files onto its current key, in the browser.
 *
 * This is the only operation in the product that rewrites a stored document, and it is the reason an old
 * key can ever be retired: a key that opens nothing can be destroyed, and one that opens three files
 * cannot. The server cannot do it — it has no private key, and giving it one would make the product's
 * central claim false — so the work happens here, and the server only ever handles bytes it cannot read.
 *
 * Three properties, and each of them is the answer to a way this could go wrong:
 *
 * 1. **The loop asks the server what is left, every time round.** It does not walk a list it fetched at
 *    the start. That is what makes closing the tab harmless: the files already moved have stopped being
 *    sealed to the old key, so the server's answer *is* the progress, and there is no cursor here that can
 *    fall out of step with the files.
 * 2. **The round trip is checked before anything is replaced** — the new envelope is opened again and
 *    compared with the original plaintext. That check needs the *current* key's private half, not the old
 *    one: the first version of this file opened the re-sealed envelope with the old key, so the check failed
 *    on every file and the pass could never complete. A bug in re-sealing would otherwise quietly replace a
 *    document with rubbish, and the server — which can read neither version — would never know.
 * 3. **A failure stops the run and says where.** One unreadable file must not leave the rest half-moved and
 *    unexplained, and pressing the button again carries on from what is left.
 */
import { decryptEnvelope, encryptFile, unwrapPracticeKey } from './tickmark-crypto.js';

const element = document.getElementById('key-records');

if (element) {
  const records = JSON.parse(element.textContent);
  const record = new Map(records.keys.map((key) => [key.id, key]));

  /** Same length, same bytes. */
  const identical = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);

  /** The sentence inside a refusal page, which is where the server's reason lives. */
  const words = (text) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

  for (const form of document.querySelectorAll('form.reencrypt')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('.status');
      const bar = form.querySelector('progress');
      const keyId = form.dataset.keyId;
      const passphrase = form.querySelector('[name=passphrase]').value;
      const alsoTyped = form.querySelector('[name=current_passphrase]').value;

      let privateKey;
      let currentPrivateKey;
      try {
        status.textContent = 'Opening the keys…';
        privateKey = await unwrapPracticeKey(record.get(keyId).wrapped, passphrase);
      } catch (error) {
        status.textContent = error.message;
        return;
      }

      // The check below needs the current key open too. A practice usually seals every key under one
      // passphrase, so the same one is tried first; only if that fails is the second box needed. When neither
      // opens it, the pass stops rather than re-sealing files the person could not read afterwards.
      try {
        currentPrivateKey = await unwrapPracticeKey(record.get(records.currentKeyId).wrapped, passphrase);
      } catch {
        if (!alsoTyped) {
          status.textContent = 'That passphrase does not open the current key, so the result cannot be checked before the files are replaced. Type the current key\'s passphrase in the second box.';
          return;
        }
        try {
          currentPrivateKey = await unwrapPracticeKey(record.get(records.currentKeyId).wrapped, alsoTyped);
        } catch (error) {
          status.textContent = `That does not open the current key either (${error.message}). Without it a re-sealed file could not be read back, so nothing was changed.`;
          return;
        }
      }

      let moved = 0;
      try {
        for (;;) {
          const listed = await fetch(`/keys/${keyId}/pending`);
          if (!listed.ok) throw new Error(words(await listed.text()));

          const { files } = await listed.json();
          if (files.length === 0) break;

          const file = files[0];
          status.textContent = `Moving ${file.filename}…`;

          const envelope = new Uint8Array(await (await fetch(file.url)).arrayBuffer());
          const plaintext = await decryptEnvelope(privateKey, envelope);
          const resealed = await encryptFile(records.currentPublicKey, plaintext);

          // Opened with the *current* key, because that is the key the new envelope was sealed to. Doing this
          // is the one test that catches a broken re-seal, and only this browser can do it.
          const roundTrip = await decryptEnvelope(currentPrivateKey, resealed);
          if (!identical(roundTrip, plaintext)) {
            throw new Error('the re-sealed copy did not open back to the same document, so nothing was replaced');
          }

          const posted = await fetch(`/files/${file.id}/reencrypt`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-key-id': records.currentKeyId },
            body: resealed,
          });
          if (!posted.ok) throw new Error(words(await posted.text()));

          moved += 1;
          if (bar) bar.value = moved;
        }
      } catch (error) {
        status.textContent = `Stopped after ${moved} ${moved === 1 ? 'file' : 'files'}: ${error.message}. Nothing was lost — press the button again to carry on.`;
        return;
      }

      // Reloaded rather than reported: the counts on the page are the server's, and after moving everything
      // the key's row should show none — with the retire button where the move button used to be.
      status.textContent = moved === 0 ? 'Nothing was left on that key.' : `Moved ${moved}. Reloading…`;
      if (moved > 0) location.href = '/keys';
    });
  }
}
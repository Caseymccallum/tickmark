# What is encrypted, and what is not

This is the document the product's central claim rests on. If anything in it is wrong the claim is
wrong, so it states the limits as carefully as the guarantees.

## The claim

**A client's document is encrypted in the client's browser, to the practice's key, before it
leaves their machine. The server — including whoever runs it — stores bytes it cannot read.**

That is checked rather than asserted. The test suite uploads a document through the real HTTP
endpoint, reads the file back off disk, requires the *document itself* not to appear in it, and
then opens it with nothing but the passphrase. The end-to-end probe does the same against a
running server process, and the operator's own tool opens the result afterwards.

## The keys

| | |
| --- | --- |
| Curve | ECDH P-256 |
| Where the pair is made | **In the browser.** If the server made it, the server could use it |
| The public half | Stored as a JWK. It is public; the client page carries it |
| The private half | Exported as PKCS#8, wrapped under a passphrase, and only then stored |
| The passphrase | Never sent anywhere. It is typed into a page that makes a key and posts a blob |

The wrapped private key is a self-describing record:

```
pbkdf2$sha-256$<iterations>$<salt, base64url>$<iv, base64url>$<ciphertext, base64url>
```

Six fields, parameters included, so the iteration count can be raised later without invalidating
keys made today. 600,000 rounds of PBKDF2-SHA-256 is what this version writes.

**There is no verification token.** A record that could answer "is this the right passphrase?"
would be a known plaintext encrypted under the passphrase-derived key, sitting in the database — a
free offline test for anyone who took it. The only oracle here is AES-GCM's authentication tag on
the wrapped key, which cannot be removed and is not made cheaper by a stored copy. This is the
specific finding from an independent audit of the author's earlier encrypted-forms project, and it
is why this format looks the way it does.

## The envelope

What the server stores, and the only thing it ever sees:

```
0   4    magic, "TKME"
4   1    envelope version, 1
5   1    curve, 1 = P-256 (uncompressed point)
6   65   ephemeral public key
71  12   AES-GCM initialisation vector
83  ..   ciphertext, with the 16-byte GCM tag appended
```

The whole 83-byte header is passed to AES-GCM as additional authenticated data. Changing one byte
of it — including substituting an attacker's ephemeral key to re-key a file they cannot read —
makes decryption fail rather than succeed with the wrong key. Both are tested.

The file key is HKDF-SHA-256 over the ECDH shared secret, salted with the ephemeral public key so
the derived key is bound to the envelope it belongs to, with the info string
`tickmark/v1/file-encryption`.

The server checks the magic and the version and refuses anything that fails. That is how a
*plaintext* upload is rejected: the server will not store a document it could read and then call it
encrypted.

## Rotating a key

A practice can make a new key at any time from `Keys → Make a new key`. What that does, exactly:

- New uploads are encrypted to the **newest** key: the client's page is handed it.
- **Every older key is kept.** This is not tidiness, it is the whole design. Each file already
  stored is encrypted to the key that was current when it arrived, and ECDH offers no way to move an
  envelope to a new key without the old private key. Deleting an old key would make every document
  its clients had sent unopenable, so the product does not offer a way to delete one.
- **The keys page counts what each key is holding.** An upload records which practice key sealed it —
  the browser says so in a header, because nothing about an envelope's bytes identifies its recipient,
  and the server checks that the key belongs to the practice before recording it. That count is what
  makes "can this key be discarded?" a question with an answer instead of a policy of keeping everything
  forever. Files that arrived before this record existed are counted as **not known**, which is a
  different thing from zero: a key shown as holding nothing would be a key somebody might delete.
- Opening a file tries each key the practice holds, newest first. This is safe because AES-GCM's
  authentication tag means a wrong key *fails* rather than returning something plausible — and it is
  why rotation needed no change to the file format, which matters: a format change would make every
  file written before it a special case.

**What rotation is for, and what it is not for.** It changes what happens to the *next* file. That
makes it the right response to a key being lost or exposed, and a reasonable thing to do
periodically. It is **not an undo**: it cannot un-disclose anything already taken. If someone has a
copy of an old key and a copy of the files encrypted to it, a new key changes nothing about those
files. No design can fix that, and a product that implied otherwise would be lying.

The page says all of this where the practice will read it, including the sentence that matters most:
a new key does not re-encrypt anything.

- **A key can be retired, because its files can be moved.** The pass runs in the browser — the private key
  only ever exists there — and it fetches each file sealed to the old key, opens it, re-seals it to the
  current key, checks the round trip, and replaces the stored envelope. A file that has been moved is no
  longer sealed to the old key, so the count on the keys page *is* the progress and closing the page
  halfway through loses nothing. Retiring then destroys the wrapped copies and keeps the row as a record.
- **Retiring a key reaches further than this server.** Any copy of a file still on the old key that a
  practice kept or backed up becomes unopenable once the key is gone, which is why the page says so and why
  the word has to be typed rather than a button pressed. Move everything first, then retire.

## Changing a passphrase

`Keys` offers this per key, and it is a much smaller operation than rotation: the key is unwrapped
with the old passphrase and sealed again with the new one, so **the key itself does not change** and
nothing has to be re-encrypted. Every file stays readable and no stored document is touched.

Two consequences worth knowing:

- A practice that rotates *and* chooses a new passphrase at the same time ends up with keys sealed
  under different passphrases. The unlock step tries the given passphrase against each key and reports
  how many opened — *"2 of 3 keys unlocked"* — rather than failing, because which files are reachable
  with which passphrase is the useful information.
- Losing a passphrase is still unrecoverable. A copy of a key without its passphrase is a file nobody
  can open, and that is the same property as the guarantee seen from the other side.

## Giving the key to a second person

A practice has one key, and a member added later needs a copy of it. That is the only operation in
Tickmark that moves private key material, so it is worth being precise about what travels.

**An invitation is a sealed copy plus a secret, kept apart.** The inviting member's browser takes the
practice's private key — unwrapped with *their* passphrase — and seals it under a fresh random secret.
Only the sealed copy is sent to the server. The secret goes in the link's **fragment**: the part after
`#`, which browsers do not send in a request. So the server stores something it cannot read, in the same
way it stores a client's documents, and the link is the only thing that can open it.

The new member's browser reads the secret from the fragment, opens the sealed copy, and re-seals **the
same key** under their own passphrase. It sends only that. The result is one row per member per key:

```
practice_key
  └── key_wrapping   one per member: the same key, sealed under their own passphrase
```

Three things follow, and each is the kind of thing that should be read before relying on it:

- **Whoever opens the link gets the key.** It is not addressed to a person. Anyone who has it before the
  intended member does, and accepts it, is a member. The page says so above the form rather than in a
  footnote, and that is the honest cost of not requiring a directory to exist before someone can join.
- **The server keeps the sealed copy and every member's sealed copy, for as long as the rows exist.** It
  cannot open any of them, which is the point — but "the server cannot read it" is not the same as "it is
  not there", and a backup holds them all.
- **Inviting someone does not rotate anything.** The key is the same key it was, so documents that
  arrived before the new member existed open for them. That is the whole reason a firm can add a partner
  mid-season, and it is the property `test/invite-flow.test.js` proves end to end.

A practice with two members has two passphrases, and either one opens the documents. A member who
changes their passphrase changes only their own sealed copy: their colleague's is untouched, and neither
can derive the other's.

## The threat model

**Protected:**

- The operator of the server, reading a client's documents.
- A compromise of the server — the disk, a backup, a database dump — yielding ciphertext and a
  *passphrase-wrapped* private key rather than anything readable.
- Anyone who obtains an envelope file on its own.
- Modification of a stored envelope: any change is detected on opening, not silently decrypted.

**Not protected, and these are not oversights:**

- **A weak passphrase.** Nothing in the file can stop offline guessing; the only defence is the
  cost of one attempt. 600,000 PBKDF2-SHA-256 rounds is a deliberate choice, and a passphrase below
  twelve characters is refused at the point the key is made.
- **The metadata.** The server sees which client, which request, which item, the filename, the size
  of the envelope, and when it arrived. It has to: that is the workflow. The client page says so in
  as many words — *name files the way you would name an envelope, not the way you would name a
  letter.*
- **A practice who loses the passphrase.** Nothing can recover it and nothing can reset it. The
  files stay on disk, unreadable, forever. That is the same property as the guarantee, seen from
  the other side.
- **A compromised browser.** Malicious script on the page — from the operator, an extension, or a
  hijacked dependency — can read the file before it is encrypted, and can read it again when the
  practice opens it. The claim is about the *server*, not about either machine's browser.
- **The identity of the uploader.** Anyone holding the link can send a file. Encryption says
  nothing about who is holding the other end of it.
- **An invitation link that reaches the wrong person.** Anyone who opens it first gets a sealed copy of
  the practice's key and becomes a member. It works once and expires, which bounds the window rather
  than removing the risk, and there is no way to make it selective without requiring the invited person
  to already be known to the server — which is the thing the link exists to avoid.
- **Envelopes addressed to the wrong key.** The server cannot tell which practice an envelope was
  encrypted to, because telling would require the ability to open it. A file encrypted to the wrong
  key would be stored and would then be unopenable. Through the product this cannot happen: the key
  the browser uses comes from the link, and a link belongs to exactly one practice. It is recorded
  here because "cannot happen by design" is weaker than "cannot happen", and the difference should
  be visible rather than implied.

## Why PBKDF2

Web Crypto offers PBKDF2 and does not offer scrypt or Argon2. The alternative was to ship a
JavaScript implementation of a better KDF, which would be a second cryptography implementation to
be wrong, running in the environment least able to afford it. 600,000 rounds of PBKDF2-SHA-256 is
the strongest thing the platform provides, and the count travels with each key so that a browser
which later offers something better can be used without a migration.

## How a practice opens a file

**In the browser, on the request page.** The page carries the practice's *wrapped* private keys, which
leak nothing — the server already stores them, and they are useless without the passphrase. The
practice types the passphrase into a field on that page, the keys are unwrapped there, and they are
kept in a variable in that tab so that saving three files does not mean paying for 600,000 rounds of
PBKDF2 three times. Saving a file fetches the envelope, opens it in the tab, and hands the plaintext
to the browser as a download.

Three consequences worth stating rather than leaving to be discovered:

- The passphrase is cleared from the field as soon as it has been used, and is never sent anywhere.
  It cannot be: nothing in that page transmits it.
- The plaintext exists in the tab's memory for as long as it takes to start the download, and is
  **not rendered on the page**. A client's bank statement as DOM, in a tab that also runs whatever
  else the practice has open, would be a worse idea than it sounds.
- Reloading the page locks the key again. That is deliberate: the alternative is a passphrase or a
  key surviving a reload in storage, which is a thing to steal.

There is also a command line tool, which imports the *same* cryptography module — so an envelope one
of them cannot open is one bug rather than a disagreement between two implementations:

```
node tools/decrypt.mjs <data-directory> --list
node tools/decrypt.mjs <data-directory> <upload-id> -o statement.pdf
```

The passphrase comes from `TICKMARK_PASSPHRASE` or `--passphrase-file`, and never from the command
line, where the shell would keep it in history. The tool is for scripting, and for a server with no
browser in front of it.
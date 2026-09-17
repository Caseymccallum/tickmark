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
  hijacked dependency — can read the file before it is encrypted. The claim is about the *server*,
  not about the client's machine.
- **The identity of the uploader.** Anyone holding the link can send a file. Encryption says
  nothing about who is holding the other end of it.
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

## How a practice opens a file today

There is no browser-side download yet. Until there is, the operator's tool does it:

```
node tools/decrypt.mjs <data-directory> --list
node tools/decrypt.mjs <data-directory> <upload-id> -o statement.pdf
```

The passphrase comes from `TICKMARK_PASSPHRASE` or `--passphrase-file`, and never from the command
line, where the shell would keep it in history. The tool imports the *same* cryptography module the
browser loads, so an envelope it cannot open is one bug rather than a disagreement between two
implementations.

That tool is a bridge and is labelled as one. The next piece of work is decryption in the page.
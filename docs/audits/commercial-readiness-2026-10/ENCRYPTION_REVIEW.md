# Encryption and key lifecycle

## Path

Browser creates P-256 ECDH practice keypair. Public JWK is stored/readable; private PKCS#8 bytes are wrapped with a passphrase-derived AES-256-GCM key using PBKDF2-SHA-256 (600,000 iterations and random salt). For each file, client browser creates ephemeral P-256 ECDH keypair, derives a shared secret and HKDF-SHA-256 file key, encrypts with AES-256-GCM and random 96-bit IV. The 83-byte envelope header is authenticated as additional data. Server accepts known envelope format, stores ciphertext and metadata, and never receives passphrase/private key.

Staff unwrap key copies locally and decrypt downloaded file in browser memory; plaintext is offered as download, not rendered. Old keys remain until files are re-encrypted in browser. Recovery sheet stores key under separately printed secret. Member invite seals a key copy to a fresh secret in URL fragment; fragment is not sent to server.

## Assessment

These are established primitives with authenticated encryption, format versioning and tests for round-trip/tampering/wrong passphrase. No cryptographic defect confirmed in this source review. The server cannot validate the actual recipient key from opaque envelope; it validates a browser-provided key ID against request practice.

“Server cannot decrypt” is conditional on client receiving intended code. Operator controlling origin can serve JS that captures plaintext/passphrases. Also not protected: weak passphrase offline guessing, endpoint/browser compromise, metadata disclosure, link forwarding, availability or malware. Any member holding key/passphrase can decrypt; removal cannot revoke files already copied.

Rotation changes future uploads; old data needs explicit re-encryption. Retiring destroys wrapped key copies; backups/exports still using retired key become unreadable. Backup during file move/DB update can produce a missing-path association; current docs say do not overlap rotation and backup. Losing passphrase and printed recovery secret is unrecoverable.

## Recommendation

Describe as browser-side encrypted delivery, ciphertext held by server, with visible metadata and explicit origin/device limits. Do not claim independent certification or unqualified zero knowledge/bank-grade security. Commission external review before public launch covering protocol, wrapper/KDF, nonce/randomness, invitation fragment, secret lifetime, key ID binding, rotation/recovery and malicious-origin limits.
